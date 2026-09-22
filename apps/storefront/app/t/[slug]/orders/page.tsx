/**
 * This shopper's orders at this store.
 *
 * "This shopper" is the token's subject and "this store" is the route's slug, and the store API
 * applies both conditions to every row (BI2). A shopper who has never checked out here has no
 * token, so the page asks them to buy something rather than showing an empty table they might
 * read as "your orders are gone".
 */
import Link from 'next/link';

import { listOrders } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { readShopperToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function OrdersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const token = await readShopperToken();

  if (!token) {
    return (
      <>
        <div className="sf-page-header">
          <h1>Orders</h1>
        </div>
        <div className="sf-empty">
          You have not ordered from this store in this browser.{' '}
          <Link href={`/t/${slug}`}>Have a look at the catalog</Link>.
        </div>
      </>
    );
  }

  const { items, total } = await listOrders(slug, token);

  return (
    <>
      <div className="sf-page-header">
        <h1>Orders</h1>
        <p className="sf-muted">
          {total === 0 ? 'No orders yet.' : `${String(total)} orders at this store.`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="sf-empty">No orders yet.</div>
      ) : (
        <table className="sf-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Placed</th>
              <th>Status</th>
              <th className="sf-num">Total</th>
            </tr>
          </thead>
          <tbody>
            {items.map((order) => (
              <tr key={order.id}>
                <td>
                  <Link href={`/t/${slug}/order/${order.id}`}>#{order.number}</Link>
                </td>
                <td>{new Date(order.placedAt).toLocaleString()}</td>
                <td>
                  <span className="sf-status">{order.status}</span>
                </td>
                <td className="sf-num">{formatMoney(order.totalMinor, order.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
