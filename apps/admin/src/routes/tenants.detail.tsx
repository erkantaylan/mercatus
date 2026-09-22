/**
 * One tenant: its licence, its installation, and the active/passive flip (CG3, ES).
 *
 * What the flip means, spelled out on the screen because it is the distinction the whole
 * degradation design rests on:
 *
 *   passive      the tenant's own status. Checkout is blocked; the storefront still browses and
 *                the merchant's dashboard stays FULLY usable, because the page that fixes this is
 *                the first thing you would otherwise take away. Nothing is deleted.
 *   unreachable  our fault, computed in the data plane from how long it has been since the
 *                licence last verified. It is NOT this button and never will be -- collapsing the
 *                two makes our outage look to a merchant exactly like being cut off for
 *                non-payment.
 *
 * A dedicated instance learns it went passive by POLLING us on a short interval (CE4). Nothing
 * here reaches into their network, so the flip is not instant on their box and the screen says so.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { getTenant, setEntitlements, setLicenceStatus } from '../api/client.js';
import type { LicenceStatus } from '../api/schemas.js';
import { formatAge, formatInstant } from '../ui/format.js';
import { Banner, Button, Card, EmptyState, PageHeader, StatusPill } from '../ui/index.js';

export function TenantDetailPage(): ReactNode {
  const { slug } = useParams({ from: '/tenants/$slug' });
  const queryClient = useQueryClient();

  const tenant = useQuery({ queryKey: ['tenant', slug], queryFn: () => getTenant(slug) });

  const refresh = async (): Promise<void> => {
    // Both views read the same row, and an operator who flips from the detail page and then
    // hits Back should not see the old status.
    await queryClient.invalidateQueries({ queryKey: ['tenant', slug] });
    await queryClient.invalidateQueries({ queryKey: ['tenants'] });
  };

  const flip = useMutation({
    mutationFn: (status: LicenceStatus) => setLicenceStatus(slug, status),
    onSuccess: refresh,
  });

  // CC3: a feature is data in the licence, never a build. This button changes a row; the
  // merchant's storefront follows within one poll interval, with nothing rebuilt.
  const entitle = useMutation({
    mutationFn: (next: Record<string, boolean>) =>
      setEntitlements(slug, (tenant.data?.licence?.status ?? 'active') as LicenceStatus, next),
    onSuccess: refresh,
  });

  if (tenant.isPending) return <EmptyState>Loading...</EmptyState>;
  if (tenant.isError) return <Banner tone="danger">{(tenant.error as Error).message}</Banner>;

  const row = tenant.data;
  const licenceStatus = row.licence?.status ?? 'unknown';
  const entitlements = Object.entries(row.licence?.entitlements ?? {});
  const whiteLabel = row.licence?.entitlements['whiteLabel'] === true;

  return (
    <>
      <PageHeader
        title={row.name}
        subtitle={`${row.tier} · created ${formatInstant(row.createdAt)}`}
        actions={<StatusPill value={row.status} testId="tenant-status" />}
      />

      {flip.isError ? <Banner tone="danger">{(flip.error as Error).message}</Banner> : null}

      {row.status === 'passive' ? (
        <Banner tone="warning">
          <strong>Passive.</strong> Checkout is refused with <span className="mc-mono">402</span>.
          The storefront still browses and the merchant&apos;s dashboard is fully usable &mdash;
          this is not an outage, and nothing has been deleted.
        </Banner>
      ) : null}

      {row.status === 'pending' ? (
        <Banner tone="info">
          <strong>Pending.</strong> Signup created this tenant; payment has not activated it. There
          is no licence to suspend yet.
        </Banner>
      ) : null}

      <div className="mc-card-grid">
        <Card title="Licence">
          {row.licence === null ? (
            <EmptyState>No licence issued.</EmptyState>
          ) : (
            <dl className="mc-defs">
              <dt>Status</dt>
              <dd>
                <StatusPill value={licenceStatus} testId="licence-status" />
              </dd>
              <dt>Valid until</dt>
              <dd className="mc-mono">{row.licence.validUntil}</dd>
              <dt>Entitlements</dt>
              <dd className="mc-mono">
                {entitlements.length === 0
                  ? 'none'
                  : entitlements.map(([key, on]) => `${key}=${String(on)}`).join(', ')}
              </dd>
              <dt>Activated</dt>
              <dd>{formatInstant(row.activatedAt)}</dd>
            </dl>
          )}

          <div className="mc-row">
            <Button
              tone="danger"
              testId="flip-passive"
              disabled={flip.isPending || row.status !== 'active'}
              onClick={() => {
                flip.mutate('passive');
              }}
            >
              Suspend (passive)
            </Button>
            <Button
              tone="primary"
              testId="flip-active"
              disabled={flip.isPending || row.status !== 'passive'}
              onClick={() => {
                flip.mutate('active');
              }}
            >
              Restore (active)
            </Button>
            {flip.isPending ? <span className="mc-muted">saving...</span> : null}
          </div>

          <p className="mc-muted">
            A dedicated instance polls for this, so its box follows within one poll interval. We
            never push to it.
          </p>
        </Card>

        <Card title="Entitlements">
          <p className="mc-muted">
            Features are gated by the licence, never by a build (CC3). There is one image and one
            code path; what a tenant may do is a row here.
          </p>
          <dl className="mc-defs">
            <dt>“Powered by” mark</dt>
            <dd data-testid="powered-by-state">{whiteLabel ? 'removed' : 'shown'}</dd>
          </dl>
          <div className="mc-row">
            <Button
              testId="toggle-white-label"
              disabled={entitle.isPending || row.licence === null}
              onClick={() => {
                entitle.mutate({ ...Object.fromEntries(entitlements), whiteLabel: !whiteLabel });
              }}
            >
              {whiteLabel ? 'Show the mark' : 'Remove the mark (white label)'}
            </Button>
            {entitle.isPending ? <span className="mc-muted">saving...</span> : null}
          </div>
          {entitle.isError ? <Banner tone="danger">{(entitle.error as Error).message}</Banner> : null}
        </Card>

        <Card title="Installation">
          {row.installation === null ? (
            <EmptyState>
              {row.tier === 'dedicated'
                ? 'No instance has registered yet.'
                : 'Pooled — this tenant runs on our infrastructure.'}
            </EmptyState>
          ) : (
            <dl className="mc-defs">
              <dt>Version</dt>
              <dd className="mc-mono" data-testid="installation-version">
                {row.installation.version ?? '--'}
              </dd>
              <dt>Last seen</dt>
              <dd data-testid="installation-last-seen">
                {formatAge(row.installation.lastSeenAt)}
                <span className="mc-muted mc-mono">
                  {' '}
                  {formatInstant(row.installation.lastSeenAt)}
                </span>
              </dd>
              <dt>Products</dt>
              <dd className="mc-mono">{row.installation.productCount}</dd>
              <dt>Orders</dt>
              <dd className="mc-mono">{row.installation.orderCount}</dd>
              <dt>Installation</dt>
              <dd className="mc-mono">{row.installation.id}</dd>
            </dl>
          )}
          <p className="mc-muted">
            Reported by a machine whose owner has root. Telemetry, never metering.
          </p>
        </Card>
      </div>
    </>
  );
}
