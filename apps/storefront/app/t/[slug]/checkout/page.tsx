/**
 * Checkout. The form is a client component for the same reason the basket page's table is: the
 * lines being bought are in localStorage.
 *
 * What it posts to is this app's own route handler, not the store API. The shopper's bearer token
 * lives in an httpOnly cookie and the bank's HMAC secret lives in this process; neither may be
 * handed to a browser.
 */
import Link from 'next/link';

import { CheckoutForm } from '@/components/CheckoutForm';
import { getBranding, listProducts } from '@/lib/api';
import { checkoutNotice } from '@/lib/licence';

export const dynamic = 'force-dynamic';

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [{ items }, branding] = await Promise.all([listProducts(slug), getBranding(slug)]);

  // The store API refuses the order anyway (402 or 503) -- this is the same decision, taken from
  // the same licence, one screen earlier. The gate is the API's; this is only manners.
  if (checkoutNotice(branding.licence)) {
    return (
      <>
        <div className="sf-page-header">
          <h1>Checkout</h1>
        </div>
        <p className="sf-muted">
          Your basket is kept. <Link href={`/t/${slug}`}>Keep browsing</Link> and try again later.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="sf-page-header">
        <h1>Checkout</h1>
        <p className="sf-muted">
          The order is placed first and paid second: the store API prices it from its own catalog,
          then the browser goes to fake-bank to settle it.
        </p>
      </div>
      <CheckoutForm slug={slug} products={items} />
    </>
  );
}
