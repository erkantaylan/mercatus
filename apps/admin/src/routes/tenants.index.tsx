/**
 * Every tenant, across both planes (BUILD-PLAN §7.4).
 *
 * The last two columns are why this screen exists in the shape it does: a POOLED tenant's numbers
 * are ours to measure, and a DEDICATED tenant's are whatever its box last reported. The table
 * says which it is looking at rather than pretending one number means the same thing in both
 * columns (CL1, CE3).
 */
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { listTenants } from '../api/client.js';
import type { TenantSummary } from '../api/schemas.js';
import { formatAge } from '../ui/format.js';
import { Banner, Card, EmptyState, PageHeader, StatusPill } from '../ui/index.js';

function HeartbeatCell(props: { tenant: TenantSummary }): ReactNode {
  const { tier, installation } = props.tenant;
  if (tier !== 'dedicated') return <span className="mc-muted">pooled &mdash; we measure it</span>;
  if (!installation) return <span className="mc-muted">not installed yet</span>;
  return (
    <span>
      <span className="mc-mono">{installation.version ?? '--'}</span>{' '}
      <span className="mc-muted">&middot; {formatAge(installation.lastSeenAt)}</span>
    </span>
  );
}

export function TenantsPage(): ReactNode {
  const tenants = useQuery({ queryKey: ['tenants'], queryFn: listTenants });

  return (
    <>
      <PageHeader
        title="Tenants"
        subtitle="Both planes. A dedicated tenant's version and last-seen come from its heartbeat, never from us reaching in."
      />

      {tenants.isError ? (
        <Banner tone="danger">{(tenants.error as Error).message}</Banner>
      ) : null}

      <Card
        title={
          <>
            <span>All tenants</span>
            <span className="mc-muted mc-mono">{tenants.data?.total ?? 0}</span>
          </>
        }
      >
        {tenants.isPending ? (
          <EmptyState>Loading...</EmptyState>
        ) : tenants.data && tenants.data.items.length > 0 ? (
          <table className="mc-table">
            <thead>
              <tr>
                <th>Store</th>
                <th>Tier</th>
                <th>Status</th>
                <th>Licence</th>
                <th>Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {tenants.data.items.map((tenant) => (
                <tr key={tenant.id} data-testid={`tenant-row-${tenant.slug}`}>
                  <td>
                    <Link to="/tenants/$slug" params={{ slug: tenant.slug }}>
                      {tenant.name}
                    </Link>
                    <div className="mc-muted mc-mono">{tenant.slug}</div>
                  </td>
                  <td>{tenant.tier}</td>
                  <td>
                    <StatusPill value={tenant.status} testId={`tenant-status-${tenant.slug}`} />
                  </td>
                  <td>
                    {tenant.licence ? (
                      <>
                        <StatusPill value={tenant.licence.status} />
                        <div className="mc-muted mc-mono">to {tenant.licence.validUntil}</div>
                      </>
                    ) : (
                      <span className="mc-muted">none issued</span>
                    )}
                  </td>
                  <td>
                    <HeartbeatCell tenant={tenant} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No tenants yet. One arrives when somebody buys a store.</EmptyState>
        )}
      </Card>
    </>
  );
}
