/**
 * Add a product. On success the catalogue query is invalidated and the merchant lands on the
 * list, where the new row is already there -- which is also this task's gate.
 */
import type { CreateProductBody } from '@mercatus/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';

import { ApiError } from '../api/client.js';
import { ProductForm } from '../components/ProductForm.js';
import { useLicence, writesRefused } from '../lib/licence.js';
import { Card, PageHeader } from '../ui/index.js';

export const Route = createFileRoute('/products/new')({ component: NewProductPage });

function NewProductPage() {
  const { client } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  // Read-only is OUR outage past the grace window, never a passive licence (CG3). The banner in
  // the shell says why; this is what stops the merchant filling a form that would 503.
  const licence = useLicence(client);

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
          disabled={writesRefused(licence.data)}
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
