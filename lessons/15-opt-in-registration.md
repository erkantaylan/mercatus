# 15 — opt-in registration (phase 1)

## Read first

- Lesson 14 is still the one that saves hours. Host spelling (`localhost`, never `127.0.0.1`) is
  still load-bearing; v2.0.0 just makes it automatic, because the store's `baseUrl` and its
  `redirect_uri` now come from the SAME Aspire `EndpointReference`.
- `git diff v1.0.0 --stat` is how you check you did not break the thing that worked.

## The things that were not obvious

- **`packages/identity/src/logto.ts` already had a usable Management API client, exported from
  the package index.** "Extract the Management API client" is a 20-minute job, not the awkward
  part of the plan. What is awkward is one sentence: the bootstrap gets the M2M secret by reading
  Logto's OWN Postgres, and the platform must not. The answer is a handoff file —
  `IDENTITY_MANAGEMENT_OUT` on `task-identity-bootstrap`, `LOGTO_MANAGEMENT_PATH` on the platform,
  0600, **opened lazily on the first registration and never at boot**. Do NOT
  `platform.WaitForCompletion(logtoBootstrap)`: Logto takes ~16–40 s to seed and the control plane
  must be listening in 2.

- **An application per INSTALLATION, not per tenant.** This was measured, not theorised: with the
  name keyed on the slug, registering a second zenith installation put BOTH redirect URIs on one
  application, and `DELETE /installations/:id` on the throwaway would have deleted the live store's
  client out from under a running box. `installationApplicationName(slug, installationId)`.

- **Check the host BEFORE burning the bootstrap token.** A mismatch is a typo far more often than
  an attack; burning it bricks the install for good, and the attacker gains nothing from the retry
  because they never get a credential. Check every reported URL, not just `baseUrl` — a
  `dashboardUrl` becomes a redirect URI too.

- **Pin the HOSTNAME, never the port.** The port is Aspire-assigned and unknowable when the token
  is minted; pinning it would re-create the coupling v2.0.0 exists to delete.

- **`provision.ts`, not the store, writes the identity cache.** The adapter reads that file ONCE,
  in its constructor. AppHost B already has `store.WaitForCompletion(provision)`, so writing it in
  the install command is enough and no re-read is needed. Merge, do not overwrite: the adapter
  writes its own learned org/role directory into the same file.

- **An executable can consume the endpoint of a resource that waits on it.** `provision` reads
  `store.GetEndpoint("http")` while `store.WaitForCompletion(provision)`. Non-proxied endpoints are
  allocated before anything starts. AppHost A had the same shape already
  (`logtoBootstrap` ← `storePooled`), which is the precedent worth trusting.

## Gate mechanics

- `POST /dev/login/operator` answers `{accessToken, expiresAt}` — **`accessToken`, not `token`**.
  Body is `{"subject":"..."}`.
- Polling `http://<h>.localtest.me:28080/` for "green" is worthless: Traefik answers 404 for an
  unrouted host and a 404 is not 000. Poll `platform.localtest.me:28080/health` for
  `{"status":"ok"}` and `.identity/management.json` for existence.
- `python3 -c` with an f-string containing escaped double quotes inside a bash double-quoted
  heredoc-less one-liner does not survive. Write the script to a file.
- A warm Logto image seeds in ~16 s, not the ~40 s lesson 14 implies.

## Still true, still not fixed

The storefront, the merchant dashboard and the admin console have **no OIDC code path** — they
sign in only through `/dev/login/*`, which does not exist under `AUTH_ADAPTER=oidc`. `stub` is
still the default for that reason, and the e2e suite still drives the stub. v2.0.0 registers those
surfaces' redirect URIs correctly; it does not give them a way in. That is its own task.
