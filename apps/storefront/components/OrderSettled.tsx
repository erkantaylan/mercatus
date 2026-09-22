/**
 * The payment banner on the confirmation page, and the two pieces of clean-up that belong to
 * arriving here: the basket is emptied and the pending-order marker is dropped, so browser Back
 * stops routing to this page.
 *
 * It polls `/api/payments/:orderId` for a few seconds. A shopper who comes back faster than the
 * bank's callback would otherwise see "waiting" and never see it change -- and the whole point of
 * settling through fake-bank is to watch the settlement arrive.
 */
'use client';

import { useEffect, useState } from 'react';

import { clearBasket, pendingOrderKey } from '@/lib/basket';

type Outcome = 'pending' | 'paid' | 'declined' | 'unknown';

interface State {
  outcome: Outcome;
  source: string;
}

const POLL_MS = 1000;
const ATTEMPTS = 15;

export function OrderSettled({ slug, orderId }: { slug: string; orderId: string }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    clearBasket(slug);
    try {
      window.localStorage.removeItem(pendingOrderKey(slug));
    } catch {
      // Nothing to clean up, then.
    }
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;

    const tick = async (): Promise<void> => {
      tries += 1;
      try {
        const response = await fetch(`/api/payments/${orderId}`, { cache: 'no-store' });
        const payload = (await response.json()) as State;
        if (cancelled) return;
        setState(payload);
        if (payload.outcome === 'pending' && tries < ATTEMPTS) {
          window.setTimeout(() => void tick(), POLL_MS);
        }
      } catch {
        if (!cancelled && tries < ATTEMPTS) window.setTimeout(() => void tick(), POLL_MS);
      }
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (!state) return <div className="sf-banner sf-banner-info">Checking the payment…</div>;

  if (state.outcome === 'paid') {
    return (
      <div className="sf-banner sf-banner-success" data-payment="paid">
        <strong>Paid.</strong> fake-bank settled this order and told us so
        {state.source === 'callback' ? ' with a signed callback we verified.' : '.'}
      </div>
    );
  }

  if (state.outcome === 'declined') {
    return (
      <div className="sf-banner sf-banner-danger" data-payment="declined">
        <strong>Declined.</strong> The order stands, unpaid. Nothing was shipped and nothing was
        charged.
      </div>
    );
  }

  if (state.outcome === 'unknown') {
    return (
      <div className="sf-banner sf-banner-warning" data-payment="unknown">
        This order has no payment on record in this process. It was probably placed before the
        storefront restarted.
      </div>
    );
  }

  return (
    <div className="sf-banner sf-banner-warning" data-payment="pending">
      <strong>Awaiting the bank.</strong> The order is placed and priced; fake-bank has not
      answered yet.
    </div>
  );
}
