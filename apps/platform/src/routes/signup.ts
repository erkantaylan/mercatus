/**
 * `POST /signup` -- buy a store (architecture.md §6, Q13).
 *
 * SIGNUP CREATES THE TENANT; PAYMENT ACTIVATES IT. That split is the reason trials, internal demo
 * stores and manually onboarded merchants exist without anyone faking a bank callback, and it is
 * why the tenant row is committed BEFORE the bank is called: if fake-bank is unreachable, the
 * buyer retries the same slug and resumes the pending tenant rather than colliding with it (CK2).
 *
 * The tenant id is minted here and is ours. fake-bank's reference is written to `payment_ref`, an
 * attribute of the row (BV1).
 */
import { errorEnvelopeSchema, signupBodySchema, signupResultSchema } from '@mercatus/contracts';
import type { MercatusServer } from '@mercatus/core';
import { ConflictError, MercatusError } from '@mercatus/core';
import {
  findTenantBySlug,
  insertPayment,
  insertTenant,
  setTenantPaymentRef,
  upsertMembership,
  upsertUserByPhone,
} from '@mercatus/db-platform';
import { randomUUID } from 'node:crypto';

import { BankUnreachableError } from '../bank.js';
import type { PlatformDeps } from '../deps.js';

export function registerSignupRoute(app: MercatusServer, deps: PlatformDeps): void {
  app.post(
    '/signup',
    {
      schema: {
        summary: 'Buy a store: create the user, the pending tenant, and a payment',
        description:
          'Returns the fake-bank page to pay on. The tenant is created `pending` and stays ' +
          'pending until the signed callback arrives -- nothing here activates anything.',
        tags: ['buy-a-store'],
        body: signupBodySchema,
        response: {
          201: signupResultSchema,
          409: errorEnvelopeSchema,
          502: errorEnvelopeSchema,
        },
      },
    },
    async (req, reply) => {
      const { phone, name, storeName, slug, tier } = req.body;

      const tenant = await deps.db.transaction(async (tx) => {
        const user = await upsertUserByPhone(tx, { phone, name });
        const existing = await findTenantBySlug(tx, slug);
        if (existing) {
          if (existing.status !== 'pending') {
            throw new ConflictError(`The store "${slug}" already exists.`, { details: { slug } });
          }
          // A retry after a failed payment. Same tenant, same id, a fresh payment below.
          await upsertMembership(tx, { userId: user.id, tenantId: existing.id, role: 'owner' });
          return existing;
        }
        const created = await insertTenant(tx, { slug, name: storeName, tier });
        await upsertMembership(tx, { userId: user.id, tenantId: created.id, role: 'owner' });
        return created;
      });

      // Our own payment id, minted before the bank sees it, so the reference we sign is ours and
      // the bank's id is theirs. Two identifiers, neither pretending to be the other.
      const paymentId = randomUUID();
      let payment;
      try {
        payment = await deps.bank.createPayment({
          reference: paymentId,
          amountMinor: deps.config.planPriceMinor,
          currency: deps.config.planCurrency,
          callbackUrl: `${deps.config.platformUrl}/payments/callback`,
        });
      } catch (error) {
        if (error instanceof BankUnreachableError) {
          req.log.error({ err: error, slug }, 'fake-bank did not take the payment');
          throw new MercatusError('INTERNAL', 502, 'The payment provider is not answering.', {
            logDetail: error.message,
            cause: error,
          });
        }
        throw error;
      }

      await deps.db.transaction(async (tx) => {
        await insertPayment(tx, {
          id: paymentId,
          tenantId: tenant.id,
          providerRef: payment.providerRef,
          amountMinor: deps.config.planPriceMinor,
          currency: deps.config.planCurrency,
        });
        await setTenantPaymentRef(tx, tenant.id, payment.providerRef);
      });

      req.log.info({ slug, tenantId: tenant.id, providerRef: payment.providerRef }, 'signup');
      reply.status(201);
      return { tenantId: tenant.id, slug: tenant.slug, paymentUrl: payment.paymentUrl };
    },
  );
}
