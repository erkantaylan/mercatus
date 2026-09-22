/**
 * The catalogue (BUILD-PLAN §7.3). `GET /api/products` with no tenant anywhere in the request:
 * the token names it and RLS enforces it, so this table cannot be pointed at another merchant's
 * products even by editing the URL (BE1, BI1).
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';

import { ApiError } from '../api/client.js';
import { Banner, Card, EmptyState, Money, PageHeader, Spinner, Table } from '../ui/index.js';

export const Route = createFileRoute('/products/')({ component: ProductsPage });

function ProductsPage() {
  const { client } = Route.useRouteContext();
  const products = useQuery({ queryKey: ['products', 'list'], queryFn: () => client.listProducts() });

  return (
    <div>
      <PageHeader
        title="Products"
        subtitle={products.data ? `${String(products.data.total)} in this store` : undefined}
        actions={
          <Link to="/products/new" className="mc-button mc-button--primary">
            Add product
          </Link>
        }
      />

      {products.isPending ? (
        <Card>
          <Spinner /> Loading…
        </Card>
      ) : null}

      {products.isError ? (
        <Banner tone="danger" title="Could not load the catalogue.">
          {products.error instanceof ApiError ? products.error.message : String(products.error)}
        </Banner>
      ) : null}

      {products.data ? (
        <Card flush>
          {products.data.items.length === 0 ? (
            <EmptyState>No products yet. Add the first one.</EmptyState>
          ) : (
            <Table
              head={
                <>
                  <th>SKU</th>
                  <th>Title</th>
                  <th className="mc-num">Price</th>
                  <th className="mc-num">Stock</th>
                  <th />
                </>
              }
            >
              {products.data.items.map((product) => (
                <tr key={product.id}>
                  <td className="mc-mono">{product.sku}</td>
                  <td>{product.title}</td>
                  <td className="mc-num">
                    <Money minor={product.priceMinor} currency={product.currency} />
                  </td>
                  <td className="mc-num">{product.stock}</td>
                  <td className="mc-num">
                    <Link to="/products/$id" params={{ id: product.id }}>
                      Edit
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
