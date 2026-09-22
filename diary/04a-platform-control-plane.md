# 04a — apps/platform, the control plane

Built `apps/platform` and extended `packages/db-platform`. Nothing outside those two was touched
except one line in `turbo.json` (see below). `apps/fake-bank` was being written by another agent
at the same time and landed as commit `01ca980` while this task ran; the gate below was re-run
against the real one afterwards.

## What exists now

`apps/platform` — Fastify, port 4001, booted with `createServer()` from `@mercatus/core`:

| Method | Path | Credential |
|---|---|---|
| GET | `/health` | none |
| GET | `/docs/`, `/docs/openapi.json` | none |
| POST | `/signup` | none |
| POST | `/payments/callback` | HMAC in the body |
| GET | `/licence/jwks` | none |
| POST | `/dev/login/operator` | none, stub adapter only |
| GET | `/tenants`, `/tenants/:slug` | operator |
| POST | `/tenants` | operator |
| POST | `/tenants/:slug/activate` | operator |
| POST | `/tenants/:slug/licence` | operator |
| GET | `/tenants/:slug/licence` | operator **or** instance |
| GET | `/tenants/:slug/licence/signed` | operator **or** instance |
| POST | `/installations`, GET `/installations` | operator |
| POST | `/installations/register` | bootstrap token in the body |
| POST | `/telemetry/heartbeat` | instance |

Files: `src/{index,app,config,deps,auth,bank,signature,licence,mappers,schemas}.ts`,
`src/routes/{health,signup,payments,tenants,licences,installations,telemetry,dev-login}.ts`,
`keys/dev-licence-private.pem`, `test/platform.test.ts` (22 tests).

`packages/db-platform` gained `src/repositories/{users,tenants,licences,installations,payments}.ts`,
a `PlatformExecutor` type in `client.ts`, and migration `0001_reflective_martin_li.sql`, which
adds `licences.id` (uuid, unique — what a heartbeat's `licenceId` names) and
`installations.licence_id`.

## Three credentials, none of them a merchant's token

- **operator** — HS256 JWT, `iss: mercatus-platform-stub`, `aud: operator`, minted by
  `POST /dev/login/operator`. A merchant's `aud: staff` token is refused on every console route,
  which is BH1 as a property of the token rather than of a code path.
- **instance** — 32 random bytes, base64url, stored only as sha256. Per installation, revocable
  by nulling one row (CE1). It may read its own tenant and answers 403 for any other.
- **bootstrap** — one-time, in the body of `/installations/register`, burned by the same
  conditional `update` that issues the instance token, so two boxes racing it cannot both win.

## The licence is Ed25519, not HMAC

`GET /tenants/:slug/licence/signed` returns a JWT signed with an Ed25519 key; the public half is
published at `GET /licence/jwks`. A dedicated store caches the key set and verifies **offline**
(CG1) while holding nothing that could mint a licence (CE1) — which a shared HMAC secret on a
customer's VPS would have been. `exp` is the end of `valid_until`, not a session lifetime: the
grace window for an unreachable control plane is a separate clock that lives in the data plane.

## Gate — run, not claimed

Postgres 18.3 in a throwaway container, `platform` and `store` databases, both migrated and
seeded. The real `apps/fake-bank` on 4004, `apps/platform` on 4001.

```
POST /dev/login/operator                      -> operator token
POST /signup  {slug: orbit, tier: pooled}     -> 201 {tenantId, paymentUrl}
GET  /tenants/orbit                           -> status=pending, licence=null
POST http://127.0.0.1:4004/pay/<id>/complete  -> fake-bank: delivered=true httpStatus=204
GET  /tenants/orbit                           -> status=active, activatedAt set,
                                                 licence {status: active, validUntil: 2027-09-22}
GET  /tenants/orbit/licence/signed            -> {licence: <jwt>, licenceId, keyId, expiresAt}
GET  /licence/jwks                            -> {keys:[{kty:OKP, crv:Ed25519, kid, alg:EdDSA}]}
kill the platform, then verify the JWT from the cached key set:
    VERIFIED OFFLINE: {slug: orbit, status: active, licenceId, iss, aud, exp}
    tampered licence REFUSED: signature verification failed
```

Failure paths, also curled end to end:

- fake-bank set to `bad-hash` → its callback is refused **401**, tenant stays `pending`.
- fake-bank set to `decline` → 204, tenant stays `pending` and keeps its slug for a retry.
- a callback replayed → 204, and `GET /tenants/:slug` is byte-identical (CK2).
- a callback whose amount disagrees with our payment row → 409.
- a bootstrap token presented twice → 401.
- an instance token on `/tenants/acme/licence` → 403.
- a merchant's staff token on `/tenants` → 401.

Then the earlier sequence, driven entirely by curl with the callback signed by hand (the
"fake-bank stubbed by curl" path the task allowed), produced the same results for tenant `zenith`,
including install → register → heartbeat → `GET /installations` showing
`version 1.0.0, licenceId, productCount 4, orderCount 2`, and the passive flip showing
`status: passive` in both the poll and the next signed licence.

`pnpm check` at the repo root: **23 tasks successful**, 179 tests, nothing skipped
(`@mercatus/platform` 22, `@mercatus/fake-bank` 17, `@mercatus/db-store` 69, `@mercatus/store` 17,
`@mercatus/contracts` 25, `@mercatus/core` 18, `@mercatus/db-platform` 11).

Machine left as found: container removed, both processes killed, `docker ps` shows only the
unrelated `chess-trainer`.

## What the next agent needs to know

1. **`PLATFORM_DATABASE_URL`.** The platform suite reads it and falls back to `DATABASE_URL`. One
   `DATABASE_URL` cannot be both the `store` and the `platform` database during `pnpm check`, and
   the data-plane suites already own that name. It is declared in `turbo.json`'s `test` task —
   that one line is the only edit outside this task's two directories, and it was made because
   lesson 03 says a variable turbo does not know about is a suite that skips while the run stays
   green.
2. **`loadPlatformConfig()` is in `apps/platform/src/config.ts`, not in `@mercatus/core`.** It
   belongs in core per §8.2 and depends on nothing in this app; it was kept local only because
   another agent was editing neighbouring shared files at the same moment. Moving it is a cut and
   a paste.
3. **New shapes are in `apps/platform/src/schemas.ts`**, written in the contracts style against
   the contracts primitives: `createTenantBodySchema`, `activateTenantBodySchema`,
   `signedLicenceSchema`, `jwksSchema`, `installationSchema`, `installationListSchema`,
   `devOperatorLoginBodySchema`. Task 08 should move them into
   `packages/contracts/src/platform.ts` when it builds the console that consumes them.
4. **`POST /payments/proxy` was not built.** §6.1 lists it; nothing needs it yet, because
   checkout in the data plane ends at "ordered" and takes no money. It is the one endpoint from
   §6.1 that is missing.
5. **`PATCH /api/settings` still has no home.** Task 03 argued it belongs on the control plane
   because store name and branding are mirrored facts. It is not built here either; the platform
   has no "update tenant name" endpoint yet.
6. **The dev licence key is committed** at `apps/platform/keys/dev-licence-private.pem` and
   refused under `NODE_ENV=production`. There is no public PEM — the public half is derived at
   boot, so the two cannot disagree.
7. **The heartbeat's `licenceId` is now real.** `licences.id` exists, the signed licence carries
   it, and `GET /installations` shows what the box last reported. A store that polls its licence
   should send that id back.
