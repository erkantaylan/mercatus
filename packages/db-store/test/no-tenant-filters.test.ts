/**
 * §3.5, enforced by grep rather than by review (G1).
 *
 * No application query in the data plane writes `where tenant_id = …`. Not as belt and braces,
 * not "just to be explicit". The whole value of BE1 is that a forgotten filter returns nothing
 * instead of another tenant's orders -- and you cannot test that property if the filters are
 * there, because then nothing distinguishes a correct policy from a missing one.
 *
 * The one exception is the tenant lookup itself, which is the query that establishes the context
 * every other query relies on.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

const SCANNED = [join(repoRoot, 'apps', 'store', 'src'), join(repoRoot, 'packages', 'db-store', 'src')];

/** The tenant lookup has no RLS to rely on: it is what produces the tenant context (§3.5). */
const ALLOWED = new Set([join(repoRoot, 'packages', 'db-store', 'src', 'repositories', 'tenants.ts')]);

/**
 * Matches a tenant predicate in either dialect: raw SQL (`where tenant_id =`) and Drizzle
 * (`eq(products.tenantId, …)`, `eq(t.tenant_id, …)`).
 */
const PATTERNS = [/where[\s\S]{0,80}?tenant_id\s*=/i, /\beq\(\s*[A-Za-z0-9_.]*\.?tenantId\s*,/];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('no application query filters by tenant (§3.5, BE1)', () => {
  const files = SCANNED.flatMap(walk).filter((f) => !ALLOWED.has(f) && !f.endsWith('seed.ts'));

  it('has something to scan', () => {
    // apps/store does not exist until task 03; db-store always does, so this never passes vacuously.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const pattern of PATTERNS) {
    it(`no file matches ${String(pattern)}`, () => {
      const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
      expect(offenders.map((f) => f.slice(repoRoot.length))).toEqual([]);
    });
  }
});
