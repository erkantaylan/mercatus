# 01 — monorepo foundation

**Status:** done
**Gate:** `pnpm install` → 0, `pnpm turbo run typecheck lint` → 0 (10 tasks), and additionally
`pnpm -r typecheck` → 0, `pnpm -r lint` → 0, `pnpm -r test` → 0 (8 tests).
Beyond the stated gate, two things were *executed* rather than compiled: the core test suite mints
and verifies real HS256 tokens, and a `tsx` probe imported `@mercatus/core` from inside
`packages/contracts` at runtime, proving the source-only `exports` layout resolves with no build
step. The probe printed a real staff principal and a parsed error envelope, then was deleted.

## What I built

Root: `package.json`, `pnpm-workspace.yaml` (catalog exactly as BUILD-PLAN §2, one correction),
`turbo.json`, `tsconfig.base.json`, `eslint.config.js`, `.npmrc`.

`packages/core` — the real content of this task:

- `src/errors.ts` — `ERROR_CODES` (the single list), `MercatusError` base carrying `code`,
  `status`, serialisable `details` and non-serialisable `logDetail` (S1), eleven subclasses
  including `LicencePassiveError` (402) and `ControlPlaneUnreachableError` (503) kept apart per
  CG3, plus `toErrorEnvelope(unknown)` which turns anything unrecognised into a bare `INTERNAL`.
- `src/paging.ts` — `PagedResult<T>` = `{ items, total }`, `pagedResult()`,
  `normalisePageRequest()` clamping to 1..200, default 50.
- `src/tenant/context.ts` — AsyncLocalStorage, `runInTenant` / `currentTenant` / `tryCurrentTenant`,
  verbatim from BUILD-PLAN §3.1.
- `src/auth/types.ts` — the adapter interface verbatim from §4.1, split into named param types.
- `src/auth/stub-adapter.ts` — `StubAuthAdapter`, working. HS256 via `jose`. Implements all five
  interface methods and adds `issueStaffToken` / `issueShopperToken` for task 03's `/dev/login`.
- `src/auth/factory.ts` — `createAuthAdapter`, which throws `CONFIG_INVALID` for `oidc`.
- `src/core.test.ts` — 8 vitest tests: staff and shopper round-trip, four rejection paths,
  exchange + `tokenForTenant`, the production refusal, tenant context in and out, envelopes.

`packages/contracts` — not a stub. `errorCodeSchema` / `errorEnvelopeSchema` derived from core's
`ERROR_CODES`, so the workspace's first cross-package import is exercised by the gate.

`packages/db-store`, `packages/db-platform`, `packages/ui` — valid empty packages
(`export {}` + a comment saying which task fills them).

`apps/` exists with a `.gitkeep`; no apps yet.

## The token shape, since everything downstream depends on it

HS256 JWT, `iss: "mercatus-stub"`, and the audience split is the type split:

| aud | claims | is a Principal |
|---|---|---|
| `staff` | `sub`, `tid` (tenant **uuid**), `roles: ("owner"\|"staff")[]`, `exp` | yes |
| `shopper` | `sub`, `exp`, **no `tid`** | yes |
| `refresh` | `sub`, `roles?`, `exp` | no — it only buys an access token |

A `shopper` token carrying `tid` is rejected by `verify()`, because BI2 only holds while a
shopper's tenant comes from the route. `verify()` returns `null` for every bad token and never
throws. Access tokens 900s, refresh 86400s.

## What the next agent needs to know

1. **Read `lessons/01-monorepo-foundation.md`** — `@eslint/js` is not at eslint's version number,
   and pnpm 12 fails the install on an unapproved build script.
2. `pnpm install && pnpm turbo run typecheck lint` is green right now. Keep it that way; it is
   every later task's smoke test.
3. `@mercatus/ui` was created, **not** `packages/clients` — BUILD-PLAN §1 and task 00's decision.
   The task brief said "clients"; the docs win.
4. Packages ship TypeScript source (`"exports": { ".": "./src/index.ts" }`) and have **no build
   script**. `tsc --noEmit` is the typecheck; `tsx`, Vite and Next consume the source directly.
   Verified at runtime, not assumed.
5. Relative imports are written with a `.js` extension (`./errors.js`). `moduleResolution` is
   `bundler`, which maps it back to `.ts`, and real Node ESM needs it. Keep doing that.
6. `StubAuthAdapter.exchange('stub:staff:<sub>:<tenant>')` needs a **uuid** for `<tenant>` unless
   you pass `resolveTenantId`. Task 03 should wire that to the `tenants` lookup and then the code
   accepts a slug.
7. `AUTH_STUB_SECRET` must be **at least 32 characters**; the adapter throws at construction
   otherwise, and so would jose.
8. Nothing in `packages/core` reads config yet. `src/config.ts` (BUILD-PLAN §8.2) is task 03's,
   and `createAuthAdapter` takes a narrow options object meant to be fed from it.

## State left behind

- No containers started, no AppHost run, no ports bound. `docker ps` untouched.
- `~/.claude/settings.json` untouched — `aspire` was not run.
- One commit on `main`; `pnpm-lock.yaml` is committed.
