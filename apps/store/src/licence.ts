/**
 * What this store believes about its licence, and how it is currently behaving (CG3).
 *
 * Two facts that are never collapsed into one flag:
 *
 *   status  the TENANT's state. `passive` means they did not pay, or we suspended them. It blocks
 *           checkout and leaves the dashboard fully usable, because the page that fixes it is the
 *           last thing to take away.
 *   state   OURS. `grace` and `read_only` mean we could not be reached, which is our fault and
 *           must not look to the merchant like being cut off for non-payment.
 *
 * Task 03 computes and reports this. The plugin that enforces it (402 on checkout when passive,
 * 503 once the grace window has expired) arrives with tasks 08 and 10; the arithmetic lives here
 * so both read the same clock.
 */
import type { LicenceRuntimeState, LicenceView } from '@mercatus/contracts';
import type { StoreConfig } from '@mercatus/core';
import type { LicenceStateRow } from '@mercatus/db-store';

export interface LicenceClock {
  /** Poll interval; three missed polls is the boundary between healthy and unreachable (CG2). */
  readonly pollSeconds: number;
  /** 259200 (72h) by default, 60 in the demo profile (CG2). */
  readonly graceSeconds: number;
  readonly mode: 'pooled' | 'dedicated';
}

export function licenceClock(config: StoreConfig): LicenceClock {
  return {
    pollSeconds: config.licencePollSeconds,
    graceSeconds: config.licenceGraceSeconds,
    mode: config.mode,
  };
}

/**
 * A store with no licence row yet is active and healthy. That is not optimism: a pooled store
 * shares a machine with the control plane and does not poll at all, so "never heard from them"
 * is the normal state rather than an outage (CE4 is about the dedicated tier).
 */
export function runtimeState(
  row: LicenceStateRow | null,
  clock: LicenceClock,
  now: Date = new Date(),
): LicenceRuntimeState {
  if (row?.status === 'passive') return 'passive';
  if (clock.mode === 'pooled') return 'healthy';
  const lastSuccess = row?.lastSuccessAt;
  if (!lastSuccess) return 'healthy';
  const ageSeconds = (now.getTime() - lastSuccess.getTime()) / 1000;
  if (ageSeconds <= clock.pollSeconds * 3) return 'healthy';
  if (ageSeconds <= clock.graceSeconds) return 'grace';
  return 'read_only';
}

export function licenceView(
  row: LicenceStateRow | null,
  clock: LicenceClock,
  now: Date = new Date(),
): LicenceView {
  return {
    status: row?.status ?? 'active',
    state: runtimeState(row, clock, now),
    entitlements: row?.entitlements ?? {},
    validUntil: row?.validUntil ?? null,
    lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
  };
}
