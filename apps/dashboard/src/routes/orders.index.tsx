/**
 * Orders, newest first. Staff see every order in their own store -- the subject condition that
 * scopes a shopper's own list (BI2) is deliberately NOT applied here, and the tenant still is.
 *
 * Order numbers are per-tenant and gapless (BG2): this table starts at 1 in every store, which is
 * the visible half of that rule.
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';

import { ApiError } from '../api/client.js';
import { Banner, Card, EmptyState, Money, PageHeader, Spinner, Table } from '../ui/index.js';

export const Route = createFileRoute('/orders/')({ component: OrdersPage });

function OrdersPage() {
  const { client } = Route.useRouteContext();
  const orders = useQuery({ queryKey: ['orders'], queryFn: () => client.listOrders() });

  return (
    <div>
      <PageHeader
        title="Orders"
        subtitle={orders.data ? `${String(orders.data.total)} placed` : undefined}
      />

      {orders.isPending ? (
        <Card>
          <Spinner /> Loading…
        </Card>
      ) : null}

      {orders.isError ? (
        <Banner tone="danger" title="Could not load orders.">
          {orders.error instanceof ApiError ? orders.error.message : String(orders.error)}
        </Banner>
      ) : null}

      {orders.data ? (
        <Card flush>
          {orders.data.items.length === 0 ? (
            <EmptyState>No orders yet.</EmptyState>
          ) : (
            <Table
              head={
                <>
                  <th className="mc-num">#</th>
                  <th>Placed</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th className="mc-num">Total</th>
                  <th />
                </>
              }
            >
              {orders.data.items.map((order) => (
                <tr key={order.id}>
                  <td className="mc-num mc-mono">{order.number}</td>
                  <td>{new Date(order.placedAt).toLocaleString()}</td>
                  <td>
                    <span className="mc-badge">{order.status}</span>
                  </td>
                  <td>
                    {/*
                      "Did this order get paid" is the one question this screen exists to answer,
                      and until the store started recording settlements it could not: a paid order
                      and an abandoned one looked identical here.
                    */}
                    <span className="mc-badge" data-payment={order.paymentStatus}>
                      {order.paymentStatus === 'unpaid' ? 'awaiting payment' : order.paymentStatus}
                    </span>
                  </td>
                  <td className="mc-num">
                    <Money minor={order.totalMinor} currency={order.currency} />
                  </td>
                  <td className="mc-num">
                    <Link to="/orders/$id" params={{ id: order.id }}>
                      Lines
                    </Link>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ) : null}
    </div>
  );
}
