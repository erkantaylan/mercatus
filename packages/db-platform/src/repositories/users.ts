/**
 * Users of the control plane -- merchant staff, not shoppers. A shopper is a row in a store's own
 * database and never appears here (CD3).
 *
 * No RLS in this database and therefore no tenant transaction: `PlatformDb` and `PlatformTx` are
 * interchangeable everywhere below, which is why every function takes `PlatformExecutor`.
 */
import { eq } from 'drizzle-orm';

import type { PlatformExecutor } from '../client.js';
import type { MembershipRole, UserRow } from '../schema.js';
import { memberships, users } from '../schema.js';

export async function findUserByPhone(db: PlatformExecutor, phone: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  return rows[0] ?? null;
}

/**
 * Signup is the same operation for a returning buyer and a new one, so this is an upsert on the
 * login identity rather than an insert that can fail on the second store someone buys (BA1).
 */
export async function upsertUserByPhone(
  db: PlatformExecutor,
  input: { phone: string; name: string },
): Promise<UserRow> {
  const rows = await db
    .insert(users)
    .values({ phone: input.phone, name: input.name })
    .onConflictDoUpdate({ target: users.phone, set: { name: input.name } })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('upsertUserByPhone returned no row');
  return row;
}

/** (user_id, tenant_id, role). One person, several merchants, from day one (BA1). */
export async function upsertMembership(
  db: PlatformExecutor,
  input: { userId: string; tenantId: string; role: MembershipRole },
): Promise<void> {
  await db
    .insert(memberships)
    .values({ userId: input.userId, tenantId: input.tenantId, role: input.role })
    .onConflictDoUpdate({
      target: [memberships.userId, memberships.tenantId],
      set: { role: input.role },
    });
}
