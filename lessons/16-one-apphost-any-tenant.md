# 16 — one AppHost B, any tenant (phase 2)

## Read first

- Lessons 14 and 15 still hold. `localhost`, never `127.0.0.1`, is still load-bearing.
- `aspire run --isolated` exists: "randomized ports and isolated user secrets, allowing multiple
  instances to run simultaneously". That is the answer to the three CLI ports in
  `apphost.run.json` (`15240`, `19081`, `20015`). Do not hand-roll a port hash. Verified once, on
  AppHost B with nothing else running: the detached JSON came back with
  `"dashboardUrl": "http://localhost:41171/..."` instead of `15240`, and `aspire stop` from the
  same directory reaped it normally. TWO Bs at once is still phase 3's to prove.

## The traps

- **The platform process is what holds `@mercatus/identity`, and it runs under AppHost A.** Edit
  `packages/identity/src/*` and restart AppHost **B**, and you will watch your fix not happen. I
  lost a restart cycle to this: the per-installation client kept accumulating redirect URIs across
  three B restarts because A was still running the code from before the edit. Restart A.
- **`ensureInstallationClient` unioned its redirect URIs**, which leaks one dead URI per restart
  on the instance's OWN application. The union is only correct for the SHARED dashboard/storefront
  clients, where another installation may be relying on an entry. An application with exactly one
  owner should be written authoritatively.
- **`new URL()` accepts more than you want and silently fixes some of it.** Measured with Node 22:
  - `http://h\@evil.test/` → hostname `h`, pathname `/@evil.test/` (backslash becomes a slash)
  - `http://evil.test@h` → hostname `h`, `username` `evil.test` (survives into `href`)
  - `HTTP://H:1234` → `origin` is `http://h:1234`, already lower-cased
  `origin + pathname` normalises all three; `username`/`password`/`search`/`hash` are the fields
  worth refusing outright.
- **The Logto Management API is two hosts.** Token from `{adminEndpoint}/oidc/token` (`:28312`),
  API calls to `{endpoint}/api/...` (`:28311`). Swap them and you get
  `auth.unauthorized … "claim":"aud","reason":"check_failed"` — which reads like a scope problem
  and is a wrong-host problem. `packages/identity/scripts/list-applications.sh` now does it
  correctly; read that rather than rebuilding it.
- **Probing `/oidc/auth` is the cheap test for a redirect URI**, no browser and no adapter switch:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -G http://127.0.0.1:28311/oidc/auth \
    --data-urlencode "client_id=$(jq -r .oidc.clientId .instance/zenith.json)" \
    --data-urlencode "redirect_uri=$STORE/auth/callback" \
    --data-urlencode response_type=code --data-urlencode 'scope=openid profile' \
    --data-urlencode state=x
  ```
  `303` = registered, `400` = `oidc.invalid_redirect_uri`. Works under `AUTH_ADAPTER=stub`.

## Aspire and the slug

- A C# top-level-statement AppHost can use `var` for what were `const string` literals with no
  other change; `#:package`-style script AppHosts take `System.Text.RegularExpressions.Regex`
  inline without a `using`.
- `Environment.GetEnvironmentVariable(name) is { Length: > 0 } value` is the pattern that treats
  an empty variable as unset. `MERCATUS_TENANT_SLUG=` would otherwise name a tenant `""`.
- Validate the slug before it becomes `AddPostgres($"pg-tenant-{slug}")` and
  `"../../.instance/{slug}.json"`. `^[a-z][a-z0-9-]{1,38}$`.

## Timings on a warm machine

- AppHost A: `platform.localtest.me:28080/health` green and `.identity/management.json` present in
  **~5 s**; Logto's discovery document 200 by ~17 s. Wait for BOTH before starting B.
- AppHost B: store `/health` at **~11 s**.
- `aspire stop` from each AppHost's own directory; containers were gone within 6 s every cycle.
- `rm .instance/<slug>.json` before re-running B against a REBUILT A is no longer required — the
  credential is rejected, the box re-registers by itself — but it is still the fastest way to be
  sure which path you are testing.

## Not fixed, deliberately

- `packages/identity/src/bootstrap.ts:99` still defaults `IDENTITY_TENANT_SLUGS` to
  `'acme,borg,zenith'` and AppHost A never overrides it, so a NEW dedicated slug registers with
  `organizationId: null`. Phase 3's first blocker. `IdentityProvisioner.provision()` only LOOKS UP
  an organization; it never creates one.
