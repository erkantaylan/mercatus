/**
 * The checkout form, and the hand-off to fake-bank.
 *
 * Three things happen on submit, in this order, and the order is the design:
 *
 *   1. POST to this app's `/api/checkout`, which places the order on the store API. The order
 *      exists, priced by the store, before any money is discussed.
 *   2. the order id is written to localStorage as the PENDING order. fake-bank's hosted page has
 *      no "return to merchant" link -- it is a developer's failure-injection console, not a
 *      payment provider -- so browser Back is how a shopper comes home, and this marker is what
 *      turns that back-navigation into the confirmation page instead of an empty form.
 *   3. the browser leaves for the bank.
 *
 * The basket is NOT cleared here. It is cleared by the confirmation page, once there is an order
 * to show: a shopper who closes the bank tab still has their basket.
 */
'use client';

import type { Product } from '@mercatus/contracts';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { BasketLine } from '@/lib/basket';
import { pendingOrderKey, readBasket } from '@/lib/basket';
import { formatMoney } from '@/lib/money';

interface CheckoutResponse {
  orderId?: unknown;
  paymentUrl?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export function CheckoutForm({ slug, products }: { slug: string; products: readonly Product[] }) {
  const router = useRouter();
  const [lines, setLines] = useState<BasketLine[] | null>(null);
  const [phone, setPhone] = useState('+905550000001');
  const [name, setName] = useState('Dev Shopper');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Back from the bank: there is an order waiting to be confirmed, so go and confirm it.
    const check = (): void => {
      let pending: string | null;
      try {
        pending = window.localStorage.getItem(pendingOrderKey(slug));
      } catch {
        pending = null;
      }
      if (pending) {
        router.replace(`/t/${slug}/order/${pending}`);
        return;
      }
      setLines(readBasket(slug));
    };

    check();
    // A back-navigation can be served from the bfcache, which restores the DOM without re-running
    // effects. `pageshow` is the event that fires in both cases, so it is what makes browser Back
    // land on the confirmation rather than on a form the shopper already submitted.
    window.addEventListener('pageshow', check);
    return () => {
      window.removeEventListener('pageshow', check);
    };
  }, [slug, router]);

  if (lines === null) return <div className="sf-empty">Reading your basket…</div>;

  const byId = new Map(products.map((product) => [product.id, product]));
  const rows = lines.flatMap((line) => {
    const product = byId.get(line.productId);
    return product ? [{ line, product }] : [];
  });
  const currency = rows[0]?.product.currency ?? 'TRY';
  const total = rows.reduce((sum, row) => sum + row.product.priceMinor * row.line.qty, 0);

  if (rows.length === 0) {
    return <div className="sf-empty">Your basket is empty, so there is nothing to check out.</div>;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug,
          phone,
          name,
          lines: rows.map((row) => ({ productId: row.product.id, qty: row.line.qty })),
        }),
      });
      const payload = (await response.json()) as CheckoutResponse;

      if (!response.ok) {
        const code = typeof payload.error?.code === 'string' ? payload.error.code : 'UNKNOWN';
        const message =
          typeof payload.error?.message === 'string' ? payload.error.message : 'Checkout failed.';
        // The two the shopper can act on get their own sentence; everything else is reported as
        // the API worded it.
        setError(
          code === 'LICENCE_PASSIVE'
            ? 'This store cannot take orders at the moment. Its licence is passive.'
            : code === 'INSUFFICIENT_STOCK'
              ? `Not enough stock: ${message}`
              : `${code}: ${message}`,
        );
        setBusy(false);
        return;
      }

      const { orderId, paymentUrl } = payload;
      if (typeof orderId !== 'string') {
        setError('The checkout answered something unexpected.');
        setBusy(false);
        return;
      }

      try {
        window.localStorage.setItem(pendingOrderKey(slug), orderId);
      } catch {
        // Then Back lands on this form instead of the confirmation. Not worth failing over.
      }

      if (typeof paymentUrl !== 'string') {
        // 202: the order is placed and the bank could not be reached. Payments are the control
        // plane's (CE2), so on a dedicated instance this is what an outage of OURS looks like --
        // the shop sold, and the confirmation page says the money has not been taken yet (CG1).
        router.replace(`/t/${slug}/order/${orderId}`);
        return;
      }
      window.location.href = paymentUrl;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkout failed.');
      setBusy(false);
    }
  }

  return (
    <form className="sf-stack" onSubmit={(event) => void submit(event)}>
      <table className="sf-table">
        <thead>
          <tr>
            <th>Product</th>
            <th className="sf-num">Qty</th>
            <th className="sf-num">Line</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ line, product }) => (
            <tr key={product.id}>
              <td>{product.title}</td>
              <td className="sf-num">{line.qty}</td>
              <td className="sf-num">
                {formatMoney(product.priceMinor * line.qty, product.currency)}
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={2}>
              <strong>Total</strong>
            </td>
            <td className="sf-num">
              <strong>{formatMoney(total, currency)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="sf-card sf-stack">
        <div className="sf-field">
          <label htmlFor="phone">Phone</label>
          <input
            id="phone"
            className="sf-input"
            value={phone}
            required
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
          <span className="sf-hint">
            E.164, e.g. +905550000001. It identifies you at this store and nowhere else.
          </span>
        </div>

        <div className="sf-field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            className="sf-input"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>

        {error ? <p className="sf-error">{error}</p> : null}

        <div className="sf-row">
          <button className="sf-button" type="submit" disabled={busy}>
            {busy ? 'Placing the order…' : `Pay ${formatMoney(total, currency)}`}
          </button>
          <span className="sf-hint">You will be sent to fake-bank to complete the payment.</span>
        </div>
      </div>
    </form>
  );
}
