# 13 — verifying the whole stack from cold, in ten minutes

## Two numbers in task 12's write-up are wrong

- `pnpm -r test` reports **244 passed, 0 skipped**, not 235. Task 12's diary and lessons both say
  235 while listing a per-package breakdown (26 + 25 + 11 + 17 + 22 + 98 + 45) that adds to 244.
  The breakdown is right; the total was not re-added. Measured again this morning, unchanged.
- `pnpm -r test` prints `Scope: 13 of 14 workspace projects`. `packages/e2e` has no `test` script.

## Cold-start timings, this machine, second run of the day

- `aspire run --detach` on A → all six edge hostnames 200: **~15 s** (a 5-second poll loop sees
  1/6 on the first pass and 6/6 on the second).
- AppHost B → `4003/health`, `3002/t/zenith` and `5175/` all 200: **~15 s**, provisioning included.
- `pnpm test:e2e`: **40.6 s**, 16 tests, one worker.
- `pnpm -r test`: ~35 s, five Testcontainers Postgres instances started and stopped.

## Readiness, without a browser

```bash
for u in http://platform.localtest.me:8080/health http://api.localtest.me:8080/health \
         http://bank.localtest.me:8080/health http://shop.localtest.me:8080/t/acme \
         http://dash.localtest.me:8080/ http://console.localtest.me:8080/ \
         http://127.0.0.1:4003/health http://127.0.0.1:3002/t/zenith; do
  printf '%s -> %s\n' "$u" "$(curl -s -o /dev/null -m 4 -w '%{http_code}' "$u")"
done
```

- Logto answers **204** on `/api/status` and has no `/health` (lesson 08, still true) — leave it
  out of a loop that tests for 200.
- `dash.` and `console.` return 200 at `/` through the edge; `shop.` needs a tenant path.

## Driving a whole purchase with curl, through the edge

```bash
PID=$(curl -s http://api.localtest.me:8080/t/acme/products | python3 -c 'import sys,json;print(json.load(sys.stdin)["items"][0]["id"])')
curl -s -X POST http://shop.localtest.me:8080/api/checkout -H 'content-type: application/json' \
  -d "{\"slug\":\"acme\",\"phone\":\"+905550001111\",\"name\":\"X\",\"lines\":[{\"productId\":\"$PID\",\"qty\":1}]}"
# -> {"orderId":…,"number":1,"totalMinor":249900,"currency":"TRY",
#     "paymentUrl":"http://127.0.0.1:4004/pay/…"}
```

- A posted `phone` signs a guest in and checks out in one request, so no cookie jar is needed for
  a smoke test. The `paymentUrl` in that answer is how you check whether the payment leg goes
  through the edge — this morning it does not.
- The two tokens worth knowing (both only while `AUTH_ADAPTER=stub`):
  `POST platform.localtest.me:8080/dev/login/operator {"subject":"x"}` → `.accessToken` for
  `GET /installations`; `POST <store>/dev/login/staff {"slug":"zenith","role":"owner"}` for
  `GET /api/licence`.

## Reproducing "A rebuilt, B still running" takes about three minutes

The sequence, with what to assert after each step:

1. `cd aspire/AppHostA && aspire stop` → B's `/api/licence` keeps `lastSuccessAt` and goes
   `state: read_only` one grace window later (60 s here, measured: 65 s).
2. `aspire run` A again → `GET /installations` is `{"items":[],"total":0}`. The database is new.
3. B, untouched: `lastCheckedAt` advances every poll, `lastSuccessAt` never moves,
   `/t/zenith/branding` says `checkout: blocked_unreachable`. It never recovers.
4. `aspire stop && aspire run` in `aspire/AppHostB` → re-registers at boot, `total: 1`,
   `healthy`, `checkout: open` on the next poll.

- **After `aspire stop` on A, one container legitimately remains**: B's `pg-zenith-*`. A cleanup
  check of the form `docker ps | grep -v chess-trainer | wc -l` therefore reads 1, not 0, until B
  is stopped too. Stop B first if you want the count to go to zero in one step.
- `aspire stop` returns before its containers are gone; poll `docker ps` (lesson 12, confirmed
  again — 6 containers still up at the moment the command returned).

## The e2e suite cleans up after itself now

`test-results/relaunched-platform.pid` held 719878 after the run; the process was **gone** the
moment AppHost A stopped, without anyone killing it. Task 12's supervisor works. Do not go hunting
for an orphan on 4001 before checking.

## Small

- `aspire run --detach --format Json` prints the dashboard URL **with its one-time login token**.
  Grab it from that output; there is no way to re-print it later short of restarting.
- Local clock is UTC+3, API timestamps are UTC. Two of this morning's measurements looked like
  time travel until that registered.
