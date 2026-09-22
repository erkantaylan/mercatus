/**
 * Refuse to run against a stack that is not up, and say which command is missing.
 *
 * Thirty tests failing on `net::ERR_CONNECTION_REFUSED` is a worse bug report than one sentence
 * naming the `aspire run` that was not issued. AppHost B is OPTIONAL -- its spec skips itself when
 * the dedicated instance is not there -- so B's absence is reported and not fatal.
 */
import { DEDICATED, ENDPOINTS, EXPECTED_DEDICATED, probe } from './stack.js';

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
 * The dedicated instances this run PROMISED, and the three surfaces each of them owes.
 *
 * `MERCATUS_E2E_DEDICATED` defaults to `zenith,orion` -- the topology the acceptance list asks
 * for. An instance named there that is not answering fails the whole run here, before a browser
 * opens, with the command that starts it. It used to be optional on both ends: the suite probed
 * whatever happened to be running and every phase-3 test skipped itself when something was not,
 * so the one-box loop reported green having proved nothing about two dedicated tenants.
 */
const EXPECTED: readonly Requirement[] = EXPECTED_DEDICATED.flatMap((slug) => {
  const instance = DEDICATED[slug];
  const base = instance ?? { slug, store: '', storefront: '', dashboard: '' };
  return [
    { name: `api-store-tenant-${slug}`, url: base.store, path: '/health' },
    { name: `web-storefront-tenant-${slug}`, url: base.storefront, path: `/t/${slug}` },
    { name: `web-dashboard-tenant-${slug}`, url: base.dashboard, path: '/' },
  ];
});

/** Anything else that happens to be up. Reported, never required. */
const OPTIONAL: readonly Requirement[] = Object.values(DEDICATED)
  .filter((instance) => !EXPECTED_DEDICATED.includes(instance.slug))
  .flatMap((instance) => [
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

  // The promised instances. An address no instance published is that instance being DOWN, and
  // this run said it would be up -- so it is a failure here rather than six quiet skips later.
  const expected = await Promise.all(
    EXPECTED.map((r) => (r.url === '' ? Promise.resolve({ ok: false, status: null }) : probe(r.url, r.path))),
  );
  const absent = EXPECTED.flatMap((requirement, index) =>
    expected[index]?.ok === true
      ? []
      : [`${requirement.name} (${requirement.url === '' ? 'no address published' : requirement.url + requirement.path})`],
  );
  if (absent.length > 0) {
    throw new Error(
      [
        `This run expects the dedicated instances: ${EXPECTED_DEDICATED.join(', ')}.`,
        'Not answering:',
        ...absent.map((line) => `  - ${line}`),
        '',
        'Start each one with:',
        ...EXPECTED_DEDICATED.map((slug) => `  aspire/scripts/run-dedicated.sh ${slug}`),
        '',
        'Or say what this run is actually claiming, which then appears in the suite output:',
        '  MERCATUS_E2E_DEDICATED=zenith pnpm test:e2e',
      ].join('\n'),
    );
  }

  const extra = await Promise.all(
    OPTIONAL.map((r) => (r.url === '' ? Promise.resolve({ ok: false, status: null }) : probe(r.url, r.path))),
  );
  const alsoUp = OPTIONAL.filter((_, index) => extra[index]?.ok).map((r) => r.name);

  process.stdout.write(
    `\nAppHost A is up, and so is every dedicated instance this run claims ` +
      `(${EXPECTED_DEDICATED.join(', ') || 'none'}).` +
      (alsoUp.length === 0 ? '' : ` Also running, unclaimed: ${alsoUp.join(', ')}.`) +
      '\n\n',
  );
}
