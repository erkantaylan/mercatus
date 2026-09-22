/**
 * The control plane's slice of the environment contract (BUILD-PLAN §8.2), parsed once, here,
 * through Zod. A missing or malformed variable fails at BOOT with the name of the variable.
 *
 * WHY THIS IS NOT IN @mercatus/core, where §8.2 says configuration lives: task 04a was scoped to
 * `apps/platform` and `packages/db-platform` while another agent was writing `apps/fake-bank` at
 * the same time, and two agents rewriting `packages/core/src/config.ts` concurrently is a silent
 * clobber. `loadPlatformConfig` is a drop-in move into core the moment nobody else is editing it
 * -- it depends on nothing in this app. Recorded in decisions-made-overnight.md.
 *
 * Three variables here are new to §8.2 and are recorded there too: LICENCE_SIGNING_KEY,
 * STORE_PLAN_PRICE_MINOR and STORE_PLAN_CURRENCY.
 */
import { readFileSync } from 'node:fs';

import { ConfigInvalidError } from '@mercatus/core';
import { z } from 'zod';

const platformEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4001),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z.string().min(1).default('info'),

    /** The app role, NOBYPASSRLS. The owner's connection string belongs to migrate only (BE2). */
    DATABASE_URL: z
      .string()
      .min(1)
      .refine(
        (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
        'must be a postgres:// connection string',
      ),

    AUTH_ADAPTER: z.enum(['stub', 'oidc']).default('stub'),
    AUTH_STUB_SECRET: z.string().optional(),

    /** Our own public base. It is what we hand fake-bank as the callback address. */
    PLATFORM_URL: z.url().optional(),

    FAKE_BANK_URL: z.url().default('http://127.0.0.1:4004'),
    /**
     * Shared with fake-bank and with nothing else. Control plane only -- never on a VPS (CE2).
     * At least 32 characters because fake-bank's own config demands 32: a shorter one would boot
     * here and fail there, which is a mismatch discovered at the first payment instead of at
     * the first start.
     */
    FAKE_BANK_HMAC_SECRET: z.string().min(32),

    /**
     * An Ed25519 private key, PKCS8 PEM. Asymmetric on purpose: a data plane must verify a
     * licence offline (CG1) while holding NO key that could mint one (CE1). There is no
     * LICENCE_PUBLIC_KEY -- the public half is derived from this, so the two cannot disagree.
     * Absent in development, a committed dev key is used and the boot logs a warning.
     */
    LICENCE_SIGNING_KEY: z.string().min(1).optional(),

    /** What a store costs. One plan, one price; there is no pricing model in this POC. */
    STORE_PLAN_PRICE_MINOR: z.coerce.number().int().positive().default(49_900),
    STORE_PLAN_CURRENCY: z.string().length(3).default('TRY'),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_ADAPTER === 'stub' && !env.AUTH_STUB_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_STUB_SECRET'],
        message: 'AUTH_ADAPTER=stub needs AUTH_STUB_SECRET (at least 32 characters).',
      });
    }
    if (env.NODE_ENV === 'production' && !env.LICENCE_SIGNING_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['LICENCE_SIGNING_KEY'],
        message: 'The committed development licence key is refused under NODE_ENV=production.',
      });
    }
  });

export interface PlatformConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly authAdapter: 'stub' | 'oidc';
  readonly authStubSecret: string | undefined;
  readonly platformUrl: string;
  readonly fakeBankUrl: string;
  readonly fakeBankHmacSecret: string;
  readonly licenceSigningKey: string;
  /** True when the committed development key is in use. Logged loudly at boot. */
  readonly licenceKeysAreDevDefaults: boolean;
  readonly planPriceMinor: number;
  readonly planCurrency: string;
}

export type EnvSource = Record<string, string | undefined>;

function devKey(file: string): string {
  return readFileSync(new URL(`../keys/${file}`, import.meta.url), 'utf8');
}

export function loadPlatformConfig(env: EnvSource = process.env): PlatformConfig {
  const parsed = platformEnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigInvalidError(`Environment is not valid -- ${detail}`, { logDetail: detail });
  }
  const value = parsed.data;
  const usingDevKeys = !value.LICENCE_SIGNING_KEY;

  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    authAdapter: value.AUTH_ADAPTER,
    authStubSecret: value.AUTH_STUB_SECRET,
    platformUrl: value.PLATFORM_URL ?? `http://127.0.0.1:${String(value.PORT)}`,
    fakeBankUrl: value.FAKE_BANK_URL,
    fakeBankHmacSecret: value.FAKE_BANK_HMAC_SECRET,
    licenceSigningKey: value.LICENCE_SIGNING_KEY ?? devKey('dev-licence-private.pem'),
    licenceKeysAreDevDefaults: usingDevKeys,
    planPriceMinor: value.STORE_PLAN_PRICE_MINOR,
    planCurrency: value.STORE_PLAN_CURRENCY,
  };
}
