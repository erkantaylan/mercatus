/**
 * `POST /api/payments/callback` -- fake-bank tells the storefront what it did.
 *
 * The signature is verified before the body is believed (CR1). That is not ceremony on a laptop:
 * the bank's `bad-hash` behaviour exists precisely so this path can be seen refusing a callback
 * that is otherwise perfectly well-formed, and a hashing bug is then a 401 here instead of a
 * mystery against a real provider.
 *
 * One generic answer for every rejection, with the real reason logged (S1): a callback that says
 * "no such payment" tells an unauthenticated caller which references exist.
 */
import { z } from 'zod';

import { recordCallback } from '@/lib/payments';

/**
 * fake-bank's callback body. Declared here rather than imported from @mercatus/contracts, which
 * this app takes types from but cannot import at runtime (see lib/api.ts). Five fields; the
 * signature is what makes it trustworthy, not the schema.
 */
const paymentCallbackBodySchema = z.object({
  providerRef: z.string().min(1),
  status: z.enum(['created', 'paid', 'declined']),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  signature: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = paymentCallbackBodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { code: 'VALIDATION_FAILED', message: 'Bad callback.' } }, { status: 400 });
  }

  const result = recordCallback(parsed.data);
  if (!result.accepted) {
    console.warn(
      `[storefront] refused a bank callback for ${parsed.data.providerRef}: ${result.reason ?? 'unknown'}`,
    );
    return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Refused.' } }, { status: 401 });
  }

  // 204: the bank is not interested in a body, and an empty 2xx is what marks it delivered.
  return new Response(null, { status: 204 });
}
