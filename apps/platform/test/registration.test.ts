/**
 * Registration against an issuer -- the half of v2.0.0 that `platform.test.ts` cannot reach.
 *
 * That suite runs with no Management API credential, so `oidc` is null in every installation case
 * and the redirect-URI machinery is exercised at registration and never verified. Four live
 * defects were found in exactly that gap, and each one has a test here:
 *
 *   - a reported URL was stored in the caller's own spelling, so `HTTP://LOCALHOST:1` was
 *     registered uppercase while the store sends lowercase and Logto matches strings
 *   - an instance that restarted on a new orchestrator-assigned port never re-reported it, and
 *     its login answered 400 at the issuer for ever after
 *   - deprovisioning one installation removed a redirect URI a DIFFERENT, still-serving
 *     installation needed, because the dashboard and storefront clients are shared
 *   - a shared PATCH that failed after the per-installation client existed lost its application
 *     id, leaving a confidential client with a live secret that nothing pointed at
 *
 * The issuer here is a real HTTP server speaking the Management API's shapes, not a mock of our
 * own client: the thing under test is what we send Logto, so a stub of the sending is a stub of
 * the test. It counts its own PATCHes, which is how idempotency is asserted rather than assumed.
 *
 *   pnpm --filter @mercatus/platform test
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { PlatformApp } from '../src/app.js';
import { buildPlatformApp } from '../src/app.js';
import type { BankClient } from '../src/bank.js';
import { loadPlatformConfig } from '../src/config.js';

/* ------------------------------------------------------------------ a Logto that can be read */

interface FakeApplication {
  id: string;
  name: string;
  type: string;
  oidcClientMetadata: { redirectUris: string[]; postLogoutRedirectUris: string[] };
}

/**
 * The Management API, small enough to read and honest about the three shapes that matter: a
 * client-credentials token, a list of applications, and a PATCH that REPLACES `redirectUris`
 * rather than appending to it (which is why every write of ours is a read-modify-write).
 */
class FakeLogto {
  readonly applications: FakeApplication[] = [];
  readonly organizations: { id: string; name: string }[] = [];
  /** PATCHes seen, by application name. Idempotency is a count, not a feeling. */
  readonly patches: Record<string, number> = {};
  /** Set to an application NAME to make its PATCH answer 500 -- the partial-failure case. */
  failPatchFor: string | null = null;
  #server = createServer((req, res) => void this.#handle(req, res));
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  seedApplication(name: string, redirectUris: string[], postLogoutRedirectUris: string[] = []): FakeApplication {
    const app: FakeApplication = {
      id: `app_${randomUUID().slice(0, 8)}`,
      name,
      type: 'Traditional',
      oidcClientMetadata: { redirectUris, postLogoutRedirectUris },
    };
    this.applications.push(app);
    return app;
  }

  byName(name: string): FakeApplication | undefined {
    return this.applications.find((a) => a.name === name);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    const path = url.pathname;
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const read = async (): Promise<Record<string, never>> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8');
      return text ? (JSON.parse(text) as Record<string, never>) : ({} as Record<string, never>);
    };

    if (path === '/oidc/token') {
      send(200, { access_token: 'fake-management-token', expires_in: 3600 });
      return;
    }
    if (path === '/api/applications' && req.method === 'GET') {
      send(200, this.applications);
      return;
    }
    if (path === '/api/applications' && req.method === 'POST') {
      const body = (await read()) as unknown as {
        name: string;
        type: string;
        oidcClientMetadata?: { redirectUris?: string[]; postLogoutRedirectUris?: string[] };
      };
      const created = this.seedApplication(
        body.name,
        body.oidcClientMetadata?.redirectUris ?? [],
        body.oidcClientMetadata?.postLogoutRedirectUris ?? [],
      );
      created.type = body.type;
      send(200, created);
      return;
    }
    if (path === '/api/organizations') {
      send(200, this.organizations);
      return;
    }
    const secrets = /^\/api\/applications\/([^/]+)\/secrets$/.exec(path);
    if (secrets) {
      send(200, [{ value: `secret-of-${secrets[1] ?? ''}` }]);
      return;
    }
    const one = /^\/api\/applications\/([^/]+)$/.exec(path);
    if (one) {
      const app = this.applications.find((a) => a.id === one[1]);
      if (!app) {
        send(404, { message: 'not found' });
        return;
      }
      if (req.method === 'DELETE') {
        this.applications.splice(this.applications.indexOf(app), 1);
        send(204, null);
        return;
      }
      if (req.method === 'PATCH') {
        this.patches[app.name] = (this.patches[app.name] ?? 0) + 1;
        if (this.failPatchFor === app.name) {
          send(500, { message: 'the issuer is having a bad afternoon' });
          return;
        }
        const body = (await read()) as unknown as {
          oidcClientMetadata?: { redirectUris?: string[]; postLogoutRedirectUris?: string[] };
        };
        if (body.oidcClientMetadata?.redirectUris) {
          // REPLACES. This is the behaviour the whole read-modify-write exists for.
          app.oidcClientMetadata.redirectUris = body.oidcClientMetadata.redirectUris;
        }
        if (body.oidcClientMetadata?.postLogoutRedirectUris) {
          app.oidcClientMetadata.postLogoutRedirectUris =
            body.oidcClientMetadata.postLogoutRedirectUris;
        }
        send(200, app);
        return;
      }
    }
    send(404, { message: `no fake route for ${req.method ?? '?'} ${path}` });
  }
}

/* ----------------------------------------------------------------------------- the fixture */

const PIN = 'box.example';
const DASHBOARD_APP = 'Mercatus dashboard';
const STOREFRONT_APP = 'Mercatus storefront';

const logto = new FakeLogto();
let platform: PlatformApp | undefined;
let operator = '';
const slug = `ded-${randomUUID().slice(0, 8)}`;

function stubBank(): BankClient {
  return {
    createPayment: (input) =>
      Promise.resolve({ providerRef: `fb_${input.reference}`, paymentUrl: 'http://bank.test/pay' }),
  };
}

async function mint(expectedHost = PIN): Promise<{ id: string; token: string }> {
  const created = await platform!.app.inject({
    method: 'POST',
    url: '/installations',
    headers: { authorization: `Bearer ${operator}` },
    payload: { tenantSlug: slug, expectedHost },
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as { installationId: string; bootstrapToken: string };
  return { id: body.installationId, token: body.bootstrapToken };
}

interface Registered {
  installationId: string;
  instanceToken: string;
  oidc: { clientId: string; clientSecret: string; organizationId: string | null } | null;
}

async function register(
  token: string,
  urls: { baseUrl: string; dashboardUrl?: string; storefrontUrl?: string },
): Promise<{ status: number; body: Registered }> {
  const res = await platform!.app.inject({
    method: 'POST',
    url: '/installations/register',
    payload: { bootstrapToken: token, version: '2.0.0', ...urls },
  });
  return { status: res.statusCode, body: res.json() as Registered };
}

async function report(
  instanceToken: string,
  urls: { baseUrl: string; dashboardUrl?: string; storefrontUrl?: string },
): Promise<{ status: number; body: Registered }> {
  const res = await platform!.app.inject({
    method: 'POST',
    url: '/installations/report',
    headers: { authorization: `Bearer ${instanceToken}` },
    payload: { version: '2.0.0', ...urls },
  });
  return { status: res.statusCode, body: res.json() as Registered };
}

function uris(name: string): string[] {
  return [...(logto.byName(name)?.oidcClientMetadata.redirectUris ?? [])].sort();
}

beforeAll(async () => {
  await logto.start();
  logto.seedApplication(DASHBOARD_APP, ['http://pooled.example:5173/callback'], [
    'http://pooled.example:8002/',
  ]);
  logto.seedApplication(STOREFRONT_APP, ['http://pooled.example:8002/api/auth/callback']);
  logto.organizations.push({ id: 'org_ded', name: slug });

  platform = await buildPlatformApp(
    loadPlatformConfig({
      DATABASE_URL: inject('platformDb').appUrl,
      AUTH_STUB_SECRET: 'test-stub-secret-that-is-long-enough',
      FAKE_BANK_HMAC_SECRET: 'test-fake-bank-hmac-secret-at-least-32-chars',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      LOGTO_ENDPOINT: logto.url,
      LOGTO_ADMIN_ENDPOINT: logto.url,
      LOGTO_M2M_SECRET: 'fake-m2m-secret',
    }),
    { bank: stubBank() },
  );
  await platform.app.ready();

  operator = (
    (
      await platform.app.inject({ method: 'POST', url: '/dev/login/operator', payload: {} })
    ).json() as { accessToken: string }
  ).accessToken;

  const created = await platform.app.inject({
    method: 'POST',
    url: '/signup',
    payload: {
      phone: `+9055501${String(Math.floor(Math.random() * 90_000) + 10_000)}`,
      name: 'Zeynep Buyer',
      storeName: 'A Dedicated Shop',
      slug,
      tier: 'dedicated',
    },
  });
  expect(created.statusCode).toBe(201);
});

afterAll(async () => {
  await platform?.close();
  await logto.stop();
});

/* ---------------------------------------------------------------------------------- the tests */

describe('a reported URL is normalised before it is stored or registered', () => {
  it('lower-cases the authority, so what was checked is what Logto is told', async () => {
    const minted = await mint();
    const { status, body } = await register(minted.token, {
      baseUrl: 'HTTP://BOX.EXAMPLE:8123',
      dashboardUrl: 'http://BOX.example:8124/',
    });
    expect(status).toBe(200);

    // The uppercase spelling never reaches the issuer. It used to: `hostMismatch` lower-cased for
    // COMPARISON only, the row and Logto kept the caller's spelling, and the store -- which
    // builds its redirect_uri from its own endpoint -- then sent lowercase and got
    // `oidc.invalid_redirect_uri`. Two different strings validated and stored is the bug.
    const app = logto.byName(`Mercatus store (tenant ${slug} / ${body.installationId})`);
    expect(app?.oidcClientMetadata.redirectUris).toEqual(['http://box.example:8123/auth/callback']);
    expect(uris(DASHBOARD_APP)).toContain('http://box.example:8124/callback');

    const listed = await platform!.app.inject({
      method: 'GET',
      url: '/installations',
      headers: { authorization: `Bearer ${operator}` },
    });
    const mine = (listed.json() as { items: { id: string; baseUrl: string }[] }).items.find(
      (i) => i.id === body.installationId,
    );
    expect(mine?.baseUrl).toBe('http://box.example:8123');

    await platform!.app.inject({
      method: 'DELETE',
      url: `/installations/${body.installationId}`,
      headers: { authorization: `Bearer ${operator}` },
    });
  });

  it('strips a backslash rather than registering two different strings', async () => {
    // `http://box.example\@evil.test/` is one of the four inputs that used to be stored VERBATIM.
    // WHATWG resolves it to the pinned host -- it was never exfiltration -- but the raw backslash
    // survived into the redirect URI, which is a parser differential waiting for a consumer that
    // disagrees with Node. Normalising means the string we checked is the string we register.
    const minted = await mint();
    const { status, body } = await register(minted.token, {
      baseUrl: 'http://box.example\\@evil.test/',
    });
    expect(status).toBe(200);
    const own = logto.byName(`Mercatus store (tenant ${slug} / ${body.installationId})`);
    expect(own?.oidcClientMetadata.redirectUris).toEqual([
      'http://box.example/@evil.test/auth/callback',
    ]);
    await platform!.app.inject({
      method: 'DELETE',
      url: `/installations/${body.installationId}`,
      headers: { authorization: `Bearer ${operator}` },
    });
  });

  it.each([
    ['userinfo', 'http://evil.test@box.example'],
    ['a query', 'http://box.example:1/x?next=http://evil.test'],
    ['a fragment', 'http://box.example:1/x#/../..'],
    ['a non-http scheme', 'ftp://box.example'],
    ['another host', 'http://evil.test'],
  ])('refuses %s, and does not burn the token', async (_label, baseUrl) => {
    const minted = await mint();
    const refused = await register(minted.token, { baseUrl });
    expect(refused.status).toBe(401);

    // Still spendable: a bad URL is a typo far more often than an attack, and burning the token
    // would brick the install for good.
    const ok = await register(minted.token, { baseUrl: 'http://box.example:9001' });
    expect(ok.status).toBe(200);
    await platform!.app.inject({
      method: 'DELETE',
      url: `/installations/${ok.body.installationId}`,
      headers: { authorization: `Bearer ${operator}` },
    });
  });
});

describe('an instance that moves says so, and the issuer follows it', () => {
  let live: Registered;

  it('registers, and is given a client of its own', async () => {
    const minted = await mint();
    const { status, body } = await register(minted.token, {
      baseUrl: 'http://box.example:9100',
      dashboardUrl: 'http://box.example:9102',
      storefrontUrl: 'http://box.example:9101',
    });
    expect(status).toBe(200);
    live = body;
    expect(body.oidc?.organizationId).toBe('org_ded');
    expect(uris(DASHBOARD_APP)).toContain('http://box.example:9102/callback');
    expect(uris(STOREFRONT_APP)).toContain('http://box.example:9101/api/auth/callback');
  });

  it('re-reporting the SAME addresses changes nothing and issues no PATCH', async () => {
    const before = { ...logto.patches };
    const { status } = await report(live.instanceToken, {
      baseUrl: 'http://box.example:9100',
      dashboardUrl: 'http://box.example:9102',
      storefrontUrl: 'http://box.example:9101',
    });
    expect(status).toBe(200);
    expect(logto.patches).toEqual(before);
  });

  it('a restart on a new port MOVES the redirect URIs instead of adding to them', async () => {
    const { status } = await report(live.instanceToken, {
      baseUrl: 'http://box.example:9200',
      dashboardUrl: 'http://box.example:9202',
      storefrontUrl: 'http://box.example:9201',
    });
    expect(status).toBe(200);

    // The whole point. Ports are orchestrator-assigned, so without this every restart leaks one
    // dead URI per shared application, for ever -- and the instance's own login breaks, because
    // its redirect_uri comes from its live address and Logto still holds the old one.
    const dashboard = uris(DASHBOARD_APP);
    expect(dashboard).toContain('http://box.example:9202/callback');
    expect(dashboard).not.toContain('http://box.example:9102/callback');
    // Nobody else's callback was disturbed.
    expect(dashboard).toContain('http://pooled.example:5173/callback');

    const storefront = uris(STOREFRONT_APP);
    expect(storefront).toContain('http://box.example:9201/api/auth/callback');
    expect(storefront).not.toContain('http://box.example:9101/api/auth/callback');

    // And the instance's OWN client is authoritative, not a union: one installation owns it.
    const own = logto.byName(`Mercatus store (tenant ${slug} / ${live.installationId})`);
    expect(own?.oidcClientMetadata.redirectUris).toEqual(['http://box.example:9200/auth/callback']);
  });

  it('refuses a report on a host the installation is not pinned to (GK, S1)', async () => {
    const res = await platform!.app.inject({
      method: 'POST',
      url: '/installations/report',
      headers: { authorization: `Bearer ${live.instanceToken}` },
      payload: { version: '2.0.0', baseUrl: 'http://evil.test:9200' },
    });
    expect(res.statusCode).toBe(401);
    // The row is untouched, so the box that IS serving keeps its registration.
    expect(uris(DASHBOARD_APP)).toContain('http://box.example:9202/callback');
  });

  it('does not take a shared URI away from a DIFFERENT installation that still needs it', async () => {
    // A second installation of the same tenant, reporting the live one's dashboard address --
    // which is what a throwaway box, or a second one behind the same proxy, looks like.
    const minted = await mint();
    const second = await register(minted.token, {
      baseUrl: 'http://box.example:9300',
      dashboardUrl: 'http://box.example:9202',
    });
    expect(second.status).toBe(200);

    const gone = await platform!.app.inject({
      method: 'DELETE',
      url: `/installations/${second.body.installationId}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(gone.statusCode).toBe(204);

    // Observed on a running stack before this was fixed: deleting the throwaway deleted the live
    // box's callback out of the shared client while it was serving.
    expect(uris(DASHBOARD_APP)).toContain('http://box.example:9202/callback');
    // Its own client went, though -- that one is nobody else's (CE1, CK1).
    expect(logto.byName(`Mercatus store (tenant ${slug} / ${second.body.installationId})`)).toBeUndefined();
  });

  it('deprovisioning the last claimant DOES take the URI back out (CK1)', async () => {
    const gone = await platform!.app.inject({
      method: 'DELETE',
      url: `/installations/${live.installationId}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(gone.statusCode).toBe(204);

    const dashboard = uris(DASHBOARD_APP);
    expect(dashboard).not.toContain('http://box.example:9202/callback');
    expect(dashboard).toEqual(['http://pooled.example:5173/callback']);
    expect(uris(STOREFRONT_APP)).toEqual(['http://pooled.example:8002/api/auth/callback']);
  });
});

describe('a failure AFTER the instance client exists', () => {
  it('records the application id and still hands the instance its client', async () => {
    logto.failPatchFor = DASHBOARD_APP;
    const minted = await mint();
    const { status, body } = await register(minted.token, {
      baseUrl: 'http://box.example:9400',
      dashboardUrl: 'http://box.example:9402',
    });
    logto.failPatchFor = null;

    expect(status).toBe(200);
    // NOT null. The client is real and its secret is real; an instance told there is no issuer
    // client comes up with no OIDC at all while the operator sees a clean registration.
    expect(body.oidc?.clientId).toBeTruthy();

    const name = `Mercatus store (tenant ${slug} / ${body.installationId})`;
    expect(logto.byName(name)).toBeDefined();

    // And deprovisioning can still reach it: the application id was written the moment the
    // client existed, before anything that could throw. Without that it was a client secret
    // nobody could ever revoke.
    const gone = await platform!.app.inject({
      method: 'DELETE',
      url: `/installations/${body.installationId}`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(gone.statusCode).toBe(204);
    expect(logto.byName(name)).toBeUndefined();
  });
});
