/**
 * The add/edit form. One component for both, because a product is the same four facts whether it
 * is being created or corrected, and two forms drift.
 *
 * Price is typed in major units and sent in minor ones. The wire is always an integer
 * (contracts/common.ts: minorAmountSchema) -- the conversion happens here, once, and nothing
 * downstream sees a float.
 */
import type { CreateProductBody, Product } from '@mercatus/contracts';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { Button, Field, Input } from '../ui/index.js';

export interface ProductFormProps {
  readonly initial?: Product;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly error?: string | undefined;
  onSubmit(body: CreateProductBody): void;
  readonly secondaryAction?: ReactNode;
}

function toMajor(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function ProductForm({
  initial,
  submitLabel,
  busy,
  disabled = false,
  error,
  onSubmit,
  secondaryAction,
}: ProductFormProps) {
  const [sku, setSku] = useState(initial?.sku ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [price, setPrice] = useState(initial === undefined ? '' : toMajor(initial.priceMinor));
  const [currency, setCurrency] = useState(initial?.currency ?? 'TRY');
  const [stock, setStock] = useState(String(initial?.stock ?? 0));
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? '');

  const priceMinor = Math.round(Number(price) * 100);
  const stockValue = Number(stock);
  const valid =
    sku.trim().length > 0 &&
    title.trim().length > 0 &&
    Number.isFinite(priceMinor) &&
    priceMinor >= 0 &&
    Number.isInteger(stockValue) &&
    stockValue >= 0 &&
    /^[A-Z]{3}$/.test(currency);

  return (
    <form
      className="mc-stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          sku: sku.trim(),
          title: title.trim(),
          priceMinor,
          currency,
          stock: stockValue,
          imageUrl: imageUrl.trim() === '' ? null : imageUrl.trim(),
        });
      }}
    >
      <div className="mc-form-grid">
        <Field label="SKU" htmlFor="sku" hint="Unique within this store, never across stores.">
          <Input id="sku" value={sku} autoComplete="off" onChange={(e) => setSku(e.target.value)} />
        </Field>
        <Field label="Title" htmlFor="title">
          <Input id="title" value={title} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Price" htmlFor="price" hint="Sent as minor units; 12.50 becomes 1250.">
          <Input
            id="price"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field label="Currency" htmlFor="currency" hint="ISO 4217, three letters.">
          <Input
            id="currency"
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Stock" htmlFor="stock">
          <Input
            id="stock"
            type="number"
            min="0"
            step="1"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
          />
        </Field>
        <Field label="Image URL" htmlFor="imageUrl" hint="Optional.">
          <Input id="imageUrl" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
        </Field>
      </div>

      {error !== undefined ? <p className="mc-error">{error}</p> : null}

      <div className="mc-row">
        <Button type="submit" variant="primary" disabled={busy || disabled || !valid}>
          {busy ? 'Saving…' : submitLabel}
        </Button>
        {secondaryAction}
      </div>
    </form>
  );
}
