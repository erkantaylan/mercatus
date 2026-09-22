/**
 * The state machine, on its own clock (CG3, CG2).
 *
 * This is the one piece of the degradation design that is pure arithmetic, so it is the one
 * piece worth testing without a database. What it holds down is the distinction the whole thing
 * rests on: `passive` (theirs) and `read_only` (ours) are reached by different routes and mean
 * different things, and no amount of being unreachable ever produces `passive`.
 */
import type { LicenceStateRow } from '@mercatus/db-store';
import { describe, expect, it } from 'vitest';

import type { LicenceClock } from '../src/licence.js';
import { checkoutBlock, licenceView, runtimeState, storefrontLicence, writesRefused } from '../src/licence.js';

const clock: LicenceClock = { pollSeconds: 5, graceSeconds: 60, mode: 'pooled' };
const now = new Date('2026-01-01T12:00:00.000Z');

function row(overrides: Partial<LicenceStateRow>): LicenceStateRow {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    status: 'active',
    entitlements: {},
    validUntil: '2027-01-01',
    lastCheckedAt: now,
    lastSuccessAt: now,
    ...overrides,
  };
}

function secondsAgo(seconds: number): Date {
  return new Date(now.getTime() - seconds * 1000);
}

describe('the licence state machine', () => {
  it('is healthy with no row at all -- an instance that was never told to poll is not in an outage', () => {
    expect(runtimeState(null, clock, now)).toBe('healthy');
    expect(checkoutBlock(licenceView(null, clock, now))).toBeNull();
  });

  it('is healthy while polls are landing', () => {
    expect(runtimeState(row({ lastSuccessAt: secondsAgo(4) }), clock, now)).toBe('healthy');
  });

  it('enters grace after three missed polls, and REFUSES NOTHING there (CG1)', () => {
    const view = licenceView(row({ lastSuccessAt: secondsAgo(20) }), clock, now);
    expect(view.state).toBe('grace');
    expect(checkoutBlock(view)).toBeNull();
    expect(writesRefused(view)).toBe(false);
  });

  it('degrades to read_only past the grace window -- browse yes, sell no, never a hard stop', () => {
    const view = licenceView(row({ lastSuccessAt: secondsAgo(120) }), clock, now);
    expect(view.state).toBe('read_only');
    expect(checkoutBlock(view)).toBe('unreachable');
    expect(writesRefused(view)).toBe(true);
    // The tenant's own status is untouched. Being unreachable is never being passive (CG3).
    expect(view.status).toBe('active');
  });

  it('blocks checkout when passive and leaves writes alone -- the dashboard is the page that fixes it', () => {
    const view = licenceView(row({ status: 'passive' }), clock, now);
    expect(view.state).toBe('passive');
    expect(checkoutBlock(view)).toBe('passive');
    expect(writesRefused(view)).toBe(false);
  });

  it('keeps passive distinct from unreachable even when both are true', () => {
    // A passive tenant on a box that has not reached us for a week. The merchant is told the
    // truth about their own status; our outage does not overwrite it.
    const view = licenceView(row({ status: 'passive', lastSuccessAt: secondsAgo(604_800) }), clock, now);
    expect(checkoutBlock(view)).toBe('passive');
  });

  it('gates the mark on the entitlement and nothing else (CC3)', () => {
    expect(storefrontLicence(licenceView(row({}), clock, now)).poweredByMark).toBe(true);
    expect(
      storefrontLicence(licenceView(row({ entitlements: { whiteLabel: true } }), clock, now))
        .poweredByMark,
    ).toBe(false);
    // An entitlement that is present and false is not an entitlement.
    expect(
      storefrontLicence(licenceView(row({ entitlements: { whiteLabel: false } }), clock, now))
        .poweredByMark,
    ).toBe(true);
  });

  it('projects the two blocked states as two different public answers', () => {
    expect(storefrontLicence(licenceView(row({ status: 'passive' }), clock, now)).checkout).toBe(
      'blocked_passive',
    );
    expect(
      storefrontLicence(licenceView(row({ lastSuccessAt: secondsAgo(120) }), clock, now)).checkout,
    ).toBe('blocked_unreachable');
    expect(storefrontLicence(licenceView(row({}), clock, now)).checkout).toBe('open');
  });

  it('runs the same machine in both deployment modes (CC1)', () => {
    const dedicated: LicenceClock = { ...clock, mode: 'dedicated' };
    const stale = row({ lastSuccessAt: secondsAgo(120) });
    expect(runtimeState(stale, clock, now)).toBe(runtimeState(stale, dedicated, now));
  });
});
