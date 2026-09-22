/**
 * One order and its lines. A line keeps the title and unit price it was SOLD at, which is why
 * removing a product it references is refused rather than cascaded.
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';

import { ApiError } from '../api/client.js';
import { Banner, Card, Money, PageHeader, Spinner, Table } from '../ui/index.js';

export const Route = createFileRoute('/orders/$id')({ component: OrderDetailPage });

function OrderDetailPage() {
  const { id } = Route.useParams();
  const { client } = Route.useRouteContext();
  const order = useQuery({ queryKey: ['orders', id], queryFn: () => client.getOrder(id) });

  if (order.isPending) {
    return (
      <Card>
        <Spinner /> Loading…
      </Card>
    );
  }

  if (order.isError) {
    return (
      <Banner tone="danger" title="Not found.">
        {order.error instanceof ApiError ? order.error.message : String(order.error)}
      </Banner>
    );
  }

  return (
    <div>
      <PageHeader
        title={`Order #${String(order.data.number)}`}
        subtitle={`${order.data.status} · ${new Date(order.data.placedAt).toLocaleString()}`}
        actions={
          <Link to="/orders" className="mc-button">
            Back
          </Link>
        }
      />
      <Card flush>
        <Table
          head={
            <>
              <th>Item</th>
              <th className="mc-num">Unit</th>
              <th className="mc-num">Qty</th>
              <th className="mc-num">Line</th>
            </>
          }
        >
          {order.data.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.titleSnapshot}</td>
              <td className="mc-num">
                <Money minor={line.unitPriceMinor} currency={order.data.currency} />
              </td>
              <td className="mc-num">{line.qty}</td>
              <td className="mc-num">
                <Money minor={line.unitPriceMinor * line.qty} currency={order.data.currency} />
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className="mc-num">
              <strong>Total</strong>
            </td>
            <td className="mc-num">
              <strong>
                <Money minor={order.data.totalMinor} currency={order.data.currency} />
              </strong>
            </td>
          </tr>
        </Table>
      </Card>
    </div>
  );
}
