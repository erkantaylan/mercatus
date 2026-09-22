/** `/` is not a page. The dashboard opens on the catalogue. */
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/products' });
  },
});
