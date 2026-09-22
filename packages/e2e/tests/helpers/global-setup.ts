/**
 * Refuse to run against a stack that is not up, and say which command is missing.
 *
 * Thirty tests failing on `net::ERR_CONNECTION_REFUSED` is a worse bug report than one sentence
 * naming the `aspire run` that was not issued. AppHost B is OPTIONAL -- its spec skips itself when
 * the dedicated instance is not there -- so B's absence is reported and not fatal.
 */
import { ENDPOINTS, probe } from './stack.js';

interface Requirement {
  readonly name: string;
  readonly url: string;
  readonly path: string;
}

const REQUIRED: readonly Requirement[] = [
  { name: 'platform (control plane)', url: ENDPOINTS.platform, path: '/health' },
  { name: 'api-store-pooled', url: ENDPOINTS.storePooled, path: '/health' },
  { name: 'fake-bank', url: ENDPOINTS.bank, path: '/health' },
  { name: 'traefik (the edge)', url: ENDPOINTS.edge, path: '/health' },
  { name: 'storefront (pooled)', url: ENDPOINTS.storefront, path: '/t/acme' },
  { name: 'dashboard (pooled)', url: ENDPOINTS.dashboard, path: '/' },
  { name: 'admin (platform console)', url: ENDPOINTS.admin, path: '/' },
];

const OPTIONAL: readonly Requirement[] = [
  { name: 'store-zenith (dedicated)', url: ENDPOINTS.storeDedicated, path: '/health' },
  { name: 'web-storefront-tenant-zenith', url: ENDPOINTS.storefrontDedicated, path: '/t/zenith' },
  { name: 'web-dashboard-tenant-zenith', url: ENDPOINTS.dashboardDedicated, path: '/' },
];

const WAIT_MS = 90_000;
const INTERVAL_MS = 2000;

async function waitForAll(): Promise<string[]> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const results = await Promise.all(REQUIRED.map((r) => probe(r.url, r.path)));
    // flatMap over the ORIGINAL array: a filter-then-map would renumber the index and report
    // each failure with somebody else's status.
    const missing = REQUIRED.flatMap((requirement, index) => {
      const result = results[index];
      if (result?.ok === true) return [];
      const status = result?.status;
      const seen = status === null || status === undefined ? 'unreachable' : `HTTP ${String(status)}`;
      return [`${requirement.name} (${requirement.url}${requirement.path}) -> ${seen}`];
    });
    if (missing.length === 0) return [];
    if (Date.now() >= deadline) return missing;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

export default async function globalSetup(): Promise<void> {
  // No address book at all means no AppHost has come up and written one. Probing ten empty URLs
  // for ninety seconds to reach the same conclusion wastes a minute and reports it as ten
  // unrelated failures.
  const unknown = REQUIRED.filter((requirement) => requirement.url === '').map((r) => r.name);
  if (unknown.length > 0) {
    throw new Error(
      [
        'No running stack found: .stack/apphost-a.json was not written, so nothing is up.',
        '',
        '  cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json',
        '  cd aspire/AppHostB && aspire run --detach --non-interactive --nologo --format Json',
        '',
        `Without an address for: ${unknown.join(', ')}.`,
      ].join('\n'),
    );
  }

  const missing = await waitForAll();
  if (missing.length > 0) {
    throw new Error(
      [
        'The stack is not up. AppHost A must be running before `pnpm test:e2e`:',
        '',
        '  cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json',
        '  cd aspire/AppHostB && aspire run --detach --non-interactive --nologo --format Json',
        '',
        'Not answering:',
        ...missing.map((line) => `  - ${line}`),
      ].join('\n'),
    );
  }

  // An address B never published is B being down, not a probe worth making.
  const optional = await Promise.all(OPTIONAL.map((r) => (r.url === '' ? { ok: false, status: null } : probe(r.url, r.path))));
  const down = OPTIONAL.filter((_, index) => !optional[index]?.ok).map((r) => r.name);
  process.stdout.write(
    down.length === 0
      ? '\nAppHost A and AppHost B are both up. The dedicated-instance spec will run.\n\n'
      : `\nAppHost A is up. AppHost B is NOT (${down.join(', ')}) -- its spec will skip.\n\n`,
  );
}
