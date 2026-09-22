/**
 * fake-bank's slice of the §8.2 environment contract, parsed once, at boot, through Zod -- the
 * same rule as `loadStoreConfig` in @mercatus/core: a missing or malformed variable fails with
 * the name of the variable, never as a 500 in the middle of a checkout.
 *
 * It lives here rather than in @mercatus/core because fake-bank is run-mode only and must never
 * be reachable from a published image (CR1); core is imported by everything, and a config loader
 * for a service that may not ship does not belong in it.
 *
 * Variables, all of them already in §8.2:
 *   MERCATUS_ALLOW_FAKE_BANK   must be exactly `1`, or the process refuses to start
 *   FAKE_BANK_HMAC_SECRET      shared with the platform, control plane only
 *   PORT, HOST, LOG_LEVEL, NODE_ENV
 */
import { ConfigInvalidError } from '@mercatus/core';
import { z } from 'zod';

const fakeBankEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4004),
    HOST: z.string().min(1).default('127.0.0.1'),
    LOG_LEVEL: z.string().min(1).default('info'),

    /**
     * The run-mode gate (§6.3, CR1). Only an AppHost sets it. A fake that can decline a payment
     * on request is a hole in anything it is deployed beside, so the guard is a boot failure and
     * not a warning.
     */
    MERCATUS_ALLOW_FAKE_BANK: z.string().optional(),

    /** Shared with the platform. Long enough that a bad copy-paste is visible. */
    FAKE_BANK_HMAC_SECRET: z.string().min(32),
  })
  .superRefine((env, ctx) => {
    if (env.MERCATUS_ALLOW_FAKE_BANK !== '1') {
      ctx.addIssue({
        code: 'custom',
        path: ['MERCATUS_ALLOW_FAKE_BANK'],
        message:
          'fake-bank is run-mode only and refuses to start without MERCATUS_ALLOW_FAKE_BANK=1 (CR1).',
      });
    }
  });

export interface FakeBankConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly hmacSecret: string;
}

export type EnvSource = Record<string, string | undefined>;

export function loadFakeBankConfig(env: EnvSource = process.env): FakeBankConfig {
  const parsed = fakeBankEnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigInvalidError(`Environment is not valid -- ${detail}`, { logDetail: detail });
  }
  const value = parsed.data;
  return {
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    hmacSecret: value.FAKE_BANK_HMAC_SECRET,
  };
}
