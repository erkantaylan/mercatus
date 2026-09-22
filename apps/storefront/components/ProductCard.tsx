/**
 * One product in the grid. A server component: the only interactive part is the add-to-basket
 * button, which is its own client component, so the catalog ships no JavaScript for the cards.
 */
import Link from 'next/link';
import type { Product } from '@mercatus/contracts';

import { AddToBasket } from '@/components/AddToBasket';
import { formatMoney } from '@/lib/money';

export function ProductCard({ slug, product }: { slug: string; product: Product }) {
  return (
    <article className="sf-product">
      {product.imageUrl ? (
        <img className="sf-product-image" src={product.imageUrl} alt="" />
      ) : (
        <div className="sf-product-placeholder">{product.sku}</div>
      )}
      <div className="sf-product-body">
        <Link className="sf-product-title" href={`/t/${slug}/p/${product.id}`}>
          {product.title}
        </Link>
        <span className="sf-price">{formatMoney(product.priceMinor, product.currency)}</span>
        <div className="sf-product-foot">
          <span className="sf-muted">
            {product.stock > 0 ? `${String(product.stock)} in stock` : 'out of stock'}
          </span>
          <AddToBasket slug={slug} productId={product.id} disabled={product.stock < 1} small />
        </div>
      </div>
    </article>
  );
}
