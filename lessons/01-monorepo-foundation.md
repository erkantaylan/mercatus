# 01 — monorepo foundation

## npm versions, corrected

- **`@eslint/js@10.11.0` does not exist.** eslint is at `10.11.0`, `@eslint/js` at `10.0.1`.
  `npm view @eslint/js version` → `10.0.1`. Catalog it as `^10.0.1`, not as eslint's version.
- `typescript-eslint@8.70.1` peers are
  `{"eslint": "^8.57.0 || ^9.0.0 || ^10.0.0", "typescript": ">=4.8.4 <6.1.0"}` — **eslint 10 is
  in range**, so no `strict-peer-dependencies=false` is needed. The `typescript` half is still
  real: `5.9.3` yes, `7.0.2` no.
- Installed and working together: eslint 10.11.0, @eslint/js 10.0.1, typescript-eslint 8.70.1,
  typescript 5.9.3, @types/node 22.20.4, vitest 5.0.1, tsx 4.23.15, turbo 2.11.2, jose 6.2.12,
  zod 4.6.5.

## pnpm 12 will fail your install over a build script

```
Error: × installing dependencies
      ╰─▶ Ignored build scripts: esbuild@0.28.2
```

- It is a **fatal error**, not the warning pnpm 10 gave. `vitest 5` → `vite 8` → `esbuild`, so
  the first package with a test suite trips it.
- Fix: `pnpm approve-builds esbuild --yes` (non-interactive; `pnpm approve-builds` alone prompts).
- **`pnpm approve-builds` deletes `onlyBuiltDependencies` from `pnpm-workspace.yaml`** when it
  runs. The key is back in the file now; leave it.
- Afterwards the built artifact is cached in the pnpm store (`~/.local/share/pnpm/store/v11`), so
  `rm -rf node_modules && pnpm install` passes even with the key removed. That means **you cannot
  reproduce this failure on this machine any more** — it will only reappear on a clean store.

## pnpm 12 rewrites `pnpm-workspace.yaml` during install

It appends a `minimumReleaseAgeExclude:` list (11 `@typescript-eslint/*` entries here) for
packages younger than its `minimumReleaseAge` default, and it lands *between* your keys, taking
your comments with it. Do not fight it; re-read the file after installing.

## `pnpm-lock.yaml` is two YAML documents

`packageManager: pnpm@12.5.1` makes pnpm lock **itself** in a first document (`@pnpm/exe.*`
entries), then the project lock follows after a `---`. `head` of the file is not your project.
Build-script approvals are in **neither** document — they live in the store and in
`node_modules/.modules.yaml`, so they do not survive a clone.

## Things that worked first try, so do not re-derive them

- **ESLint 10 flat config searches ancestor directories.** One `eslint.config.js` at the root,
  `"lint": "eslint . --max-warnings 0"` in every package, cwd = the package. No per-package
  config, no `--config`. Verified by planting an unused variable: exit 1, correct rule name.
- **`moduleResolution: "bundler"` + `"exports": { ".": "./src/index.ts" }` + `workspace:*`** gives
  cross-package typechecking *and* runtime resolution with no build step. Verified with
  `tsx packages/contracts/src/__probe.ts` importing `@mercatus/core`. Write relative imports with
  `.js`; TS maps it back to `.ts`.
- `turbo@2` wants `"tasks"` (not `"pipeline"`) and a `packageManager` field in the root
  `package.json`, or it refuses to run.
- `pnpm -r test` prints `Scope: 5 of 6 workspace projects` and exits 0 when a package has no
  `test` script. A stub package needs no placeholder script.
- Whole gate is fast: `pnpm install` ~3s warm, `pnpm turbo run typecheck lint` ~1.7s cold,
  11ms cached. There is no reason to skip running it.

## jose

- **HS256 refuses a key shorter than 32 bytes.** `AUTH_STUB_SECRET` must be ≥ 32 characters;
  `StubAuthAdapter` now throws a named error at construction rather than letting jose fail at the
  first login.
- `new SignJWT(claims).setExpirationTime('-10s')` is accepted and produces an already-expired
  token — useful for testing the rejection path without faking a clock.

## Not verified, flagged for whoever hits it first

- Whether a package script finds `tsc`/`eslint` from the **root** `node_modules/.bin`: every
  package here declares `typescript` and `eslint` in its own devDependencies, so it was never
  tested. Cheapest fix if it bites: keep declaring them per package.
