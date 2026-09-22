/**
 * `POST /api/checkout` -- the storefront's own endpoint, and the only place the two secrets live.
 *
 * It does three things the browser may not:
 *
 *   mints/uses the shopper's bearer token, which stays in an httpOnly cookie (BI2: the store API
 *     takes the tenant from the route and the subject from this token, and applies both)
 *   places the order on the store API, which prices it from its own products table
 *   asks fake-bank for a payment, signed with the shared HMAC (CR1)
 *
 * It answers `{ orderId, number, paymentUrl }` rather than redirecting, because the caller needs
 * the order id to find its way back from the bank. The redirect itself is one line in the client.
 *
 * Errors are passed through in the store API's own envelope, code and all: the difference between
 * LICENCE_PASSIVE (the merchant did not pay us) and INSUFFICIENT_STOCK (the shopper wants more
 * than exists) is exactly what the form needs to say something useful (CG3).
 */
import type { CheckoutResult } from '@mercatus/contracts';
import { z } from 'zod';

import { checkout, StoreApiError } from '@/lib/api';
import { createPayment, recordUnreachable } from '@/lib/payments';
import {
  mintShopperToken,
  readShopperSession,
  readShopperToken,
  sessionCookies,
} from '@/lib/session';

const bodySchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
    .max(63),
  // Optional, because a shopper who signed in already HAS an identity: the session's token is the
  // subject and the session's phone is the contact detail. A phone here is a sign-in and a
  // checkout in one request, which is what a guest does.
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'A phone number in E.164 form.').optional(),
  name: z.string().max(120).optional(),
  lines: z.array(z.object({ productId: z.uuid(), qty: z.number().int().positive() })).min(1),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: { code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Bad request.' } },
      { status: 400 },
    );
  }
  const { slug, lines } = parsed.data;

  // The session comes first: a shopper who signed in buys as themselves, at every store this
  // process serves, without being asked who they are again (Q20). A posted phone signs a guest in
  // on the spot, which is the same two calls in one request.
  const existing = await readShopperSession();
  const existingToken = await readShopperToken();
  const phone = parsed.data.phone ?? existing?.phone;
  const name = parsed.data.name ?? existing?.name ?? undefined;

  if (phone === undefined) {
    return Response.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Sign in before checking out.' } },
      { status: 401 },
    );
  }

  const reuse = existingToken !== undefined && parsed.data.phone === undefined;
  let token: string;
  if (reuse && existingToken !== undefined) {
    token = existingToken;
  } else {
    try {
      token = await mintShopperToken(phone);
    } catch {
      return Response.json(
        { error: { code: 'UNAUTHENTICATED', message: 'Could not start a shopper session.' } },
        { status: 502 },
      );
    }
  }

  let placed: CheckoutResult;
  try {
    placed = await checkout(slug, token, {
      lines,
      shopper: name === undefined || name === '' ? { phone } : { phone, name },
    });
  } catch (error) {
    if (error instanceof StoreApiError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    throw error;
  }

  let paymentUrl: string;
  try {
    ({ paymentUrl } = await createPayment({
      slug,
      orderId: placed.orderId,
      orderNumber: placed.number,
      amountMinor: placed.totalMinor,
      currency: placed.currency,
    }));
  } catch (error) {
    // The order exists and is unpaid. That is a real state -- `placed` -- and on a dedicated
    // instance it is the DESIGNED one while our control plane is unreachable: payments are ours
    // and never run on the merchant's server (CE2), so the shop keeps selling and the money is
    // collected afterwards (CG1). 202 rather than 502: nothing failed that the shopper can fix,
    // and the checkout is complete as far as this store is concerned.
    console.warn(
      `order ${String(placed.number)} placed, payment not started: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    const response = Response.json(
      {
        orderId: placed.orderId,
        number: placed.number,
        totalMinor: placed.totalMinor,
        currency: placed.currency,
        paymentUrl: null,
        payment: 'unreachable',
      },
      { status: 202 },
    );
    recordUnreachable({
      orderId: placed.orderId,
      slug,
      amountMinor: placed.totalMinor,
      currency: placed.currency,
    });
    for (const cookie of sessionCookies(token, { phone, name: name ?? null })) {
      response.headers.append('set-cookie', cookie);
    }
    return response;
  }

  const response = Response.json({
    orderId: placed.orderId,
    number: placed.number,
    totalMinor: placed.totalMinor,
    currency: placed.currency,
    paymentUrl,
  });
  for (const cookie of sessionCookies(token, { phone, name: name ?? null })) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}
