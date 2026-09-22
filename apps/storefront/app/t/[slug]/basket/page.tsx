/**
 * The basket.
 *
 * The page is a server component that fetches the tenant's catalog and hands it to a client
 * component, which intersects it with localStorage. That is deliberate: it means prices are read
 * from the API on every render (BUILD-PLAN §7.2) rather than being stored alongside the basket,
 * and a product whose price changed while it sat in a basket shows the new price rather than a
 * stale one the shopper might then argue about.
 *
 * The catalogs here are single digits of products, so fetching all of them costs less than an
 * endpoint that takes a list of ids would.
 */
import { BasketView } from '@/components/BasketView';
import { listProducts } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function BasketPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { items } = await listProducts(slug);

  return (
    <>
      <div className="sf-page-header">
        <h1>Basket</h1>
        <p className="sf-muted">Kept in this browser only. Nothing is reserved until checkout.</p>
      </div>
      <BasketView slug={slug} products={items} />
    </>
  );
}
