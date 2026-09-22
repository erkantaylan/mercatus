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

    /** The DNS suffix this deployment answers on, for host-based tenant resolution (§3.6). */
    BASE_HOST: z.string().min(1).default('localtest.me'),

    PLATFORM_URL: z.url().optional(),
    INSTANCE_TOKEN: z.string().min(1).optional(),

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
  readonly baseHost: string;
  readonly platformUrl: string | undefined;
  readonly instanceToken: string | undefined;
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
    baseHost: value.BASE_HOST,
    platformUrl: value.PLATFORM_URL,
    instanceToken: value.INSTANCE_TOKEN,
    licencePollSeconds: value.LICENCE_POLL_SECONDS,
    licenceGraceSeconds: value.LICENCE_GRACE_SECONDS,
  };
}
