/**
 * Product detail. A 404 here is genuinely a 404: another merchant's product id is invisible
 * inside this tenant's transaction, so "not found" and "not yours" are the same answer and
 * neither confirms the other's existence (BE1, S1).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AddToBasket } from '@/components/AddToBasket';
import { getProduct, StoreApiError } from '@/lib/api';
import { formatMoney } from '@/lib/money';

export const dynamic = 'force-dynamic';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;

  const product = await getProduct(slug, id).catch((error: unknown) => {
    if (error instanceof StoreApiError && error.status === 404) notFound();
    throw error;
  });

  return (
    <>
      <p className="sf-muted" style={{ marginBottom: 'var(--mc-space-4)' }}>
        <Link href={`/t/${slug}`}>← Catalog</Link>
      </p>

      <div className="sf-detail">
        {product.imageUrl ? (
          <img className="sf-product-image" src={product.imageUrl} alt="" />
        ) : (
          <div className="sf-product-placeholder">{product.sku}</div>
        )}

        <div className="sf-stack">
          <div>
            <h1 style={{ margin: '0 0 var(--mc-space-2)' }}>{product.title}</h1>
            <p className="sf-mono sf-muted">{product.sku}</p>
          </div>

          <span className="sf-price">{formatMoney(product.priceMinor, product.currency)}</span>

          <p className="sf-muted">
            {product.stock > 0
              ? `${String(product.stock)} in stock`
              : 'Out of stock. Checkout would answer 409 INSUFFICIENT_STOCK.'}
          </p>

          <div className="sf-row">
            <AddToBasket slug={slug} productId={product.id} disabled={product.stock < 1} />
            <Link className="sf-button sf-button-quiet" href={`/t/${slug}/basket`}>
              Go to basket
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
