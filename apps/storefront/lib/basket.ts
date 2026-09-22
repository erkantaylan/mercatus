/**
 * The basket (BUILD-PLAN §7.2). Browser state, and nothing else.
 *
 * An array of `{ productId, qty }` in localStorage under `mercatus.basket.<slug>`. No price is
 * stored: prices are re-read from the catalog on every render and the total is recomputed by the
 * store API inside the checkout transaction, because a posted price is a suggestion.
 *
 * One key per tenant, so a shopper browsing two stores in a pooled deployment has two baskets --
 * and so that clearing one cannot clear the other.
 *
 * Client module. Every function tolerates localStorage being unavailable or holding junk, because
 * a basket is not worth a blank page.
 */
'use client';

export interface BasketLine {
  readonly productId: string;
  readonly qty: number;
}

export function basketKey(slug: string): string {
  return `mercatus.basket.${slug}`;
}

/** Set on checkout, read on the way back from the bank, cleared by the confirmation page. */
export function pendingOrderKey(slug: string): string {
  return `mercatus.pendingOrder.${slug}`;
}

function parse(raw: string | null): BasketLine[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): BasketLine[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const line = entry as Record<string, unknown>;
      const { productId, qty } = line;
      if (typeof productId !== 'string' || typeof qty !== 'number') return [];
      if (!Number.isInteger(qty) || qty < 1) return [];
      return [{ productId, qty }];
    });
  } catch {
    return [];
  }
}

export function readBasket(slug: string): BasketLine[] {
  if (typeof window === 'undefined') return [];
  try {
    return parse(window.localStorage.getItem(basketKey(slug)));
  } catch {
    return [];
  }
}

function write(slug: string, lines: BasketLine[]): BasketLine[] {
  try {
    window.localStorage.setItem(basketKey(slug), JSON.stringify(lines));
  } catch {
    // Private mode, or a full quota. The basket is lost; the page still works.
  }
  // Same-tab listeners: the storage event only fires in OTHER tabs.
  window.dispatchEvent(new CustomEvent('mercatus:basket', { detail: { slug } }));
  return lines;
}

export function addToBasket(slug: string, productId: string, qty = 1): BasketLine[] {
  const lines = readBasket(slug);
  const existing = lines.find((line) => line.productId === productId);
  const next = existing
    ? lines.map((line) => (line.productId === productId ? { productId, qty: line.qty + qty } : line))
    : [...lines, { productId, qty }];
  return write(slug, next);
}

export function setQty(slug: string, productId: string, qty: number): BasketLine[] {
  const lines = readBasket(slug).flatMap((line) =>
    line.productId === productId ? (qty > 0 ? [{ productId, qty }] : []) : [line],
  );
  return write(slug, lines);
}

export function clearBasket(slug: string): void {
  write(slug, []);
}
