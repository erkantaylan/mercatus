/**
 * The basket table. Client, because the basket is localStorage.
 *
 * The total shown here is advisory. The one that is charged is computed by the store API inside
 * the checkout transaction, from the products table -- a posted price is a suggestion.
 */
'use client';

import Link from 'next/link';
import type { Product } from '@mercatus/contracts';
import { useEffect, useState } from 'react';

import type { BasketLine } from '@/lib/basket';
import { readBasket, setQty } from '@/lib/basket';
import { formatMoney } from '@/lib/money';

export function BasketView({ slug, products }: { slug: string; products: readonly Product[] }) {
  const [lines, setLines] = useState<BasketLine[] | null>(null);

  useEffect(() => {
    setLines(readBasket(slug));
  }, [slug]);

  if (lines === null) return <div className="sf-empty">Reading your basket…</div>;

  const byId = new Map(products.map((product) => [product.id, product]));
  const rows = lines.flatMap((line) => {
    const product = byId.get(line.productId);
    // A product that has since been deleted, or that belongs to another store. Drop it rather
    // than carry an id the catalog does not know.
    return product ? [{ line, product }] : [];
  });

  const currency = rows[0]?.product.currency ?? 'TRY';
  const total = rows.reduce((sum, row) => sum + row.product.priceMinor * row.line.qty, 0);

  if (rows.length === 0) {
    return (
      <div className="sf-empty">
        Your basket is empty. <Link href={`/t/${slug}`}>Back to the catalog</Link>.
      </div>
    );
  }

  return (
    <div className="sf-stack">
      <table className="sf-table">
        <thead>
          <tr>
            <th>Product</th>
            <th className="sf-num">Price</th>
            <th className="sf-num">Qty</th>
            <th className="sf-num">Line</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ line, product }) => (
            <tr key={product.id}>
              <td>
                <Link href={`/t/${slug}/p/${product.id}`}>{product.title}</Link>
                <div className="sf-mono sf-muted">{product.sku}</div>
              </td>
              <td className="sf-num">{formatMoney(product.priceMinor, product.currency)}</td>
              <td className="sf-num">
                <input
                  className="sf-input sf-num"
                  style={{ width: '4.5rem' }}
                  type="number"
                  min={1}
                  max={product.stock}
                  value={line.qty}
                  aria-label={`Quantity of ${product.title}`}
                  onChange={(event) => {
                    const qty = Number.parseInt(event.target.value, 10);
                    setLines(setQty(slug, product.id, Number.isFinite(qty) ? qty : 1));
                  }}
                />
              </td>
              <td className="sf-num">
                {formatMoney(product.priceMinor * line.qty, product.currency)}
              </td>
              <td className="sf-num">
                <button
                  type="button"
                  className="sf-button sf-button-quiet sf-button-small"
                  onClick={() => {
                    setLines(setQty(slug, product.id, 0));
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}>
              <strong>Total</strong>
            </td>
            <td className="sf-num">
              <strong>{formatMoney(total, currency)}</strong>
            </td>
            <td />
          </tr>
        </tbody>
      </table>

      <div className="sf-row">
        <Link className="sf-button" href={`/t/${slug}/checkout`}>
          Checkout
        </Link>
        <Link className="sf-button sf-button-quiet" href={`/t/${slug}`}>
          Keep shopping
        </Link>
      </div>
    </div>
  );
}
