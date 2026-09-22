# 08 — Logto 1.43 OSS: bootstrap, token shapes, and the store session

## The bootstrap is not a browser problem — `logto db seed` already made you an M2M app

- `docker run svhd/logto:1.43.0` with entrypoint `sh -c "npm run cli db seed -- --swe && npm start"`
  seeds and starts. The seed log line that matters is
  **`Created machine-to-machine applications for Management API proxy`**.
- It creates four applications, all in the **`admin`** tenant:
  `m-default` (Management API access for the `default` tenant), `m-admin`, `admin-console`,
  `Cloud Service`. **You do not need to click through the admin console to automate anything.**
- `m-default`'s secret is random per seed and sits in `applications.secret` as PLAIN TEXT:
  `psql -tAc "select secret from applications where id='m-default'"`. That one database read is
  the whole chicken-and-egg problem; everything after it is the Management API.
- The token comes from the **ADMIN endpoint**, the API lives on the **core endpoint**:

  ```bash
  curl -X POST http://127.0.0.1:3012/oidc/token -u "m-default:$SECRET" \
    -d 'grant_type=client_credentials&resource=https://default.logto.app/api&scope=all'
  curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:3011/api/organizations
  ```

## Management API gotchas, each one a 400 you will otherwise read twice

- An application created **through the API** has `#internal:<junk>` in `applications.secret`. The
  usable secret is `GET /api/applications/:id/secrets` → `[{name:"Default secret", value}]`.
  `GET /api/applications/:id` does **not** return a `secret` field at all.
- `POST /api/organizations` **ignores a supplied `id`** — the id is always generated. Put your
  own identifier in `name` (this repo uses the tenant slug) or `customData`.
- `organizationScopeNames` on `POST /api/organization-roles` is accepted and then **silently not
  applied**. Attach scopes with `POST /api/organization-roles/:id/scopes {organizationScopeIds}`.
- Usernames are validated against roughly `/^[A-Z_a-z]\w*$/`. `acme.owner` → 400
  `guard.invalid_input ... path:["username"]`. `acme_owner` is fine.
- `GET /users?page_size=200` → 400 `guard.invalid_pagination`. 100 is accepted.
- The relation endpoints (`/organizations/:id/users`, `.../roles`) answer `201` with the literal
  body **`Created`**, not JSON. `JSON.parse` on it throws `Unexpected token 'C'`.
- `/api/status` answers **204**, and there is no `/health`.

## Token shapes, measured

| | |
|---|---|
| organization token | `aud = "urn:logto:organization:<orgId>"`, ES384, `sub` = user id, **no role claim**, `scope` empty |
| id token | `aud = <clientId>`, carries `organizations: [orgId]` and `organization_roles: ["<orgId>:<role>"]` |
| access token | **opaque** unless a `resource` is requested. Do not assume a JWT |
| userinfo `/oidc/me` | the only place with `organization_data: [{id, name, description}]` — i.e. org id → name |

- **An organization token names an organization, not a tenant, and carries no roles.** Both gaps
  have to be filled from something cached at sign-in time. `packages/core/src/auth/oidc-adapter.ts`
  keeps `{orgId: {slug, roles: {sub: [...]}}} ` in its disk cache and defaults an unknown subject
  to the LEAST privilege.
- `resource=<your api>` on a refresh grant fails with `invalid_target` unless the user actually
  holds scopes on that resource. A store that issues its own session cookie never needs one.
- **`offline_access` in the scope is not enough to get a refresh token — you also need
  `prompt=consent` on the authorization request.** Without it the code exchange returns
  `access_token` + `id_token` and no `refresh_token`, and the organization token (which is a
  refresh grant) becomes impossible. This reads exactly like a scope bug and is not one.
- Organization scopes cannot be requested at the top-level authorization: they are filtered out of
  the granted scope, and asking for one on the organization-token request then fails with
  `invalid_scope: refresh token missing requested scope`. Roles come from the id token instead.

## Signing in with no browser — the Experience API

Logto has no password grant, and the PAT token-exchange grant is refused for Traditional and SPA
clients (`requested grant type is not allowed for this client`). The authorization-code flow is
the only way to a real user token, and it can be driven entirely with `curl -c/-b`:

```
GET  /oidc/auth?client_id=…&redirect_uri=…&response_type=code&scope=…&state=…&prompt=consent
PUT  /api/experience                      {"interactionEvent":"SignIn"}
POST /api/experience/verification/password {"identifier":{"type":"username","value":…},"password":…}
POST /api/experience/identification        {"interactionEvent":"SignIn","verificationId":…}
POST /api/experience/submit                {}            -> {"redirectTo": "/oidc/auth/<uid>"}
GET  <redirectTo>                                        -> 303 to your redirect_uri?code=…
```

- If that last GET redirects to **`/consent?app_id=…`**, grant it with
  **`POST /api/interaction/consent`** (note: `interaction`, not `experience` — there is no
  `/api/experience/consent`, it 404s) and follow the `redirectTo` it returns.
- The whole thing is `packages/identity/scripts/login-round-trip.sh`, which is the task's gate.

## Aspire

- `WithHttpHealthCheck(path)` **expects 200**. Logto's `/api/status` is 204, so the default makes
  the resource never go healthy and every `WaitFor` on it hangs forever, with nothing in the log
  but `changed state: Starting -> Waiting`. Use `WithHttpHealthCheck("/api/status", 204, "core")`.
- A **container** consuming another container's endpoint through
  `PrimaryEndpoint.Property(EndpointProperty.HostAndPort)` resolves correctly — Logto reached its
  Postgres with the same `SuperuserUrl(...)` helper the host-side executables use. Aspire's
  expression evaluation is consumer-aware; lesson 05's note about `localhost:<random port>` is
  about executables specifically.
- **`pnpm --filter <pkg> <script>` runs the script with cwd = the PACKAGE directory**, not the
  `workingDirectory` you gave `AddExecutable`. A relative output path in the environment therefore
  lands in `packages/<pkg>/`, not the repo root, and nothing warns you — the resource goes
  `Running -> Finished` and the file simply is not where the consumer looks. The AppHost passes
  `../../.identity/...` for that reason.
- Aspire's CLI detach log does **not** contain a resource's stdout. To find out what an executable
  actually printed, look at `/tmp/aspire-dcp*/<resource-name>/` or open the dashboard.
- `Environment.GetEnvironmentVariable(...)` in `apphost.cs` **is** inherited by the detached
  AppHost: `MERCATUS_AUTH_ADAPTER=oidc aspire run --detach` reached the store as `AUTH_ADAPTER=oidc`.

## Ports and images

- Logto's own defaults are **3001 (core) and 3002 (admin console)** — both are storefront ports in
  this repo (BUILD-PLAN §8.1). Remap on the host side only: 3011 / 3012. `ENDPOINT` and
  `ADMIN_ENDPOINT` must be the HOST-visible URLs; they end up in the discovery document and in
  every redirect the browser follows.
- `svhd/logto:1.43.0` and `svhd/logto:latest` are the same digest today
  (`sha256:41196a1f…`). The image is ~1.3 GB compressed and takes a few minutes on a cold pull.
- Seed to serving is about **20 seconds** on a warm image.

## Small things

- `@mercatus/contracts` grew three session schemas. The browser-bundle trap (lessons 07b/07c) is
  still open: `packages/contracts/src/common.ts` still imports two constants from `@mercatus/core`.
- `apps/store` needed `jose` as a direct dependency for the login-state JWT; it was already in the
  catalog, so it was one line and a 373 ms install with no `allowBuilds` gate.
- A store on `AUTH_ADAPTER=oidc` does **not** register `/dev/login/*`, and the dashboard, the
  admin console and the storefront all sign in through those routes. That is why AppHost A still
  defaults to `stub`.
