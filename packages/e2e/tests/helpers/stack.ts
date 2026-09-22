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
 * (aspire/scripts/write-stack-manifest.mjs) and this merges the two. B's half is optional, exactly
 * as B itself always was: its absence is what makes the dedicated-instance spec skip.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STACK_DIR = fileURLToPath(new URL('../../../../.stack/', import.meta.url));

interface Manifest {
  readonly writtenAt: string;
  readonly endpoints: Readonly<Record<string, string>>;
}

/**
 * One AppHost's half of the address book, or `{}` when it has not written one.
 *
 * A missing file is a stack that is down, which global-setup reports in a sentence. A malformed
 * one is a bug worth seeing, so it is not swallowed.
 */
function readManifest(name: string): Readonly<Record<string, string>> {
  const path = `${STACK_DIR}${name}.json`;
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  return parsed.endpoints;
}

const manifest = { ...readManifest('apphost-a'), ...readManifest('apphost-b') };

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
  /** AppHost B -- "Zenith's VPS". Optional: the suite skips its spec when B is not up. */
  storeDedicated: endpoint('storeDedicated'),
  storefrontDedicated: endpoint('storefrontDedicated'),
  dashboardDedicated: endpoint('dashboardDedicated'),
} as const;

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

export async function staffOrderCount(storeApi: string, slug: string): Promise<number> {
  const token = await staffToken(storeApi, slug);
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
