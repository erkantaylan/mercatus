/**
 * Writes the running topology's addresses to a file, because after task "dynamic ports" there is
 * no table of literals to read them off.
 *
 * Every service endpoint in both AppHosts is Aspire-assigned now, so nothing outside the
 * application model can know where anything is. Three consumers need to: the e2e suite, the
 * traefik config generator beside this file, and a human who wants to open the storefront. Each
 * AppHost runs this once its endpoints are allocated and writes ONE file; the suite merges them.
 *
 * Input is the environment, not argv: the AppHost hands each address over as MERCATUS_EP_<key>,
 * which is the only shape a ReferenceExpression can be passed in. Keys are lower-cased and the
 * underscores kept, so MERCATUS_EP_STORE_POOLED lands as `store_pooled`.
 *
 *   MERCATUS_MANIFEST_OUT     where to write, relative to this process's cwd
 *   MERCATUS_MANIFEST_TENANT  optional: the tenant this whole file belongs to
 *   MERCATUS_EP_*             one per endpoint
 *
 * `MERCATUS_MANIFEST_TENANT` is what makes a file an INSTANCE's half rather than the control
 * plane's (v2.0.0 phase 2). A dedicated AppHost writes `.stack/apphost-{slug}.json` with unqualified
 * keys -- `store`, `storefront`, `dashboard` -- and names the tenant once, here, so that N of them
 * can exist side by side without every key having to carry the slug and every reader having to
 * parse it back out. AppHost A writes no tenant, because it is not one.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const out = process.env.MERCATUS_MANIFEST_OUT;
if (!out) {
  console.error('MERCATUS_MANIFEST_OUT is not set -- nothing to write.');
  process.exit(1);
}

const PREFIX = 'MERCATUS_EP_';
const endpoints = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key, value]) => key.startsWith(PREFIX) && typeof value === 'string' && value.length > 0)
    .map(([key, value]) => [key.slice(PREFIX.length).toLowerCase(), value.replace(/\/$/, '')])
    .sort(([a], [b]) => a.localeCompare(b)),
);

if (Object.keys(endpoints).length === 0) {
  console.error(`No ${PREFIX}* variables in the environment -- refusing to write an empty manifest.`);
  process.exit(1);
}

const tenant = process.env.MERCATUS_MANIFEST_TENANT;

const path = resolve(process.cwd(), out);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(
  path,
  `${JSON.stringify(
    { writtenAt: new Date().toISOString(), ...(tenant ? { tenant } : {}), endpoints },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${path}${tenant ? ` (tenant ${tenant})` : ''}`);
for (const [name, url] of Object.entries(endpoints)) console.log(`  ${name.padEnd(22)} ${url}`);
