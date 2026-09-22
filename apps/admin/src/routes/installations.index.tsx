/**
 * Registered dedicated instances (BUILD-PLAN §7.4, CE6).
 *
 * Every row is a box on someone else's server. We know what it is because it TOLD us on its last
 * heartbeat -- version, licence id and two counts -- and version skew is invisible until you can
 * query it. Nothing on this screen was obtained by reaching into their network, and there is no
 * action here that could: provisioning hands out a one-time bootstrap token and the instance does
 * the rest, outbound only (CE4, CE7).
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { listInstallations } from '../api/client.js';
import { formatAge, formatInstant } from '../ui/format.js';
import { Banner, Card, EmptyState, PageHeader } from '../ui/index.js';

/** Over a minute without a word is worth looking at when the demo polls every ten seconds. */
const STALE_AFTER_MS = 60_000;

export function InstallationsPage(): ReactNode {
  const installations = useQuery({ queryKey: ['installations'], queryFn: listInstallations });

  return (
    <>
      <PageHeader
        title="Installations"
        subtitle="Dedicated instances, and what each last reported. Pulled from their heartbeat — we never call in."
      />

      {installations.isError ? (
        <Banner tone="danger">{(installations.error as Error).message}</Banner>
      ) : null}

      <Card
        title={
          <>
            <span>Registered instances</span>
            <span className="mc-muted mc-mono">{installations.data?.total ?? 0}</span>
          </>
        }
      >
        {installations.isPending ? (
          <EmptyState>Loading...</EmptyState>
        ) : installations.data && installations.data.items.length > 0 ? (
          <table className="mc-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Version</th>
                <th>Last seen</th>
                <th>Products</th>
                <th>Orders</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {installations.data.items.map((installation) => {
                const lastSeen = installation.lastSeenAt
                  ? new Date(installation.lastSeenAt).getTime()
                  : 0;
                const stale = Date.now() - lastSeen > STALE_AFTER_MS;
                return (
                  <tr key={installation.id} data-testid={`installation-row-${installation.tenantSlug}`}>
                    <td>
                      <Link to="/tenants/$slug" params={{ slug: installation.tenantSlug }}>
                        {installation.tenantSlug}
                      </Link>
                    </td>
                    <td className="mc-mono">{installation.version ?? '--'}</td>
                    <td className={stale ? 'mc-muted' : undefined}>
                      {formatAge(installation.lastSeenAt)}
                    </td>
                    <td className="mc-mono">{installation.productCount}</td>
                    <td className="mc-mono">{installation.orderCount}</td>
                    <td className="mc-muted">{formatInstant(installation.registeredAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <EmptyState>
            No instance has registered. One appears after an operator issues a bootstrap token and
            the box presents it.
          </EmptyState>
        )}
      </Card>
    </>
  );
}
