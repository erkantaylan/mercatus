/**
 * `GET /api/payments/:orderId` -- what the confirmation page polls while the bank makes up its
 * mind. `source` is part of the answer on purpose: `callback` means a signature verified, `bank`
 * means this process asked and was told.
 */
import { paymentState } from '@/lib/payments';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  const { orderId } = await params;
  const state = await paymentState(orderId);
  if (!state) {
    // No payment was ever created for this order in this process. Say so plainly -- the order id
    // is already the caller's, so there is nothing to protect here.
    return Response.json({ outcome: 'unknown', source: 'none' });
  }
  return Response.json(state);
}
