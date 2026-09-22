/**
 * Order confirmation.
 *
 * Read with the shopper's own token: `GET /t/:slug/orders/:id` answers 404, never 403, for
 * someone else's order, so "not yours" and "not there" are indistinguishable from outside (S1).
 * The tenant comes from the route and the subject from the token, and the store API applies both
 * (BI2) -- this page does not, and must not, pass a tenant id of its own.
 *
 * The order number is per-tenant and gapless (BG2): acme's first order is 1 and so is borg's.
 */
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { OrderSettled } from '@/components/OrderSettled';
import { getOrder, StoreApiError } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { readShopperToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function OrderPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;

  const token = await readShopperToken();
  if (!token) redirect(`/t/${slug}`);

  const order = await getOrder(slug, token, id).catch((error: unknown) => {
    if (error instanceof StoreApiError && (error.status === 404 || error.status === 401)) notFound();
    throw error;
  });

  return (
    <>
      <div className="sf-page-header">
        <h1>Order #{order.number}</h1>
        <p className="sf-muted">
          Placed {new Date(order.placedAt).toLocaleString()} · status{' '}
          <span className="sf-status">{order.status}</span>
        </p>
      </div>

      {/* Clears the basket and the pending marker, and polls the bank until it has answered. */}
      <OrderSettled slug={slug} orderId={order.id} />

      <table className="sf-table" style={{ marginTop: 'var(--mc-space-4)' }}>
        <thead>
          <tr>
            <th>Product</th>
            <th className="sf-num">Unit</th>
            <th className="sf-num">Qty</th>
            <th className="sf-num">Line</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((line) => (
            <tr key={line.id}>
              {/* The title as it was when the order was placed, not as it is now. */}
              <td>{line.titleSnapshot}</td>
              <td className="sf-num">{formatMoney(line.unitPriceMinor, order.currency)}</td>
              <td className="sf-num">{line.qty}</td>
              <td className="sf-num">
                {formatMoney(line.unitPriceMinor * line.qty, order.currency)}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong>
            </td>
            <td className="sf-num">
              <strong>{formatMoney(order.totalMinor, order.currency)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="sf-row" style={{ marginTop: 'var(--mc-space-5)' }}>
        <Link className="sf-button sf-button-quiet" href={`/t/${slug}`}>
          Back to the catalog
        </Link>
        <Link className="sf-button sf-button-quiet" href={`/t/${slug}/orders`}>
          My orders
        </Link>
      </div>
    </>
  );
}
