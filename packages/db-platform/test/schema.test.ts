/**
 * Control-plane schema invariants that are cheap to assert and expensive to discover late.
 *
 * The important one is the last block. `tenants.id` is minted here and MIRRORED into every data
 * plane (BV1), so db-store's seed and this one have to name the same uuids. They are duplicated
 * rather than imported, because db-platform depending on db-store would put the control plane and
 * the data plane in one dependency graph -- exactly the boundary CO3 is about. So the agreement
 * is checked by reading the other package's source as text: a test-time file read, not an edge in
 * the build.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SEED_TENANT_IDS, SEED_USER } from '../src/seed.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const migrationSql = readdirSync(join(packageRoot, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(packageRoot, 'migrations', f), 'utf8'))
  .join('\n');

describe('control-plane migrations', () => {
  it('creates exactly the six tables in BUILD-PLAN §5.1', () => {
    const created = [...migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(created).toEqual([
      'installations',
      'licences',
      'memberships',
      'payments',
      'tenants',
      'users',
    ]);
  });

  it('has no row level security -- one database, one tenant, which is us', () => {
    expect(migrationSql.toLowerCase()).not.toContain('row level security');
  });

  it('keys memberships on (user_id, tenant_id) so one person can work for two merchants (BA1)', () => {
    expect(migrationSql).toMatch(
      /CONSTRAINT "memberships_user_id_tenant_id_pk" PRIMARY KEY\("user_id","tenant_id"\)/,
    );
  });

  it('mints its own tenant id rather than taking an external key (BV1)', () => {
    expect(migrationSql).toMatch(/CREATE TABLE "tenants" \(\s*"id" uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    // The payment reference is an attribute on the row, never the identifier of the row.
    expect(migrationSql).toMatch(/"payment_ref" text/);
  });

  it('makes the payment callback idempotent by provider_ref (CK2)', () => {
    expect(migrationSql).toMatch(/CONSTRAINT "payments_provider_ref_unique" UNIQUE\("provider_ref"\)/);
  });

  it('stores instance credentials only as hashes, individually revocable (CE1)', () => {
    expect(migrationSql).toContain('"bootstrap_token_hash" text');
    expect(migrationSql).toContain('"instance_token_hash" text');
    expect(migrationSql).not.toMatch(/"(bootstrap|instance)_token" text/);
  });
});

describe('seed constants agree with the data plane', () => {
  const storeSeed = readFileSync(join(repoRoot, 'packages', 'db-store', 'src', 'seed.ts'), 'utf8');

  it.each(Object.entries(SEED_TENANT_IDS))(
    'db-store seeds %s with the same uuid this package mints',
    (slug, id) => {
      expect(storeSeed).toContain(id);
      expect(storeSeed).toContain(`slug: '${slug}'`);
    },
  );

  it('zenith is not seeded anywhere -- it is created by provisioning (CK1)', () => {
    expect(Object.keys(SEED_TENANT_IDS)).not.toContain('zenith');
    expect(storeSeed).not.toContain('zenith');
  });

  it('the seed user is a phone identity in E.164', () => {
    expect(SEED_USER.phone).toMatch(/^\+[1-9]\d{6,14}$/);
  });
});
