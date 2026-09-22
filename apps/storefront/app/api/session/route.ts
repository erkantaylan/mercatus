/**
 * `POST /api/session` -- the shopper signs in. `DELETE /api/session` -- the shopper signs out.
 *
 * This is the whole of "a shopper signs in ONCE" (README Q20). The token it mints is tenant-less,
 * so the cookie it writes is good at every store this storefront serves: a pooled deployment
 * carries one session across `/t/acme` and `/t/borg`, and the store API still scopes every read by
 * route-tenant AND token-subject (BI2).
 *
 * A dedicated instance is a different origin on a different server, so its shopper signs in there
 * too -- with the same identity, minted by that store. That is the designed seam: the store issues
 * its own session, which is why an already-signed-in shopper keeps buying while our control plane
 * is down (Q20, CG1).
 */
import { z } from 'zod';

import { clearedSessionCookies, mintShopperToken, sessionCookies } from '@/lib/session';

const bodySchema = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, 'A phone number in E.164 form.'),
  name: z.string().max(120).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'Bad request.',
        },
      },
      { status: 400 },
    );
  }
  const { phone, name } = parsed.data;

  let token: string;
  try {
    token = await mintShopperToken(phone);
  } catch {
    return Response.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Could not start a shopper session.' } },
      { status: 502 },
    );
  }

  const session = { phone, name: name === undefined || name === '' ? null : name };
  const response = Response.json({ phone: session.phone, name: session.name });
  for (const cookie of sessionCookies(token, session)) response.headers.append('set-cookie', cookie);
  return response;
}

export function DELETE(): Response {
  const response = Response.json({ signedOut: true });
  for (const cookie of clearedSessionCookies()) response.headers.append('set-cookie', cookie);
  return response;
}
