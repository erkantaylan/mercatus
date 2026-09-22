/**
 * A thin client for Logto's Management API, and the two facts about a fresh OSS instance that
 * nothing in the documentation makes obvious.
 *
 * 1. `logto db seed` creates an M2M application `m-default` IN THE `admin` TENANT whose whole
 *    purpose is Management API access to the `default` tenant. Its secret is random per seed and
 *    lives in `applications.secret`, so the bootstrap reads it out of Logto's own database. That
 *    is the ONLY database access in this package, and it exists to avoid the alternative: a human
 *    clicking through the admin console to create an M2M app before anything can be automated.
 * 2. The token for it comes from the ADMIN endpoint, not the default one:
 *      POST {ADMIN}/oidc/token  client_credentials  resource=https://default.logto.app/api
 *    while the API it opens is at {ENDPOINT}/api.
 *
 * Applications created through the API are different again: their `applications.secret` column
 * holds a `#internal:` placeholder and the usable secret is at GET /api/applications/:id/secrets.
 */
import postgres from 'postgres';

/** Resource indicator of the default tenant's Management API in a Logto OSS instance. */
export const MANAGEMENT_API_RESOURCE = 'https://default.logto.app/api';

/** The M2M application the seed creates for exactly this purpose. */
export const MANAGEMENT_API_APP_ID = 'm-default';

export class LogtoError extends Error {
  public override readonly name = 'LogtoError';
}

export interface LogtoClientOptions {
  /** ENDPOINT, e.g. http://127.0.0.1:3011. */
  readonly endpoint: string;
  /** ADMIN_ENDPOINT, e.g. http://127.0.0.1:3012. Where the M2M token is minted. */
  readonly adminEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Reads the seeded M2M secret straight out of Logto's database. See the note above. */
export async function readManagementSecret(databaseUrl: string): Promise<string> {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql<{ secret: string }[]>`
      select secret from applications where id = ${MANAGEMENT_API_APP_ID} limit 1
    `;
    const secret = rows[0]?.secret;
    if (!secret) {
      throw new LogtoError(
        `No "${MANAGEMENT_API_APP_ID}" application in this Logto database. Has "logto db seed" run?`,
      );
    }
    return secret;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export class LogtoManagementClient {
  readonly #options: LogtoClientOptions;
  #token: { value: string; expiresAt: number } | null = null;

  constructor(options: LogtoClientOptions) {
    this.#options = options;
  }

  async #accessToken(): Promise<string> {
    const now = Date.now();
    if (this.#token && this.#token.expiresAt > now + 30_000) return this.#token.value;

    const authorization = Buffer.from(
      `${this.#options.clientId}:${this.#options.clientSecret}`,
    ).toString('base64');
    const response = await fetch(`${this.#options.adminEndpoint}/oidc/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${authorization}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        resource: MANAGEMENT_API_RESOURCE,
        scope: 'all',
      }).toString(),
    });
    const body = (await response.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!response.ok || !body.access_token) {
      throw new LogtoError(`Management token refused (${String(response.status)}): ${body.error ?? ''}`);
    }
    this.#token = {
      value: body.access_token,
      expiresAt: now + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.#accessToken();
    const response = await fetch(`${this.#options.endpoint}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LogtoError(`${method} ${path} -> ${String(response.status)} ${text.slice(0, 300)}`);
    }
    // The relation endpoints (organization membership, role assignment) answer `201 Created` with
    // the literal body "Created", not JSON. Only the callers that want a value parse one.
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      return null as T;
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** Polls until Logto answers its own discovery document, or gives up loudly. */
  async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'never answered';
    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `${this.#options.endpoint}/oidc/.well-known/openid-configuration`,
          { signal: AbortSignal.timeout(2000) },
        );
        if (response.ok) return;
        lastError = `HTTP ${String(response.status)}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new LogtoError(`Logto did not become ready within ${String(timeoutMs)}ms: ${lastError}`);
  }
}
