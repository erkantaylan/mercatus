/**
 * The running topology, as the suite needs to talk to it.
 *
 * Everything here is HTTP or `/proc`. Nothing imports a workspace package: this suite drives the
 * stack the way an operator does, so a shared helper that happened to bypass the wire would be
 * testing the helper.
 *
 * Addresses are READ, not declared. Every service port is Aspire-assigned now, so the table that
 * used to live here -- BUILD-PLAN §8.1 restated once -- would name ports nothing is listening on.
 * Each AppHost writes its half of the address book to `.stack/` as it comes up
 * (aspire/scripts/write-stack-manifest.mjs) and this reads WHATEVER IS THERE.
 *
 * Whatever is there, by glob, because since v2.0.0 there is no longer "the" dedicated instance to
 * call `apphost-b.json`. One AppHost B serves any tenant by MERCATUS_TENANT_SLUG and writes
 * `.stack/apphost-{slug}.json`, naming its tenant inside the file. So: files with a `tenant` are
 * instances, keyed by slug; files without one are the control plane and are merged flat. An
 * instance that is not running has no file, which is what makes its specs skip -- exactly as B's
 * absence always did.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STACK_DIR = fileURLToPath(new URL('../../../../.stack/', import.meta.url));

interface Manifest {
  readonly writtenAt: string;
  /** Present only on a dedicated instance's half. Its absence is what makes a file the control plane's. */
  readonly tenant?: string;
  readonly endpoints: Readonly<Record<string, string>>;
}

/**
 * Every `.stack/apphost-*.json` on disk.
 *
 * A missing directory is a stack that is down, which global-setup reports in a sentence. A
 * malformed file is a bug worth seeing, so it is not swallowed.
 */
function readManifests(): readonly Manifest[] {
  if (!existsSync(STACK_DIR)) return [];
  return readdirSync(STACK_DIR)
    .filter((name) => /^apphost-.+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(`${STACK_DIR}${name}`, 'utf8')) as Manifest);
}

const manifests = readManifests();

/** The control plane's half: every manifest that is not an instance's, merged. */
const manifest: Readonly<Record<string, string>> = Object.assign(
  {},
  ...manifests.filter((m) => m.tenant === undefined).map((m) => m.endpoints),
) as Readonly<Record<string, string>>;

/**
 * `MERCATUS_EP_STORE_POOLED` was written as `store_pooled`; the suite has always called it
 * `storePooled`. One camel-casing here beats renaming the key at both ends.
 */
function endpoint(key: string): string {
  return manifest[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] ?? '';
}

export const ENDPOINTS = {
  /** AppHost A -- the control plane and the pooled data plane. */
  platform: endpoint('platform'),
  storePooled: endpoint('storePooled'),
  bank: endpoint('bank'),
  storefront: endpoint('storefront'),
  dashboard: endpoint('dashboard'),
  admin: endpoint('admin'),
  edge: endpoint('edge'),
  /** The issuer, for the one thing a suite legitimately asks of it: end this browser's session. */
  logto: endpoint('logto'),
} as const;

/**
 * One dedicated instance's three surfaces. The same three every AppHost B publishes, whatever
 * tenant it was started for.
 */
export interface DedicatedEndpoints {
  readonly slug: string;
  readonly store: string;
  readonly storefront: string;
  readonly dashboard: string;
}

/**
 * Every dedicated instance that is currently publishing an address book, by slug.
 *
 * Empty when no AppHost B is running, which is the everyday loop and not a failure: the specs
 * that need one skip themselves. A second entry appears the moment a second AppHost B runs with
 * another MERCATUS_TENANT_SLUG -- no key here, and no key in the manifest, names a tenant.
 */
export const DEDICATED: Readonly<Record<string, DedicatedEndpoints>> = Object.fromEntries(
  manifests
    .filter((m): m is Manifest & { tenant: string } => typeof m.tenant === 'string')
    .map((m) => [
      m.tenant,
      {
        slug: m.tenant,
        // Taken exactly as published. AppHost B publishes `<slug>.localtest.me:<port>` for all
        // three surfaces, because cookies are scoped by host and IGNORE THE PORT -- three boxes
        // on `localhost` are one cookie jar, and the second sign-in destroys the first one's
        // session (lessons/17). This helper used to rewrite the hostname on the way in; since the
        // browser-facing addresses are also REGISTERED REDIRECT URIs, a rewrite here would send
        // the shopper somewhere the issuer was never told about. The AppHost publishes the truth.
        store: m.endpoints['store'] ?? '',
        storefront: m.endpoints['storefront'] ?? '',
        dashboard: m.endpoints['dashboard'] ?? '',
      },
    ]),
);

/** The instance serving this tenant, or null when it is not running. */
export function dedicated(slug: string): DedicatedEndpoints | null {
  return DEDICATED[slug] ?? null;
}

/**
 * WHICH DEDICATED INSTANCES THIS RUN IS CLAIMING TO PROVE. Two, unless you say otherwise.
 *
 * This exists because a skip is not a pass and the suite used to treat it as one: every test in
 * `04-two-dedicated-tenants.spec.ts` began `test.skip(!bothUp, ...)`, so the everyday loop -- one
 * AppHost B, zenith only -- reported green having proved nothing at all about two dedicated
 * tenants, one shopper across four stores, four isolated dashboards or both boxes surviving an
 * outage. The headline check could not fail. That is the same hole BL1 names one level down.
 *
 * So the expectation is now DECLARED and checked in global setup: an instance named here that is
 * not answering fails the run, with the command that starts it. Narrowing it is an explicit act
 * that appears in the shell history and in the suite's own output:
 *
 *   MERCATUS_E2E_DEDICATED=zenith pnpm test:e2e     # the one-box loop, and 04 says it skipped why
 *   MERCATUS_E2E_DEDICATED= pnpm test:e2e           # pooled only; 03 and 04 both skip, loudly
 */
export const EXPECTED_DEDICATED: readonly string[] = (
  process.env['MERCATUS_E2E_DEDICATED'] ?? 'zenith,orion'
)
  .split(',')
  .map((slug) => slug.trim())
  .filter((slug) => slug !== '');

/** True when this run promised that instance. A promise not kept is a failure, never a skip. */
export function expectsDedicated(slug: string): boolean {
  return EXPECTED_DEDICATED.includes(slug);
}

/** The sentence a spec prints when it skips, so a skip always names the choice that caused it. */
export function notExpectedReason(slugs: readonly string[]): string {
  return (
    `MERCATUS_E2E_DEDICATED=${EXPECTED_DEDICATED.join(',') || '(empty)'} does not include ` +
    `${slugs.join(' and ')}, so this run is not claiming that. ` +
    'Drop the variable to demand every dedicated instance the acceptance list names.'
  );
}

/**
 * The port the control plane was allocated this run.
 *
 * `03-dedicated-outage.spec.ts` kills the platform PROCESS rather than the AppHost, and finds it
 * by the port it is listening on -- so this has to be the live number, not a constant.
 */
export const PLATFORM_PORT = Number(new URL(ENDPOINTS.platform || 'http://127.0.0.1:0').port);

/**
 * Where a hand-relaunched control plane records its pid, and the wrapper that makes it mortal.
 *
 * A process this suite starts is not Aspire-managed, so `aspire stop` used to report success and
 * leave it holding port 4001 -- still answering /health with 200 while the Postgres it needs had
 * been destroyed with the AppHost. It is now started under `supervised-relaunch.mjs`, which
 * watches the pid that owned the original process (DCP) and terminates the child when that goes
 * away. The pid file stays, because a named process is still cheaper to reason about than an
 * anonymous one.
 */
const RELAUNCH_PID_FILE = fileURLToPath(new URL('../../../../test-results/relaunched-platform.pid', import.meta.url));
const SUPERVISOR = fileURLToPath(new URL('./supervised-relaunch.mjs', import.meta.url));

/** The seeded pooled tenants (packages/db-store/src/seed.ts) and the dedicated one. */
export const TENANTS = {
  acme: { slug: 'acme', name: 'Acme Supply' },
  borg: { slug: 'borg', name: 'Borg Outfitters' },
  zenith: { slug: 'zenith', name: 'Zenith Tools' },
} as const;

export interface ProbeResult {
  readonly ok: boolean;
  readonly status: number | null;
}

/**
 * One request, short timeout, never throws. `null` status means it could not be reached at all.
 *
 * The accept header is a wildcard, deliberately. A Vite dev server's history fallback only
 * rewrites `/` to index.html for a request that accepts text/html -- an `application/json`
 * probe gets a 404 from a server that is perfectly healthy, and the readiness check then waits
 * out its whole timeout on a stack that is up.
 */
export async function probe(url: string, path = '/health'): Promise<ProbeResult> {
  try {
    const response = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: '*/*' },
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: null };
  }
}

export async function reachable(url: string, path = '/health'): Promise<boolean> {
  return (await probe(url, path)).ok;
}

/**
 * WHICH ISSUER A STORE IS REALLY TALKING TO, asked of the store rather than of an environment
 * variable this process happens to hold.
 *
 * `/auth/login` is a 302 under both adapters and where it points is the answer: the store's own
 * `/dev/login` page under `stub`, `/oidc/auth` on Logto under `oidc`. It stays right if the
 * adapter is switched without restarting this suite's shell.
 */
export async function adapterOf(storeApi: string): Promise<'stub' | 'oidc' | 'unknown'> {
  const response = await fetch(`${storeApi}/auth/login?audience=shopper&via=store&next=%2F`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const location = response?.headers.get('location') ?? '';
  if (location.includes('/dev/login')) return 'stub';
  if (location.includes('/oidc/auth')) return 'oidc';
  return 'unknown';
}

/**
 * Why a stub-only spec is not running, or `''` when it is.
 *
 * `01` through `04` mint a FRESH shopper per run so that "this person has one order at this
 * store" stays true on the tenth run as well as the first. Under a real issuer that person would
 * have to be created at the issuer per run, through the Management API, which is a credential
 * this suite has no business holding. `05-oidc-four-tenants.spec.ts` covers the same ground on
 * `oidc` with the seeded account and assertions that are deltas rather than absolutes.
 *
 * So: two runs, and each one says which it is. A skip here always names the reason.
 */
export async function stubOnlyReason(storeApi: string): Promise<string> {
  const adapter = await adapterOf(storeApi);
  return adapter === 'oidc'
    ? 'this stack is on AUTH_ADAPTER=oidc; the fresh-shopper-per-run specs are the stub demo. ' +
        'The same four-tenant demo on a real issuer is tests/05-oidc-four-tenants.spec.ts.'
    : '';
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/json', ...init?.headers },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${String(response.status)}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

// ---------------------------------------------------------------------------------------------
// The control plane, as the platform console uses it
// ---------------------------------------------------------------------------------------------

/** An operator token (`aud: operator`). A merchant's staff token is a different audience (BH1). */
export async function operatorToken(): Promise<string> {
  const { accessToken } = await json<{ accessToken: string }>(
    `${ENDPOINTS.platform}/dev/login/operator`,
    { method: 'POST', body: JSON.stringify({ subject: 'e2e' }) },
  );
  return accessToken;
}

/** Flip a tenant between `active` and `passive` -- what the console's button does (CG3). */
export async function setTenantLicence(slug: string, status: 'active' | 'passive'): Promise<void> {
  const token = await operatorToken();
  await json(`${ENDPOINTS.platform}/tenants/${slug}/licence`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ status }),
  });
}

// ---------------------------------------------------------------------------------------------
// A data plane, as its own dashboard and storefront see it
// ---------------------------------------------------------------------------------------------

export async function staffToken(storeApi: string, slug: string, role = 'owner'): Promise<string> {
  const { accessToken } = await json<{ accessToken: string }>(`${storeApi}/dev/login/staff`, {
    method: 'POST',
    body: JSON.stringify({ slug, role }),
  });
  return accessToken;
}

export interface LicenceView {
  readonly status: 'active' | 'passive';
  readonly state: 'healthy' | 'passive' | 'grace' | 'read_only';
  readonly lastSuccessAt: string | null;
}

/** What the store itself believes: the merchant's status, and our reachability, never collapsed. */
export async function licenceView(storeApi: string, slug: string): Promise<LicenceView> {
  const token = await staffToken(storeApi, slug);
  return json<LicenceView>(`${storeApi}/api/licence`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** What a SHOPPER is told, which is the other half of CG3: open / blocked_passive / blocked_unreachable. */
export async function shopperCheckoutState(storeApi: string, slug: string): Promise<string> {
  const branding = await json<{ licence: { checkout: string } }>(`${storeApi}/t/${slug}/branding`);
  return branding.licence.checkout;
}

/**
 * Something this shop can actually sell, chosen at RUN TIME rather than written down.
 *
 * A seeded title is a literal that runs out. `01` buys one `Rocket Skates` every run, and the run
 * that takes the last one leaves every spec naming that title failing against a perfectly healthy
 * stack -- with no error worth reading, because `Add to basket` is simply not on the card any
 * more and the click loop just times out. A dedicated instance's catalogue is seeded by its own
 * install command, so its titles were never in any seed this suite could name anyway.
 */
export async function sellableProduct(storeApi: string, slug: string): Promise<string> {
  const { items } = await json<{ items: { title: string; stock: number }[] }>(
    `${storeApi}/t/${slug}/products`,
  );
  const sellable = items.find((item) => item.stock > 0);
  if (!sellable) throw new Error(`${slug} has nothing in stock at ${storeApi}`);
  return sellable.title;
}

export async function staffOrderCount(storeApi: string, slug: string): Promise<number> {
  return orderCountWithToken(storeApi, await staffToken(storeApi, slug));
}

/**
 * The same question, asked with a token the caller already has.
 *
 * `staffToken` above posts to `/dev/login/staff`, which exists only while `AUTH_ADAPTER=stub` --
 * so under a real issuer the suite asks with the token the MERCHANT's browser was given
 * (`dashboardToken` in helpers/shop.ts). Same route, same audience, different way in.
 */
export async function orderCountWithToken(storeApi: string, token: string): Promise<number> {
  const orders = await json<{ total: number }>(`${storeApi}/api/orders`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return orders.total;
}

// ---------------------------------------------------------------------------------------------
// Stopping and restarting the control plane
//
// `aspire stop` on AppHost A is the WRONG tool here: it destroys A's Postgres with it, so the
// rebuilt control plane has never heard of the installation a dedicated box registered, the
// instance token answers 401 and the store stays read_only for ever (lessons/10). Killing the
// Aspire-managed platform PROCESS produces an outage that can recover -- DCP does not restart it,
// and everything it needs to come back is in /proc.
// ---------------------------------------------------------------------------------------------

export interface CapturedProcess {
  readonly pid: number;
  /** Who owned it -- DCP, under the AppHost. The relaunched copy dies when this one does. */
  readonly ppid: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The listener on a port, via `ss`. `pkill -f` is not an option: the pattern matches this process. */
export function pidOnPort(port: number): number | null {
  let out: string;
  try {
    out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  for (const line of out.split('\n')) {
    if (!line.includes(`:${String(port)} `)) continue;
    const match = /pid=(\d+)/.exec(line);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

/** Everything needed to relaunch a process by hand: its argv, its cwd and its whole environment. */
export function captureProcess(pid: number): CapturedProcess {
  const nul = (path: string): string[] =>
    readFileSync(path, 'utf8').split('\0').filter((entry) => entry !== '');
  const env: Record<string, string> = {};
  for (const entry of nul(`/proc/${String(pid)}/environ`)) {
    const index = entry.indexOf('=');
    if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  const status = readFileSync(`/proc/${String(pid)}/status`, 'utf8');
  const ppid = Number(/^PPid:\s*(\d+)$/m.exec(status)?.[1] ?? '0');
  return {
    pid,
    ppid,
    argv: nul(`/proc/${String(pid)}/cmdline`),
    // `/proc/<pid>/cwd` is a SYMLINK to a directory -- reading it is EISDIR, not a path.
    cwd: readlinkSync(`/proc/${String(pid)}/cwd`),
    env,
  };
}

export function stopProcess(pid: number): void {
  process.kill(pid, 'SIGTERM');
}

/**
 * Relaunch exactly what was captured, detached, so it outlives the test worker -- and under a
 * supervisor, so it does NOT outlive the AppHost.
 *
 * `aspire stop` cannot reap a process it did not start. Rather than asking an operator to
 * remember a pid file, the child is started by `supervised-relaunch.mjs` with the original
 * process's parent (DCP) as its watch target: when the AppHost goes, so does this.
 */
export function relaunch(captured: CapturedProcess): number {
  const [command, ...args] = captured.argv;
  if (command === undefined) throw new Error('nothing to relaunch: empty argv');
  // Which pid to watch. Normally the captured process's parent -- DCP, under the AppHost. But on
  // a SECOND run of this suite the process on 4001 is already one of ours, and its parent is the
  // previous supervisor, which exits the moment its child is killed. Watching that would make the
  // relaunched control plane die about a second after it started, which is precisely how the
  // second run failed before this line existed. The watch target is inherited instead, so every
  // generation watches the same DCP.
  const watchPid = captured.env['MERCATUS_WATCH_PID'] ?? String(captured.ppid);
  const child = spawn(process.execPath, [SUPERVISOR, command, ...args], {
    cwd: captured.cwd,
    env: { ...captured.env, MERCATUS_WATCH_PID: watchPid },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (child.pid === undefined) throw new Error('relaunch did not produce a pid');
  mkdirSync(fileURLToPath(new URL('../../../../test-results/', import.meta.url)), { recursive: true });
  writeFileSync(RELAUNCH_PID_FILE, `${String(child.pid)}\n`);
  return child.pid;
}
