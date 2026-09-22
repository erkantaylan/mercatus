/**
 * Add-to-basket. The only interactive thing on the catalog, and it touches nothing but
 * localStorage -- the basket is browser state and never reaches the server until checkout.
 */
'use client';

import { useState } from 'react';

import { addToBasket } from '@/lib/basket';

export function AddToBasket({
  slug,
  productId,
  qty = 1,
  disabled = false,
  small = false,
}: {
  slug: string;
  productId: string;
  qty?: number;
  disabled?: boolean;
  small?: boolean;
}) {
  const [added, setAdded] = useState(false);

  return (
    <button
      type="button"
      className={small ? 'sf-button sf-button-small' : 'sf-button'}
      disabled={disabled}
      onClick={() => {
        addToBasket(slug, productId, qty);
        setAdded(true);
        window.setTimeout(() => {
          setAdded(false);
        }, 1200);
      }}
    >
      {added ? 'Added' : 'Add to basket'}
    </button>
  );
}
