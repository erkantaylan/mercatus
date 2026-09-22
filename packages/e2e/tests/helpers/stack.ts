/**
 * The running topology, as the suite needs to talk to it.
 *
 * Everything here is HTTP or `/proc`. Nothing imports a workspace package: this suite drives the
 * stack the way an operator does, so a shared helper that happened to bypass the wire would be
 * testing the helper.
 *
 * Ports are BUILD-PLAN §8.1 and the README's table, restated once (a constant that drifts is worse
 * than a literal that does not).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENDPOINTS = {
  /** AppHost A -- the control plane and the pooled data plane. */
  platform: 'http://127.0.0.1:4001',
  storePooled: 'http://127.0.0.1:4002',
  bank: 'http://127.0.0.1:4004',
  storefront: 'http://127.0.0.1:3001',
  dashboard: 'http://127.0.0.1:5173',
  admin: 'http://127.0.0.1:5174',
  edge: 'http://127.0.0.1:8080',
  /** AppHost B -- "Zenith's VPS". Optional: the suite skips its spec when B is not up. */
  storeDedicated: 'http://127.0.0.1:4003',
  storefrontDedicated: 'http://127.0.0.1:3002',
  dashboardDedicated: 'http://127.0.0.1:5175',
} as const;

export const PLATFORM_PORT = 4001;

/**
 * Where a hand-relaunched control plane records its pid.
 *
 * A process this suite starts is NOT Aspire-managed, so `aspire stop` will not take it down and
 * port 4001 stays held after the topology is gone. One file and one printed line is cheaper than
 * an orphan nobody can name.
 */
const RELAUNCH_PID_FILE = fileURLToPath(new URL('../../../../test-results/relaunched-platform.pid', import.meta.url));

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
  return {
    pid,
    argv: nul(`/proc/${String(pid)}/cmdline`),
    // `/proc/<pid>/cwd` is a SYMLINK to a directory -- reading it is EISDIR, not a path.
    cwd: readlinkSync(`/proc/${String(pid)}/cwd`),
    env,
  };
}

export function stopProcess(pid: number): void {
  process.kill(pid, 'SIGTERM');
}

/** Relaunch exactly what was captured, detached, so it outlives the test worker. */
export function relaunch(captured: CapturedProcess): number {
  const [command, ...args] = captured.argv;
  if (command === undefined) throw new Error('nothing to relaunch: empty argv');
  const child = spawn(command, args, {
    cwd: captured.cwd,
    env: { ...captured.env },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  if (child.pid === undefined) throw new Error('relaunch did not produce a pid');
  mkdirSync(fileURLToPath(new URL('../../../../test-results/', import.meta.url)), { recursive: true });
  writeFileSync(RELAUNCH_PID_FILE, `${String(child.pid)}\n`);
  return child.pid;
}
