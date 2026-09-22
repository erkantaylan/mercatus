/**
 * The cheap half of BL1, and it needs no database.
 *
 * The expensive failure this catches is "someone adds a table and forgets the policy". That table
 * then has no RLS, the leak suite does not know to test it, and everything stays green. So this
 * reads the generated migrations and sql/02-rls.sql and asserts, mechanically, that every table
 * the schema creates -- except the one documented exception -- is enabled, forced, has a policy
 * using the tenant GUC, and is granted to the app role.
 *
 * It runs in every `pnpm -r test`, with or without a Postgres. leak.test.ts proves the policies
 * actually work; this proves they exist at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RLS_TABLES } from '../src/schema.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const migrationSql = readdirSync(join(packageRoot, 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(packageRoot, 'migrations', f), 'utf8'))
  .join('\n');

const rlsSql = readFileSync(join(packageRoot, 'sql', '02-rls.sql'), 'utf8');
const rolesSql = readFileSync(join(packageRoot, 'sql', '00-roles.sql'), 'utf8');

/** `tenants` is the documented exception: it is the lookup that establishes tenant context. */
const NO_RLS_BY_DESIGN = new Set(['tenants']);

function tablesInMigrations(): string[] {
  return [...migrationSql.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1] ?? '');
}

describe('schema / policy coverage (BL1)', () => {
  it('every table the migrations create is either RLS-protected or the documented exception', () => {
    const created = tablesInMigrations();
    expect(created.length).toBeGreaterThan(0);
    const uncovered = created.filter(
      (t) => !NO_RLS_BY_DESIGN.has(t) && !RLS_TABLES.includes(t as (typeof RLS_TABLES)[number]),
    );
    expect(uncovered).toEqual([]);
  });

  it('RLS_TABLES names no table that does not exist', () => {
    const created = new Set(tablesInMigrations());
    expect(RLS_TABLES.filter((t) => !created.has(t))).toEqual([]);
  });

  for (const table of RLS_TABLES) {
    describe(table, () => {
      it('is enabled AND forced -- without FORCE the owner is exempt from its own policies', () => {
        expect(rlsSql).toContain(`alter table ${table} enable row level security;`);
        expect(rlsSql).toContain(`alter table ${table} force row level security;`);
      });

      it('has a policy with both using and with check, on the tenant GUC', () => {
        const policy = new RegExp(
          `create policy ${table}_tenant_isolation on ${table}\\s*` +
            `using\\s*\\(tenant_id = nullif\\(current_setting\\('app\\.tenant_id', true\\), ''\\)::uuid\\)\\s*` +
            `with check \\(tenant_id = nullif\\(current_setting\\('app\\.tenant_id', true\\), ''\\)::uuid\\)`,
        );
        expect(rlsSql).toMatch(policy);
      });

      it('uses nullif -- a bare cast of the empty string raises instead of returning nothing', () => {
        // The GUC reverts to '' rather than NULL once a session has ever set it, so a policy
        // without nullif fails with `invalid input syntax for type uuid: ""` on a reused pooled
        // connection. Intermittent by construction, which is the worst kind.
        const bareCast = new RegExp(`on ${table}[\\s\\S]{0,400}current_setting\\('app\\.tenant_id', true\\)::uuid`);
        expect(rlsSql).not.toMatch(bareCast);
      });

      it('grants DML to the app role', () => {
        expect(rlsSql).toContain(`grant select, insert, update, delete on table ${table} to mercatus_app;`);
      });
    });
  }

  it('tenants is reachable only through the SECURITY DEFINER lookups (F2)', () => {
    // The direct grant is gone: in a pooled deployment it let any code path with a store
    // connection enumerate every merchant on the box.
    expect(rlsSql).toContain('revoke all on table tenants from mercatus_app;');
    expect(rlsSql).not.toMatch(/^\s*grant[^;]*on table tenants/m);
    for (const fn of ['mercatus_tenant_by_slug(text)', 'mercatus_tenant_by_id(uuid)', 'mercatus_tenant_directory()']) {
      // EXECUTE is granted to PUBLIC by default; a definer function left that way IS the leak.
      expect(rlsSql).toContain(`revoke all on function ${fn} from public;`);
      expect(rlsSql).toContain(`grant execute on function ${fn} to mercatus_app;`);
    }
    // A definer function without a pinned search_path lets its caller choose which table it reads.
    const definers = [...rlsSql.matchAll(/security definer/g)];
    expect(definers.length).toBe(3);
    expect([...rlsSql.matchAll(/set search_path = public, pg_temp/g)].length).toBe(3);
  });

  it('the data plane database refuses PUBLIC a connection (F3)', () => {
    expect(rolesSql).toMatch(/revoke connect on database %I from public/);
  });

  it('every foreign key in the migrations is composite with tenant_id (F1)', () => {
    // The structural half of the cross-tenant denial of service: referential integrity runs with
    // row security OFF, so a single-column FK lets one tenant pin another tenant's rows.
    const fks = [...migrationSql.matchAll(/FOREIGN KEY \(([^)]*)\)/g)];
    expect(fks.length).toBeGreaterThan(0);
    const naked = fks.map((m) => m[1] ?? '').filter((cols) => !cols.includes('tenant_id'));
    expect(naked, 'a single-column foreign key crosses tenants -- see OPEN-DEFECTS F1').toEqual([]);
  });

  it('the app role is created without BYPASSRLS and without SUPERUSER (BE2)', () => {
    expect(rolesSql).toMatch(/alter role mercatus_app\s+with login nosuperuser nobypassrls/);
  });

  it('every composite unique index in the migrations leads with tenant_id (BG1)', () => {
    const indexes = [...migrationSql.matchAll(/CREATE UNIQUE INDEX "([a-z_]+)" ON "([a-z_]+)" USING btree \(([^)]*)\)/g)];
    expect(indexes.length).toBeGreaterThan(0);
    for (const match of indexes) {
      expect(match[3]).toMatch(/^"tenant_id"/);
    }
  });
});
