/**
 * Edit or remove one product.
 *
 * A product id that belongs to another merchant is a 404 here, not a 403, because the row simply
 * is not visible inside this transaction (BE1). There is nothing for this page to check.
 */
import type { PatchProductBody } from '@mercatus/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';

import { ApiError } from '../api/client.js';
import { ProductForm } from '../components/ProductForm.js';
import { Banner, Button, Card, PageHeader, Spinner } from '../ui/index.js';

export const Route = createFileRoute('/products/$id')({ component: EditProductPage });

function EditProductPage() {
  const { id } = Route.useParams();
  const { client } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();

  const product = useQuery({ queryKey: ['products', 'detail', id], queryFn: () => client.getProduct(id) });

  const save = useMutation({
    mutationFn: (body: PatchProductBody) => client.patchProduct(id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await router.navigate({ to: '/products' });
    },
  });

  // The detail query is dropped rather than invalidated: the row is gone, and refetching it would
  // ask the store for a product that no longer exists and log a 404 on the way out.

  const remove = useMutation({
    mutationFn: () => client.deleteProduct(id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: ['products', 'detail', id] });
      await queryClient.invalidateQueries({ queryKey: ['products', 'list'] });
      await router.navigate({ to: '/products' });
    },
  });

  const failure = save.error ?? remove.error;

  if (product.isPending) {
    return (
      <Card>
        <Spinner /> Loading…
      </Card>
    );
  }

  if (product.isError) {
    return (
      <Banner tone="danger" title="Not found.">
        {product.error instanceof ApiError ? product.error.message : String(product.error)}
      </Banner>
    );
  }

  return (
    <div>
      <PageHeader title={product.data.title} subtitle={product.data.sku} />
      <Card>
        <ProductForm
          initial={product.data}
          submitLabel="Save changes"
          busy={save.isPending}
          error={
            failure === null
              ? undefined
              : failure instanceof ApiError
                ? `${failure.code}: ${failure.message}`
                : String(failure)
          }
          onSubmit={(body) => save.mutate(body)}
          secondaryAction={
            <>
              <Link to="/products" className="mc-button">
                Cancel
              </Link>
              <span className="mc-spacer" />
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? 'Removing…' : 'Remove'}
              </Button>
            </>
          }
        />
      </Card>
    </div>
  );
}
