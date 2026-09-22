/**
 * The root path, and the ONE place the two deployment modes differ in this app (CC1).
 *
 * dedicated -- TENANT_SLUG is set, this process serves one store, so `/` is that store.
 * pooled    -- it is not, so `/` lists the stores. There is no "list every tenant" endpoint on
 *              the store API and there should not be: a shopper on `acme` has no business
 *              enumerating the platform's merchants. The list is configuration, and only the
 *              names are fetched, one public branding call per slug.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { config } from '@/lib/config';
import { getBranding } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { tenantSlug, tenantSlugs } = config();
  if (tenantSlug) redirect(`/t/${tenantSlug}`);

  const stores = await Promise.all(
    tenantSlugs.map(async (slug) => {
      try {
        const branding = await getBranding(slug);
        return { slug, name: branding.name, accent: branding.accent ?? null };
      } catch {
        // A slug in the config that the API does not know is a configuration error, not a crash.
        return { slug, name: null, accent: null };
      }
    }),
  );

  return (
    <div className="sf-shell">
      <header className="sf-header">
        <div className="sf-header-inner">
          <span className="sf-brand-name">mercatus</span>
          <span className="sf-muted">pooled storefront</span>
        </div>
      </header>
      <main className="sf-main">
        <div className="sf-page-header">
          <h1>Stores</h1>
          <p className="sf-muted">
            One process, several merchants. Each store below is a tenant, isolated in the database
            by row-level security.
          </p>
        </div>
        <div className="sf-grid">
          {stores.map((store) => (
            <Link key={store.slug} href={`/t/${store.slug}`} className="sf-product">
              <div
                className="sf-product-placeholder"
                style={store.accent ? { background: store.accent, color: '#fff' } : undefined}
              >
                /t/{store.slug}
              </div>
              <div className="sf-product-body">
                <span className="sf-product-title">{store.name ?? store.slug}</span>
                <span className="sf-muted">{store.name ? 'open' : 'unknown to the store API'}</span>
              </div>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
