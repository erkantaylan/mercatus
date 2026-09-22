/**
 * The instance credential -- what a DEDICATED box holds instead of a shared secret (CE1).
 *
 * The pooled plane polls with `PLATFORM_INTERNAL_TOKEN`, which is defensible for exactly one
 * reason: it is a process we run, on our machine, beside the control plane. A dedicated instance
 * runs on hardware whose owner has root (CE5), so it gets a credential of its own, minted by the
 * control plane at registration, individually revocable, and never seen by any other instance.
 *
 * It arrives one of two ways:
 *
 *   INSTANCE_TOKEN        handed to the process by whoever starts it
 *   INSTANCE_TOKEN_PATH   a file the install command wrote when it registered (architecture.md §7)
 *
 * The file is the honest one, and it is what AppHost B uses: the token is minted ON the box, by
 * the box, in exchange for a one-time bootstrap token, and it never travels through an
 * orchestrator's environment. `INSTANCE_TOKEN` stays because a real deployment may well inject
 * it from a secret store, and because it is what a test sets.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { StoreConfig } from '@mercatus/core';
import { z } from 'zod';

/**
 * Exactly what `POST /installations/register` answered, plus when. The tenant is recorded so a
 * credential can be checked against the tenant this process was configured for: a box holding
 * another tenant's token is a misconfiguration worth failing on, not one to poll with.
 */
export const instanceCredentialSchema = z.object({
  installationId: z.uuid(),
  instanceToken: z.string().min(32),
  tenantId: z.uuid(),
  tenantSlug: z.string().min(2),
  /**
   * The tenant's display name, as the CONTROL PLANE holds it (BV1). Mirrored into this box's own
   * database by the install command, so that one AppHost can serve any tenant by slug alone --
   * the name was the last per-tenant string that could not be derived from the slug (v2.0.0
   * phase 2). Optional because a credential file written before it existed is still a credential.
   */
  tenantName: z.string().min(1).optional(),
  /**
   * The issuer client the control plane minted FOR THIS INSTANCE when it registered (v2.0.0).
   * Ours alone, not the pooled plane's (CE1). It is kept here as well as in the identity cache so
   * that a deleted cache file can be rebuilt from the credential without spending a bootstrap
   * token that no longer exists. Absent on a control plane with no issuer wired up.
   */
  oidc: z
    .object({
      issuer: z.string().min(1),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      organizationId: z.string().min(1).nullable(),
    })
    .nullish(),
  registeredAt: z.string().min(1),
});

export type InstanceCredential = z.infer<typeof instanceCredentialSchema>;

/** Null when the file is not there yet; anything else is a real failure and is thrown. */
export function readInstanceCredential(path: string): InstanceCredential | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return instanceCredentialSchema.parse(JSON.parse(raw));
}

/** 0600, because it is a credential sitting on a disk somebody else owns (CE1, CE5). */
export function writeInstanceCredential(path: string, credential: InstanceCredential): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/**
 * The boot-time resolution. Returns the config unchanged unless a credential file supplies a
 * token the environment did not.
 *
 * A missing file is NOT fatal: the licence agent logs that it has no control plane and the store
 * serves, because "never polled" is healthy (licence.ts) and a shop that will not start because
 * our registration endpoint was down would be the exact failure CG1 exists to prevent.
 */
export function withInstanceCredential(config: StoreConfig): StoreConfig {
  // An explicit token wins: whoever set it knows more than a file on disk does.
  if (config.instanceToken !== undefined) return config;
  if (config.instanceTokenPath === undefined) return config;
  const credential = readInstanceCredential(config.instanceTokenPath);
  if (!credential) {
    process.stdout.write(
      `instance credential not found at ${config.instanceTokenPath}; not registered yet\n`,
    );
    return config;
  }
  if (config.tenantSlug && credential.tenantSlug !== config.tenantSlug) {
    throw new Error(
      `instance credential at ${config.instanceTokenPath} belongs to ${credential.tenantSlug}, ` +
        `but this instance serves ${config.tenantSlug}`,
    );
  }
  process.stdout.write(
    `instance credential loaded: installation ${credential.installationId} for ${credential.tenantSlug}\n`,
  );
  return { ...config, instanceToken: credential.instanceToken };
}
