/**
 * The environment contract (BUILD-PLAN §8.2), parsed once, here, through Zod.
 *
 * A missing or malformed variable fails at BOOT with the name of the variable -- never at the
 * first request, where it becomes a 500 in someone's shopping basket and a log line nobody reads.
 *
 * Invent no variables without adding them to §8.2 first. Two additions were made by task 03 and
 * are recorded in decisions-made-overnight.md: `BASE_HOST` (host-based tenant resolution needs to
 * know which suffix is ours) and `LOG_LEVEL`.
 */
import { z } from 'zod';

import { ConfigInvalidError } from './errors.js';

const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

const portSchema = z.coerce.number().int().min(1).max(65_535);

const positiveSecondsSchema = z.coerce.number().int().positive();

/**
 * A postgres connection string. Not validated beyond its scheme: the driver is the authority on
 * what it accepts, and a regex here would only reject valid URLs.
 */
const postgresUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'must be a postgres:// connection string',
  );

const deploymentModeSchema = z.enum(['pooled', 'dedicated']);

const authAdapterSchema = z.enum(['stub', 'oidc']);

/**
 * The store's slice of §8.2.
 *
 * `DATABASE_URL` is the app role and is the ONLY connection string a server process is given
 * (BE2). `DATABASE_ADMIN_URL` belongs to the migrate step and is deliberately absent here -- if a
 * server can reach the owner role, RLS is one typo away from being decoration.
 */
const storeEnvSchema = z
  .object({
    NODE_ENV: nodeEnvSchema,
    PORT: portSchema.default(4002),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z.string().min(1).default('info'),

    DEPLOYMENT_MODE: deploymentModeSchema.default('pooled'),
    TENANT_SLUG: z.string().min(2).optional(),

    DATABASE_URL: postgresUrlSchema,

    AUTH_ADAPTER: authAdapterSchema.default('stub'),
    AUTH_STUB_SECRET: z.string().optional(),

    /**
     * The real issuer (task 08). One issuer, one JWKS, never two (CD4). The cache path is a
     * FILE: the adapter writes the discovery document, the key set and the organization ->
     * tenant directory into it, and reads them back with the control plane down (CG1).
     */
    OIDC_ISSUER: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    OIDC_JWKS_CACHE_PATH: z.string().min(1).default('.identity-cache/store.json'),

    /**
     * The key the store signs its OWN session cookie with. Deliberately separate from
     * AUTH_STUB_SECRET: the session outlives the stub, and a dedicated instance holds this one
     * and nothing else of ours (CE1).
     */
    SESSION_SECRET: z.string().optional(),
    SESSION_TTL_SECONDS: positiveSecondsSchema.default(43_200),

    /** Absolute, browser-visible base URL of this store -- the OIDC redirect_uri is built on it. */
    STORE_PUBLIC_URL: z.url().optional(),

    /** The DNS suffix this deployment answers on, for host-based tenant resolution (§3.6). */
    BASE_HOST: z.string().min(1).default('localtest.me'),

    PLATFORM_URL: z.url().optional(),
    /**
     * The payment provider, read-only. The store asks it whether an order was paid and records
     * the answer; it holds no credential for it, which is what keeps CE2 intact on a box whose
     * owner has root. Absent means no settlement route is registered at all.
     */
    FAKE_BANK_URL: z.url().optional(),
    /**
     * A DEDICATED instance's own revocable credential, handed out by /installations/register
     * (CE1). It is also what says "report telemetry": pooled is measured by the control plane
     * itself, dedicated reports, and the two are never one path (CJ1).
     */
    INSTANCE_TOKEN: z.string().min(1).optional(),
    /**
     * Where that credential is kept when the instance MINTED it itself rather than being handed
     * one (architecture.md §7). The install command registers with a one-time bootstrap token,
     * writes this file 0600 and never needs the bootstrap token again; the store reads it at boot.
     * A credential that arrives in an environment variable came from somewhere else, which on a
     * box we do not own is the thing CE1 is about.
     */
    INSTANCE_TOKEN_PATH: z.string().min(1).optional(),
    /** The POOLED plane's shared licence-poll credential. Never set on a dedicated instance. */
    PLATFORM_INTERNAL_TOKEN: z.string().min(16).optional(),

    LICENCE_POLL_SECONDS: positiveSecondsSchema.default(10),
    LICENCE_GRACE_SECONDS: positiveSecondsSchema.default(259_200),
  })
  .superRefine((env, ctx) => {
    if (env.DEPLOYMENT_MODE === 'dedicated' && !env.TENANT_SLUG) {
      ctx.addIssue({
        code: 'custom',
        path: ['TENANT_SLUG'],
        message: 'DEPLOYMENT_MODE=dedicated pins the instance to one tenant; TENANT_SLUG is required.',
      });
    }
    if (env.AUTH_ADAPTER === 'stub' && !env.AUTH_STUB_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_STUB_SECRET'],
        message: 'AUTH_ADAPTER=stub needs AUTH_STUB_SECRET (at least 32 characters).',
      });
    }
    if (env.AUTH_ADAPTER === 'oidc' && !env.OIDC_ISSUER) {
      // Only the issuer is required. The CLIENT registration is pulled into the identity cache
      // by the bootstrap, because an instance registers itself rather than being handed
      // credentials by hand (CE7) -- and it may be a different client per instance (CE1).
      ctx.addIssue({ code: 'custom', path: ['OIDC_ISSUER'], message: 'AUTH_ADAPTER=oidc needs OIDC_ISSUER.' });
    }
    if (!env.SESSION_SECRET && !env.AUTH_STUB_SECRET) {
      // The session key falls back to the stub secret so nothing that worked before task 08 has
      // to be reconfigured; with a real issuer there is no stub secret, so it must be set.
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET is required (at least 32 characters).',
      });
    }
  });

export interface StoreConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  /** One image, two modes, no second code path (CC1). */
  readonly mode: 'pooled' | 'dedicated';
  /** Set in dedicated mode only; the instance serves this tenant and no other. */
  readonly tenantSlug: string | undefined;
  readonly databaseUrl: string;
  readonly authAdapter: 'stub' | 'oidc';
  readonly authStubSecret: string | undefined;
  readonly oidcIssuer: string | undefined;
  readonly oidcClientId: string | undefined;
  readonly oidcClientSecret: string | undefined;
  readonly oidcJwksCachePath: string;
  /** Falls back to AUTH_STUB_SECRET so a stub deployment needs no new variable. */
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly storePublicUrl: string | undefined;
  readonly baseHost: string;
  readonly platformUrl: string | undefined;
  /** The payment provider's base URL. Read-only, and never a credential (CE2). */
  readonly fakeBankUrl: string | undefined;
  readonly instanceToken: string | undefined;
  /** The file the install command wrote the instance credential into, if there is one. */
  readonly instanceTokenPath: string | undefined;
  readonly internalToken: string | undefined;
  readonly licencePollSeconds: number;
  readonly licenceGraceSeconds: number;
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Zod's report, turned into one line that names every variable that is wrong. The whole point of
 * parsing at boot is that the operator reads the variable name, not a stack trace.
 */
function fail(error: z.ZodError): never {
  const detail = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new ConfigInvalidError(`Environment is not valid -- ${detail}`, { logDetail: detail });
}

export function loadStoreConfig(env: EnvSource = process.env): StoreConfig {
  const parsed = storeEnvSchema.safeParse(env);
  if (!parsed.success) fail(parsed.error);
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    mode: value.DEPLOYMENT_MODE,
    tenantSlug: value.TENANT_SLUG,
    databaseUrl: value.DATABASE_URL,
    authAdapter: value.AUTH_ADAPTER,
    authStubSecret: value.AUTH_STUB_SECRET,
    oidcIssuer: value.OIDC_ISSUER,
    oidcClientId: value.OIDC_CLIENT_ID,
    oidcClientSecret: value.OIDC_CLIENT_SECRET,
    oidcJwksCachePath: value.OIDC_JWKS_CACHE_PATH,
    sessionSecret: value.SESSION_SECRET ?? value.AUTH_STUB_SECRET ?? '',
    sessionTtlSeconds: value.SESSION_TTL_SECONDS,
    storePublicUrl: value.STORE_PUBLIC_URL,
    baseHost: value.BASE_HOST,
    platformUrl: value.PLATFORM_URL,
    fakeBankUrl: value.FAKE_BANK_URL,
    instanceToken: value.INSTANCE_TOKEN,
    instanceTokenPath: value.INSTANCE_TOKEN_PATH,
    internalToken: value.PLATFORM_INTERNAL_TOKEN,
    licencePollSeconds: value.LICENCE_POLL_SECONDS,
    licenceGraceSeconds: value.LICENCE_GRACE_SECONDS,
  };
}
