/**
 * Sign in, once, for every store this process serves.
 *
 * It is deliberately NOT under `/t/[slug]`: the session is tenant-less (Q20), so putting the page
 * inside a store's shell would suggest a shopper has an account "at acme" when what they have is
 * an account, full stop. The `next` parameter is where they were going; it is checked to be a
 * path on this site, because an open redirect on a sign-in page is the classic one.
 */
import Link from 'next/link';

import { SignInForm } from '@/components/SignInForm';
import { safeNext } from '@/lib/next-path';
import { readShopperSession, shopperLabel } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const session = await readShopperSession();

  return (
    <div className="sf-shell">
      <header className="sf-header">
        <div className="sf-header-inner">
          <span className="sf-brand-name">mercatus</span>
          <span className="sf-muted">shopper sign-in</span>
        </div>
      </header>
      <main className="sf-main">
        <div className="sf-page-header">
          <h1>Sign in</h1>
          <p className="sf-muted">
            One account for every shop on this platform. The identity provider says who you are;
            the store you are buying from comes from the address bar, and the store API applies
            both.
          </p>
        </div>
        <SignInForm
          next={safeNext(next)}
          current={session}
          label={session === null ? null : shopperLabel(session)}
        />
        <p className="sf-muted" style={{ marginTop: 'var(--mc-space-5)' }}>
          <Link href={safeNext(next)}>Back to the shop</Link>
        </p>
      </main>
    </div>
  );
}
