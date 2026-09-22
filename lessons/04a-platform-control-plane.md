# 04a — apps/platform, the control plane

## A 204 under `fastify-type-provider-zod`

- `reply.status(204)` is a **type error** unless `204` is a key in the route's `response` map:
  `Argument of type '204' is not assignable to parameter of type '401 | 404 | 409'`.
- Declare `204: z.null()`, then `await reply.status(204).send(null);` and return nothing. Returning
  `null` from the handler instead fails with `Type 'Promise<null>' is not assignable to …`.
- Fastify strips the body for a 204 regardless: `curl -i` shows `HTTP/1.1 204 No Content`, no
  `content-length`, no body. The `z.null()` never reaches the wire.

## `CryptoKey` is not in `lib: ES2023`

- Writing `KeyObject | CryptoKey | Uint8Array` in your own interface — the union jose uses —
  gives `TS2304: Cannot find name 'CryptoKey'`. There is no DOM lib here and `types: ["node"]`
  does not supply it. Do not restate jose's key types; keep the key inside the module.
- Likewise `createPublicKey({ key: jwk, format: 'jwk' })` will not typecheck from a
  `Record<string, unknown>`. Use **`importJWK(jwk, 'EdDSA')`** from jose instead; it is one line
  and needs no cast.

## jose 6.2.12 and Ed25519

- `importPKCS8(pem, alg)` / `importSPKI(pem, alg)` accept **both `'EdDSA'` and `'Ed25519'`** as
  the alg for an ed25519 key. `EdDSA` is the JWA name and is what ends up in the JWT header.
- `exportJWK(publicKey)` → `{crv: 'Ed25519', x, kty: 'OKP'}`; `calculateJwkThumbprint(jwk)` gives
  a stable `kid` (RFC 7638) that changes only when the key does.
- Generate the pair with node, not openssl:
  `crypto.generateKeyPairSync('ed25519')` then `.export({type:'pkcs8'|'spki', format:'pem'})`.
- `createPublicKey(privatePem).export({type:'spki',format:'pem'})` derives the public half, so a
  `LICENCE_PUBLIC_KEY` variable is not needed and cannot drift from the private one.

## drizzle 0.45.3: a db-or-transaction union typechecks

- `export type PlatformExecutor = PlatformDb | PlatformTx;` and then
  `function f(db: PlatformExecutor)` calling `db.select()`, `.insert()`, `.update()` compiles with
  no cast under `strict` + `noUncheckedIndexedAccess`. Worth knowing before writing two overloads
  for every repository function in a database that has no RLS to force a transaction.
- `.set({ activatedAt: sql\`coalesce(${tenants.activatedAt}, now())\` })` works inside `update()`
  — a column reference interpolates as a column, not as a parameter.
- `onConflictDoUpdate({ target: users.phone, … })` takes a bare column; the composite form takes
  an array: `target: [memberships.userId, memberships.tenantId]`.

## One `DATABASE_URL` cannot serve two databases

- `pnpm check` runs every package's suite at once. `@mercatus/db-store` and `@mercatus/store` want
  `DATABASE_URL` pointed at `store`; `@mercatus/platform` wants `platform`. The platform suite
  therefore reads **`PLATFORM_DATABASE_URL`** and falls back to `DATABASE_URL`.
- It had to be added to `turbo.json`'s `test` task `env` list, exactly as lesson 03 warns: a
  variable turbo does not know about is a suite that skips while the run stays green.
- Two databases in one container is otherwise painless — `sql/00-roles.sql` in both packages uses
  `current_database()`, and the platform's `revoke connect … from public` makes
  `mercatus_app` unable to open `platform` while both live in one cluster.

## Running a one-off TypeScript probe

- A `.ts` file in the scratchpad run by `tsx` is treated as **CJS** (no `package.json` with
  `"type": "module"` above it): `Top-level await is currently not supported with the "cjs" output
  format`. Renaming to `.mts` fixes that and then fails differently —
  `ERR_MODULE_NOT_FOUND: Cannot find package 'jose'`, because resolution starts at the file.
- Put the probe **inside the package** (`apps/platform/src/__probe.mts`), run it, delete it. Same
  conclusion lesson 04b reached from the other direction.

## pnpm

- After adding a new workspace package, plain `pnpm install` prints `Already up to date` but
  **has** linked it — `Scope: all 9 workspace projects` on the next command is the tell.
  `pnpm install --force` is not needed and re-downloads ~330 packages including other platforms'
  binaries.

## The fake-bank contract, as actually implemented

Written independently by two agents in the same hour, and they agree. Verified by reading
`apps/fake-bank/src/signing.ts`:

- request canonical: `reference|amountMinor|currency|callbackUrl`
- callback canonical: `providerRef|status|amountMinor|currency`
- lowercase hex `HMAC-SHA256(FAKE_BANK_HMAC_SECRET, canonical)` in both directions.
- fake-bank's `POST /payments` answers `{id, providerRef, reference, amountMinor, currency,
  status, behaviour, paymentUrl, createdAt}`. **`providerRef` (`fb_<id>`) is what the callback
  carries, not `id`.** A client that stores `id` as `payments.provider_ref` will never match a
  callback.
- fake-bank's config demands `FAKE_BANK_HMAC_SECRET` of **at least 32 characters**. A shorter
  secret boots the platform and fails the bank, so require 32 on both sides.
- `POST /pay/:id/complete {"behaviour":"bad-hash"}` is a one-command test of your own callback
  verifier: it reports `delivered: false, httpStatus: 401` when you refuse it correctly.
- The callback is awaited before `/complete` answers, so no polling is needed in a shell gate.

## Small things

- `z.uuid()` on a path parameter: reuse `tenantSchema.pick({ slug: true })` for `:slug` params
  rather than writing another `z.object({slug: slugSchema})` — it keeps the OpenAPI document
  naming one schema.
- A `.default({})` on a whole body object makes `POST` with `-d '{}'` and with no body both work
  under Fastify's validator; `devOperatorLoginBodySchema` and `activateTenantBodySchema` use it.
  (`.nullish()` is still what lesson 04b needs for a body that may be absent entirely.)
- `git add -A` in a shared worktree sweeps the other agent's files in. Add explicit paths.
