/**
 * Refuse to run against a stack that is not up, and say which command is missing.
 *
 * Thirty tests failing on `net::ERR_CONNECTION_REFUSED` is a worse bug report than one sentence
 * naming the `aspire run` that was not issued. AppHost B is OPTIONAL -- its spec skips itself when
 * the dedicated instance is not there -- so B's absence is reported and not fatal.
 */
import { DEDICATED, ENDPOINTS, probe } from './stack.js';

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

/**
 * Whatever dedicated instances published an address book this run, named after their own tenant.
 *
 * Nothing here is a list of tenants we expect. One AppHost B serves any tenant by
 * MERCATUS_TENANT_SLUG, so the question "is the dedicated instance up" became "which ones are",
 * and the answer is read off `.stack/` rather than written down (v2.0.0 phase 2).
 */
const OPTIONAL: readonly Requirement[] = Object.values(DEDICATED).flatMap((instance) => [
  { name: `api-store-tenant-${instance.slug}`, url: instance.store, path: '/health' },
  {
    name: `web-storefront-tenant-${instance.slug}`,
    url: instance.storefront,
    path: `/t/${instance.slug}`,
  },
  { name: `web-dashboard-tenant-${instance.slug}`, url: instance.dashboard, path: '/' },
]);

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

  // An address no instance published is that instance being down, not a probe worth making.
  const optional = await Promise.all(OPTIONAL.map((r) => (r.url === '' ? { ok: false, status: null } : probe(r.url, r.path))));
  const down = OPTIONAL.filter((_, index) => !optional[index]?.ok).map((r) => r.name);
  const slugs = Object.keys(DEDICATED);
  if (slugs.length === 0) {
    process.stdout.write(
      '\nAppHost A is up. No dedicated instance published an address book ' +
        '(.stack/apphost-<slug>.json) -- the dedicated specs will skip.\n\n',
    );
  } else {
    process.stdout.write(
      down.length === 0
        ? `\nAppHost A is up, and so is every dedicated instance (${slugs.join(', ')}). ` +
            'The dedicated-instance specs will run.\n\n'
        : `\nAppHost A is up. Dedicated instances found: ${slugs.join(', ')}, but not answering: ` +
            `${down.join(', ')} -- those specs will skip.\n\n`,
    );
  }
}
