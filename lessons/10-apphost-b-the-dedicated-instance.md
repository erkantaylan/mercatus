# 10 — two AppHosts, and the things that only bite the second one

## Aspire 13.5.3/13.5.4

- **`AddExternalService(name, url)` exists and takes `.WithHttpHealthCheck("/health")`.** It
  compiled and ran against 13.5.4 with nothing but `Aspire.Hosting`. Do **not** `WaitFor` one: the
  whole point of AppHost B is that it boots while the other plane is dead.
- **`dotnet build apphost.cs` typechecks a single-file AppHost in about a second** without
  starting anything. The restore line names an `apphost.csproj` beside the file, but none appears
  on disk (`ls`, `git status` both clean) — the build lands in `~/.local/share/dotnet/runfile/`.
  Use it before every `aspire run`: a compile error found by `aspire run --detach` costs a full
  start cycle.
- **`aspire run` picks the AppHost from `aspire.config.json` in the current directory**
  (`{"appHost":{"path":"apphost.cs"}}`). Two directories, two config files, no ambiguity. From
  anywhere else, `aspire run --apphost <dir>`. There is no repo-level file that lists both.
- **A second AppHost MUST have its own dashboard/OTLP/resource ports in `apphost.run.json`**
  (15240 / 19081 / 20015 here). They are not auto-assigned; the second AppHost would otherwise
  race the first for 15230/19071/20005. `aspire run --isolated` claims to randomise them; not
  tried here, because the ports are written down in BUILD-PLAN §8.1 and a fixed dashboard URL is
  worth more than the saved edit.
- `builder.ExecutionContext.IsRunMode` works as a plain ternary inside `WithEnvironment`, which is
  how a dev-only seed flag stays out of a published topology.
- An `AddExecutable` started as `pnpm --filter <pkg> <script>` runs with **cwd = the package
  directory** (lesson 08, still true). A relative path in its environment therefore has to be
  written from there — `../../.instance/zenith.json` reaches the repo root from both
  `packages/*` and `apps/store`, which is why one variable can serve the install command and the
  server.

## Running the same UI twice on different ports

- Next.js: `node node_modules/next/dist/bin/next dev`, and it honours `PORT` — which is exactly
  what `WithHttpEndpoint(port: p, targetPort: p, env: "PORT", isProxied: false)` sets. No `-p`
  needed, so the package's hard-coded `next dev -p 3001` script does not have to be duplicated.
- Vite: `node node_modules/vite/bin/vite.js`, and `apps/dashboard/vite.config.ts` already reads
  `process.env.PORT`. Both binaries live under **the app's own** `node_modules`, never the repo
  root (pnpm, no hoisting).
- A health check on a Next.js app must name a path that answers **200**. `/` redirects
  (`TENANT_SLUG` set → `/t/<slug>`) and a 307 leaves the resource permanently unhealthy, so every
  `WaitFor` on it hangs. `/t/zenith` is the honest probe: it is 200 only once the store is up,
  provisioned and holding products.

## The control plane's database is the thing that breaks a re-run

- **`aspire stop` on AppHost A destroys its Postgres**, so the rebuilt control plane has never
  heard of the installation the dedicated box registered. The instance token then answers **401**
  and the store stays `read_only` for ever — correct, but not the recovery demo you wanted.
  For "it catches up when we return", kill the **platform process** (`kill -TERM <pid>`; DCP does
  not restart it) and leave the AppHost up.
- To recover after a full rebuild: `rm .instance/<slug>.json`, re-run the install command (the
  re-seeded bootstrap token is unspent again), then **restart the store process** — the credential
  file is read once, at boot.
- `tr '\0' '\n' < /proc/<pid>/environ` gives an Aspire-managed process's whole environment,
  including the random Postgres host port, which makes relaunching it by hand a two-line script
  instead of an archaeology exercise.

## Provisioning

- `POST /installations/register` answers `{installationId, instanceToken, tenantId, tenantSlug}`
  and **no tenant name**, so a mirror needs a `TENANT_NAME` of its own or it writes the slug.
- The seeded dev bootstrap token (`packages/db-platform/src/seed-dedicated.ts`) is re-seeded
  unspent on every fresh platform database and left alone once burned. Nothing has to be reset by
  hand between runs unless the credential file and the database disagree.
- Write the credential with `writeFileSync(..., { mode: 0o600 })`. `mkdirSync(dirname, {recursive:true})`
  first, or the first ever provision fails on a directory nobody created.

## Measuring the demo

- The same one-line-a-second loop as task 09, with columns that must DISAGREE: storefront code,
  store API code, `status/state` from `/api/licence`, and the shopper-facing `licence.checkout`
  from `/t/:slug/branding`. 115 samples fit in one screen if you filter the healthy rows out.
- **Do not put a checkout inside the per-second loop** (lesson 09's trap). It exhausts the seeded
  catalogue and starts answering 409, which reads exactly like a licence refusal. This run sampled
  read-only probes every second and checked out at three chosen moments instead, which is also a
  more readable transcript.
- Grace measured from the last SUCCESSFUL poll, not from the kill: 60 s of `LICENCE_GRACE_SECONDS`
  showed up as ~45 s of observable grace after `aspire stop`, because the last success was ~15 s
  before it.
- A shopper "already signed in" is just the cookie jar: `curl -c jar` on the first checkout,
  `curl -b jar` afterwards. The stub `/dev/login/shopper` is local to the store, so minting still
  works during an outage — which is the point of the store issuing its own session (Q20).

## Small things

- `curl` sees only the SSR output of a Next.js page. `data-payment="paid"` is written by a client
  component after hydration, so assert on `GET /api/payments/:orderId` instead of grepping HTML.
- The dedicated storefront and the pooled one are the same package, so two `next dev` servers
  would share one `apps/storefront/.next`. Only B's ran in this task (A still has no storefront
  resource), so that is **untested** — it is the first thing to suspect when both run at once.
