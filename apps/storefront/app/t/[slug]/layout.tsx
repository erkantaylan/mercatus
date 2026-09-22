/**
 * The store shell: the tenant's branding, as CSS custom properties (DW, BUILD-PLAN §7.2).
 *
 * This is the entire theming story. A tenant supplies a logo and three colours; they are written
 * onto ONE wrapper element as `--mc-accent`, `--mc-bg` and `--mc-fg`, and every rule underneath
 * already reads those names. There are no per-tenant templates, no per-tenant stylesheet and no
 * build step -- a dedicated instance is fully branded (DW) because its `branding` row is fully
 * branded, and pooled tenants are branded by exactly the same code.
 *
 * `params` is a Promise in the App Router; awaiting it is not optional.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';

import { BasketLink } from '@/components/BasketLink';
import { getBranding, StoreApiError } from '@/lib/api';
import { checkoutNotice } from '@/lib/licence';

export const dynamic = 'force-dynamic';

/** Custom properties are not in CSSProperties, and they are the whole point here. */
type BrandStyle = CSSProperties & Record<`--${string}`, string>;

export default async function StoreLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const branding = await getBranding(slug).catch((error: unknown) => {
    if (error instanceof StoreApiError && error.status === 404) notFound();
    throw error;
  });

  // CG3 arriving in the shell, so it is on every page of the shop rather than only on the one
  // where the refusal happens. A shopper who fills a basket and is told at the last step is a
  // shopper we wasted.
  const notice = checkoutNotice(branding.licence);

  const style: BrandStyle = {};
  if (branding.accent) style['--mc-accent'] = branding.accent;
  if (branding.bg) style['--mc-bg'] = branding.bg;
  if (branding.fg) style['--mc-fg'] = branding.fg;

  return (
    <div className="sf-shell" style={style} data-tenant={slug}>
      <header className="sf-header">
        <div className="sf-header-inner">
          <Link href={`/t/${slug}`} className="sf-brand">
            {branding.logoUrl ? (
              /* A plain <img>, not next/image: a tenant's logo is an arbitrary remote URL and
                 next/image would need every merchant's host allow-listed in next.config. */
              <img className="sf-brand-logo" src={branding.logoUrl} alt="" />
            ) : (
              <span className="sf-brand-mark" aria-hidden="true">
                {branding.name.slice(0, 1)}
              </span>
            )}
            <span className="sf-brand-name">{branding.name}</span>
          </Link>
          <nav className="sf-nav">
            <Link href={`/t/${slug}`}>Catalog</Link>
            <Link href={`/t/${slug}/orders`}>Orders</Link>
            <BasketLink slug={slug} />
          </nav>
        </div>
      </header>

      <main className="sf-main">
        {notice ? (
          <div className={`sf-banner sf-banner-${notice.tone}`} style={{ marginBottom: '1rem' }}>
            <strong>{notice.title}</strong> {notice.body}
          </div>
        ) : null}
        {children}
      </main>

      <footer className="sf-footer">
        <div className="sf-footer-inner">
          {/* CC3: the mark is an entitlement in the licence, not a build flag. A merchant who
              pays for white label loses it when a row changes in the control plane -- there is
              no second build, no NEXT_PUBLIC_ flag and no per-tenant bundle. */}
          {branding.name}
          {branding.licence.poweredByMark ? ' · a store on mercatus' : null} · tenant{' '}
          <code className="sf-mono">{slug}</code>
        </div>
      </footer>
    </div>
  );
}
