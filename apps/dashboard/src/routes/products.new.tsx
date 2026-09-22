/**
 * Add a product. On success the catalogue query is invalidated and the merchant lands on the
 * list, where the new row is already there -- which is also this task's gate.
 */
import type { CreateProductBody } from '@mercatus/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';

import { ApiError } from '../api/client.js';
import { ProductForm } from '../components/ProductForm.js';
import { Card, PageHeader } from '../ui/index.js';

export const Route = createFileRoute('/products/new')({ component: NewProductPage });

function NewProductPage() {
  const { client } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();

  const create = useMutation({
    mutationFn: (body: CreateProductBody) => client.createProduct(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['products', 'list'] });
      await router.navigate({ to: '/products' });
    },
  });

  return (
    <div>
      <PageHeader title="Add product" />
      <Card>
        <ProductForm
          submitLabel="Add product"
          busy={create.isPending}
          error={
            create.error === null
              ? undefined
              : create.error instanceof ApiError
                ? `${create.error.code}: ${create.error.message}`
                : String(create.error)
          }
          onSubmit={(body) => create.mutate(body)}
          secondaryAction={
            <Link to="/products" className="mc-button">
              Cancel
            </Link>
          }
        />
      </Card>
    </div>
  );
}
