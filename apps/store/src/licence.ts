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
 * The arithmetic lives here and nowhere else, so the gate that refuses a checkout, the banner the
 * dashboard draws and the sentence the storefront prints are all reading the same clock.
 */
import type { LicenceRuntimeState, LicenceView, StorefrontLicence } from '@mercatus/contracts';
import type { StoreConfig } from '@mercatus/core';
import type { LicenceStateRow } from '@mercatus/db-store';

/**
 * Entitlement keys. They are DATA in the signed licence, never a build flag (CC3) -- which is
 * why this is a list of strings and not a set of compile-time constants somewhere in a bundler
 * config. `whiteLabel` removes the "a store on mercatus" mark; absent or false leaves it on, so
 * a tenant with an empty entitlements blob gets the default rather than the paid behaviour.
 */
export const ENTITLEMENT_WHITE_LABEL = 'whiteLabel';

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
 * A store that has never had a successful poll is healthy. That is not optimism: an instance with
 * no PLATFORM_URL is not configured to poll at all, and treating "never asked" as "cannot reach"
 * would degrade a store that was never meant to have a control plane in front of it. The grace
 * window only starts once there is a success to measure from.
 *
 * There is no `mode` branch below, on purpose. Pooled and dedicated run the same state machine
 * (CC1, CC2): the pooled plane polls the control plane over loopback and the dedicated one polls
 * it across the internet, and a second code path would be a second test matrix.
 */
export function runtimeState(
  row: LicenceStateRow | null,
  clock: LicenceClock,
  now: Date = new Date(),
): LicenceRuntimeState {
  if (row?.status === 'passive') return 'passive';
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

/**
 * Whether the money-making action is allowed, and if not, whose fault it is.
 *
 *   passive      the merchant's own state. Their shop browses; it does not sell.
 *   grace        ours, and within the window we wrote down: everything still works (CG1, CG2).
 *   read_only    ours, past the window: browse only. Degraded, never a hard stop.
 */
export function checkoutBlock(view: LicenceView): 'passive' | 'unreachable' | null {
  if (view.status === 'passive') return 'passive';
  if (view.state === 'read_only') return 'unreachable';
  return null;
}

/**
 * Whether a WRITE is allowed. Passive deliberately does not appear here: a merchant who has not
 * paid keeps a fully usable dashboard, because it is the page that fixes it (CG3).
 */
export function writesRefused(view: LicenceView): boolean {
  return view.state === 'read_only';
}

function entitled(entitlements: Record<string, boolean>, key: string): boolean {
  return entitlements[key] === true;
}

/** The public projection -- the only two licence facts a shopper is shown. */
export function storefrontLicence(view: LicenceView): StorefrontLicence {
  const block = checkoutBlock(view);
  return {
    checkout:
      block === null ? 'open' : block === 'passive' ? 'blocked_passive' : 'blocked_unreachable',
    // CC3: the mark is off when the tenant is entitled to have it off, and on otherwise. Nothing
    // about this decision is known at build time.
    poweredByMark: !entitled(view.entitlements, ENTITLEMENT_WHITE_LABEL),
  };
}
