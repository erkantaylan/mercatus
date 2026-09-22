/**
 * Checkout. The form is a client component for the same reason the basket page's table is: the
 * lines being bought are in localStorage.
 *
 * What it posts to is this app's own route handler, not the store API. The shopper's bearer token
 * lives in an httpOnly cookie and the bank's HMAC secret lives in this process; neither may be
 * handed to a browser.
 */
import { CheckoutForm } from '@/components/CheckoutForm';
import { listProducts } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { items } = await listProducts(slug);

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
