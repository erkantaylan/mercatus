/**
 * The data plane's heartbeat (CE4, CE6, CE7, CG1, BUILD-PLAN §6.2).
 *
 * Every arrow here is OUTBOUND. The control plane never calls a store, never holds a callback
 * URL for one and never needs a route into its network -- the store pulls its licence on a timer
 * and pushes its telemetry on the same tick. That is the property that is expensive to undo: the
 * day support "just needs to reach in", the product has become an on-prem support business.
 *
 * Each tick, per tenant this instance serves:
 *
 *   GET  {platform}/tenants/{slug}/licence     -> licence_state, with last_success_at
 *   POST {platform}/telemetry/heartbeat        -> only with an instance token (CJ1)
 *
 * A poll that FAILS touches `last_checked_at` and deliberately not `status`: unreachable is not
 * passive (CG3), and the cached status stands until the grace window expires. That single
 * distinction is what keeps a merchant's shop selling through an outage of ours.
 *
 * The heartbeat is pushed only by a DEDICATED instance, because CJ1 says pooled usage is
 * something we measure ourselves -- our own database is right there. A pooled store reporting
 * counts back to the control plane would be telemetry we could have computed, arriving over the
 * network, from a process that could have got it wrong.
 */
import type { LicencePollResult } from '@mercatus/contracts';
import { licencePollResultSchema } from '@mercatus/contracts';
import type { StoreDeps } from '../deps.js';
import {
  countOrders,
  countProducts,
  listTenantDirectory,
  recordLicenceAttempt,
  recordLicenceSuccess,
  withExplicitTenantTx,
} from '@mercatus/db-store';
import type { FastifyBaseLogger } from 'fastify';

export interface LicenceAgent {
  /** One tick, awaited. Exported for the test and for the first tick at boot. */
  tick(): Promise<void>;
  stop(): void;
}

interface Target {
  readonly id: string;
  readonly slug: string;
}

/**
 * A poll must not outlive its own interval, or a stalled control plane silently turns the agent
 * into a queue of pending fetches. Two thirds of the interval, floored at a second.
 */
function timeoutMs(pollSeconds: number): number {
  return Math.max(1000, Math.floor(pollSeconds * 1000 * (2 / 3)));
}

export function startLicenceAgent(deps: StoreDeps, log: FastifyBaseLogger): LicenceAgent {
  const { config } = deps;
  const platformUrl = config.platformUrl;
  // The pooled plane polls with the shared internal credential; a dedicated one with its own
  // revocable instance token (CE1). Holding neither means this instance was not configured to
  // talk to a control plane at all, which is a legitimate deployment -- and `runtimeState` treats
  // "never polled" as healthy for exactly that reason.
  const credential = config.instanceToken ?? config.internalToken;

  if (!platformUrl || !credential) {
    log.info(
      { platformUrl: platformUrl ?? null, credential: credential ? 'set' : 'absent' },
      'licence agent disabled: no control plane configured',
    );
    return { tick: () => Promise.resolve(), stop: () => undefined };
  }

  const headers = { authorization: `Bearer ${credential}`, accept: 'application/json' };
  const timeout = timeoutMs(config.licencePollSeconds);

  async function targets(): Promise<Target[]> {
    if (config.mode === 'dedicated') {
      const slug = config.tenantSlug;
      if (!slug) return [];
      const ref = await deps.tenants.bySlug(slug);
      return ref ? [{ id: ref.id, slug: ref.slug }] : [];
    }
    // `tenants` is the one data-plane table without RLS -- a policy on it would need the context
    // that reading it produces -- so the agent can enumerate what this instance serves. It does
    // so through the SECURITY DEFINER directory (F2), which returns id and slug and nothing
    // else: the app role has no SELECT on the table itself any more.
    return listTenantDirectory(deps.db);
  }

  async function pull(slug: string): Promise<LicencePollResult> {
    const response = await fetch(`${platformUrl}/tenants/${slug}/licence`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`licence poll for ${slug} answered ${String(response.status)}`);
    // The control plane is a separate deployable with its own release cadence (CH1), so its
    // answer is parsed rather than trusted. A shape we do not recognise is a failed poll, which
    // means the cached licence keeps serving instead of an undefined reaching the gate.
    return licencePollResultSchema.parse(await response.json());
  }

  async function push(target: Target, result: LicencePollResult): Promise<void> {
    if (!config.instanceToken) return;
    const counts = await withExplicitTenantTx(deps.db, target.id, async (tx) => ({
      productCount: await countProducts(tx),
      orderCount: await countOrders(tx),
    }));
    // Five scalars and not one thing about a person (CI1). The numbers are telemetry, not
    // metering: the customer has root on this box and can edit them, so limits are enforced
    // through the signed licence instead (CE3).
    const response = await fetch(`${platformUrl}/telemetry/heartbeat`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        version: deps.version,
        tenantId: target.id,
        licenceId: result.licenceId,
        productCount: counts.productCount,
        orderCount: counts.orderCount,
      }),
    });
    if (!response.ok) throw new Error(`heartbeat answered ${String(response.status)}`);
  }

  async function poll(target: Target): Promise<void> {
    try {
      const result = await pull(target.slug);
      await withExplicitTenantTx(deps.db, target.id, (tx) =>
        recordLicenceSuccess(tx, target.id, {
          status: result.status,
          entitlements: result.entitlements,
          validUntil: result.validUntil,
        }),
      );
      await push(target, result);
    } catch (error) {
      // Not an error level. Being unreachable is an expected state with a designed behaviour,
      // and logging it as a failure every few seconds during an outage buries the one line that
      // matters, which is the transition into read_only.
      log.warn({ tenant: target.slug, err: error }, 'licence poll failed; cached licence stands');
      await withExplicitTenantTx(deps.db, target.id, (tx) => recordLicenceAttempt(tx, target.id));
    }
  }

  async function tick(): Promise<void> {
    const list = await targets();
    // Sequential. A pooled instance has a handful of tenants and the control plane is one
    // process; a burst of parallel polls every few seconds would be a self-inflicted load test.
    for (const target of list) await poll(target);
  }

  let running = false;
  const timer = setInterval(() => {
    // Skip rather than overlap. A slow control plane must not stack ticks.
    if (running) return;
    running = true;
    void tick()
      .catch((error: unknown) => {
        log.error({ err: error }, 'licence agent tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, config.licencePollSeconds * 1000);
  timer.unref();

  log.info(
    { platformUrl, pollSeconds: config.licencePollSeconds, mode: config.mode },
    'licence agent started',
  );

  return { tick, stop: () => clearInterval(timer) };
}
