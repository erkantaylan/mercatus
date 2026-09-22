# 13 — morning handover

Task: write `docs/MORNING.md` for the person who went to sleep, and make the README's running
section match reality. No feature code. Nothing in `apps/`, `packages/` or `aspire/` was touched.

## What I did

Re-ran everything rather than trusting the overnight reports, then wrote up what I saw.

- `pnpm -r test` → **244 passed, 0 skipped**, exit 0, `Scope: 13 of 14 workspace projects`.
- `pnpm turbo run typecheck lint` → 26/26.
- AppHost A from `aspire run --detach` to all six edge hostnames at 200: ~15 s. All seven direct
  ports 200, Logto `/api/status` 204.
- AppHost B: ~15 s, and it **re-registered by itself** from the `.instance/zenith.json` left by
  last night's run, whose control-plane database no longer existed. `/installations` `total: 1`,
  licence `active/healthy`, heartbeat arriving.
- Reproduced the acceptance run's worst finding end to end (below).
- Drove a checkout through the edge with curl: `POST shop.localtest.me:8080/api/checkout` answered
  `"paymentUrl": "http://127.0.0.1:4004/pay/…"` — the payment leaves the edge.
- `pnpm test:e2e` against both AppHosts: **16 passed in 40.6 s**.
- Stopped both, confirmed `docker ps` shows only `chess-trainer`, no ports of ours held, and the
  suite's relaunched control plane (pid 719878) gone with the AppHost.

## The finding, reproduced

`aspire stop` on A at 11:52:28. B's last successful poll 11:52:25; `read_only` by 11:53:30 (60 s
grace). A rebuilt → `GET /installations` `{"items":[],"total":0}`. B still running: `lastCheckedAt`
advanced to 11:54:25, `lastSuccessAt` frozen at 11:52:25, `state: read_only`,
`checkout: blocked_unreachable`. B restarted → re-registered, `total: 1`, `healthy`,
`checkout: open` at 11:55:09, one poll after boot.

## What changed

- **`docs/MORNING.md`** — new. Six sections: run it (exact commands, the demo step by step, the
  three checks), what works with this morning's evidence, what does not (labelled `EV`–`FA`),
  decisions to review pulled out of `decisions-made-overnight.md`, lessons condensed, and what to
  do next (`FB`–`FH`).
- **`README.md`**, four edits:
  - "Everything of A's answers on one port" → "Every page of A's is served on one port", followed
    by the two documented leaks off the edge (fake-bank's payment URL, the SPAs' XHR bases) and
    where the fix is.
  - "The demo" now ends honestly: recovery needs B restarted as well as A, with the commands and
    the reason, plus the `kill -TERM` alternative that keeps A's database.
  - A "The checks" block: `pnpm -r test` (244), `turbo run typecheck lint` (26),
    `pnpm test:e2e` (16), and the fact that the recursive run covers 13 of 14 projects and opens
    no browser.
  - The Layout block named `packages/clients` and `aspire/AppHost`, neither of which exists. It
    now names what is on disk (`ui`, `identity`, `e2e`, `AppHostA`, `AppHostB`) and the two SPAs
    by what they are. A new note **FI** says the Stack table's three wrong rows are wrong on
    purpose and points at the decisions file; the table itself is left alone.
  - The Docs table gained `MORNING.md`, `OPEN-DEFECTS.md` and `decisions-made-overnight.md`.
- **`docs/decisions-made-overnight.md`** — a task 13 section, four bullets.
- **`lessons/13-morning-handover.md`** — the measurements and the two corrections.

## State left behind

- Both AppHosts stopped, all containers gone, all ports free. `docker ps`: `chess-trainer` only,
  which is not ours.
- `.instance/zenith.json` names an installation in a database that no longer exists. Harmless and
  deliberate: it is what proves the re-registration fix on the next run.
- Working tree clean after the commit. Still 3 commits ahead of `origin/develop` — now 4 — and
  unpushed, per the standing "NEVER push" instruction. There *is* a real remote.
- No code changed, so the gates above are still the gates.

## For whoever is next

Read `docs/MORNING.md` §6 first. `FB` (a running B re-registering by itself) and `FC` (the whole
demo behind the edge, then CORS narrowed to it) are the two that change what the POC demonstrates
rather than how it reads.
