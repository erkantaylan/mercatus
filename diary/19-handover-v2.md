# 19 — the v2.0.0 handover

No feature code. The job was to write the release up for the person who approved it, and then to
make the docs a newcomer reads agree with what the machine actually does.

## What I wrote

**`docs/V2.md`** — the handover, in seven sections: what changed (five commits, phase by phase),
what a dedicated tenant costs now against the copied-AppHost-and-~14-edits it cost at v1.0.0, the
exact commands for two pooled and two dedicated tenants, what does not work, the decisions worth
arguing with, the definition of done item by item, and what I would fix first.

The cost comparison is enumerated rather than asserted: `git show v1.0.0:aspire/AppHostB/apphost.cs`
carries **17** slug-bearing literals, plus three CLI ports in `apphost.run.json`, plus edits in
`aspire/AppHostA/apphost.cs`, `packages/identity/src/bootstrap.ts`,
`packages/db-platform/src/seed-dedicated.ts` and the e2e helpers' fixed manifest keys. The plan's
"~14 edits across 4 files plus a copied AppHost" was, if anything, generous to the old shape.

The nine acceptance findings got **stable labels, `FJ`–`FR`**, continuing the repo's two-letter
registry (`FE` and `FI` were the highest in use). They had only severity numbers before, which are
not pointable-at across documents.

## What I changed, and why it was wrong before

- **`README.md`.** The first run command said "the edge on 8080" (it is 28080, including 34 lines
  below). It told a reader to start B with `cd aspire/AppHostB && aspire run`, which serves exactly
  one dedicated box, while the whole rest of the file — and the e2e suite — assumes two. It claimed
  "the two dashboards are on 15230 (A) and 15240 (B)" when the documented way to start B always
  passes `--isolated`, which randomises exactly that port. The checks block listed `pnpm test:e2e
  # 22 tests` and `MERCATUS_E2E_REQUIRE_OIDC=1 pnpm test:e2e` one under the other, reading as the
  same 22 tests with the adapter swapped; it is 22/6 on one stack and 6/22 on the other. The
  resource-name table named zenith's resources as if they were the names, when phase 2 made every
  one of them a template. And the paragraph about rebuilding the control plane described only a
  401, when what actually happens is that sign-in dies at every running box and the documented
  recovery empties that merchant's database.
- **`docs/OPEN-DEFECTS.md`.** `EV` said the cost was "B's instance token answers 401 for ever.
  Restarting B fixes it in one poll." Both halves were understated; the row now says what the
  acceptance run measured, including 4 orders → 0.
- **`docs/PLAN-opt-in-registration.md`.** A status block per phase, each naming its commit, the
  gate that executed and the thing the plan did not foresee; and a status under the definition of
  done saying it was met as a running system and not as a self-proving one.
- **`REQUIREMENTS.md`.** Same dashboard-port claim as the README, qualified only for "a SECOND
  AppHost B", which is also wrong since the first one is isolated too.
- **`docs/MORNING.md`.** §1's OIDC block was `MERCATUS_AUTH_ADAPTER=oidc ( cd … )`, which is a
  **bash syntax error** — the documented way to run the demo on a real issuer did not parse. Now
  an `export`. Its teardown also now removes `.stack/apphost-*.json` and names the leaked CLI
  process.

## The state I am leaving

- `docs/V2.md` exists; `git status` is clean; `git log --oneline` shows phase 0, phase 1, phase 2,
  phase 3 and the repair round as separate commits.
- Nothing was started. `docker ps` showed only an unrelated container when I began and when I
  finished; nothing was listening on 28080/28311/28312/15230/15240; no `aspire-managed nuget`
  process was alive.
- I did not re-run the stack, and `docs/V2.md` says so in as many words, with a list of what I did
  check myself (static greps, the tree at the tag, the stale `.stack` files) against what is the
  reviewer's measurement.
- The nine findings are all still open. Nothing was fixed in code by this task, deliberately.
