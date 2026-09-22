/**
 * Store settings, READ-ONLY.
 *
 * `PATCH /api/settings` does not exist, and that is a decision rather than a gap: `tenants` is the
 * one table without RLS, so the app role holds SELECT on it and nothing else -- an UPDATE grant
 * would be a cross-tenant write surface on a table with no policy to scope it. The name and the
 * branding are control-plane facts mirrored down (BV1), so the edit belongs in the platform
 * console, which then re-mirrors (apps/store/src/routes/staff-settings.ts).
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { ApiError, STORE_API_URL } from '../api/client.js';
import { licenceBanner } from '../lib/licence.js';
import { Banner, Card, PageHeader, Spinner } from '../ui/index.js';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

function SettingsPage() {
  const { client } = Route.useRouteContext();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => client.getSettings() });
  const licence = useQuery({ queryKey: ['licence'], queryFn: () => client.getLicence() });

  return (
    <div className="mc-stack">
      <PageHeader title="Settings" subtitle="What this store believes about itself." />

      {settings.isError ? (
        <Banner tone="danger" title="Could not load settings.">
          {settings.error instanceof ApiError ? settings.error.message : String(settings.error)}
        </Banner>
      ) : null}

      <Card>
        <div className="mc-stack">
          <h2>Store</h2>
          {settings.isPending ? (
            <p>
              <Spinner /> Loading…
            </p>
          ) : settings.data ? (
            <dl className="mc-stack">
              <Row label="Name" value={settings.data.name} />
              <Row label="Slug" value={settings.data.slug} mono />
              <Row label="Accent" value={settings.data.branding.accent ?? '—'} mono />
              <Row label="Logo" value={settings.data.branding.logoUrl ?? '—'} mono />
            </dl>
          ) : null}
          <p className="mc-muted">
            Name and branding are mirrored from the platform and are changed there, not here.
          </p>
        </div>
      </Card>

      <Card>
        <div className="mc-stack">
          <h2>Licence</h2>
          {licence.data ? (
            <>
              <dl className="mc-stack">
                <Row label="Status" value={licence.data.status} />
                <Row label="State" value={licence.data.state} />
                <Row label="Valid until" value={licence.data.validUntil ?? '—'} />
                <Row
                  label="Last contact"
                  value={
                    licence.data.lastSuccessAt === null
                      ? 'never — this store does not poll'
                      : new Date(licence.data.lastSuccessAt).toLocaleString()
                  }
                />
              </dl>
              {(() => {
                const banner = licenceBanner(licence.data);
                return banner === null ? (
                  <p className="mc-muted">Healthy. Checkout is open.</p>
                ) : (
                  <Banner tone={banner.tone} title={banner.title}>
                    {banner.body}
                  </Banner>
                );
              })()}
            </>
          ) : (
            <p>
              <Spinner /> Loading…
            </p>
          )}
        </div>
      </Card>

      <p className="mc-muted mc-mono">API: {STORE_API_URL}</p>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mc-row">
      <dt className="mc-muted" style={{ width: '120px' }}>
        {label}
      </dt>
      <dd className={mono ? 'mc-mono' : undefined} style={{ margin: 0 }}>
        {value}
      </dd>
    </div>
  );
}
