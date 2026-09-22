/**
 * The store home: the tenant's catalog (BUILD-PLAN §7.2).
 *
 * Nothing here names a tenant id. The slug goes into the path, the store API resolves it from the
 * request, and row-level security decides which products exist inside that transaction (BE1) --
 * which is why asking for `/t/borg/products` from the acme page would return borg's products
 * rather than a mixture, and why a bug in tenant resolution shows up as an empty page instead of
 * as someone else's stock.
 */
import { ProductCard } from '@/components/ProductCard';
import { listProducts } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function StoreHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { items, total } = await listProducts(slug);

  return (
    <>
      <div className="sf-page-header">
        <h1>Catalog</h1>
        <p className="sf-muted">
          {total === 0 ? 'Nothing for sale yet.' : `${String(total)} products.`}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="sf-empty">This store has no products.</div>
      ) : (
        <div className="sf-grid">
          {items.map((product) => (
            <ProductCard key={product.id} slug={slug} product={product} />
          ))}
        </div>
      )}
    </>
  );
}
