# 04b — apps/fake-bank

Built `apps/fake-bank` (BUILD-PLAN §6.3), the failure-injecting payment stand-in. Run concurrently
with another agent working in `apps/platform`, so **nothing outside `apps/fake-bank/` was
touched** — see "What the next agent needs to know" below, which matters for task 07.

## What exists

```
apps/fake-bank/
  package.json                  @mercatus/fake-bank, port 4004
  tsconfig.json
  src/index.ts                  boot; refuses to start without MERCATUS_ALLOW_FAKE_BANK=1
  src/app.ts                    composition root; createServer() with NO auth block
  src/config.ts                 loadFakeBankConfig() — its slice of §8.2
  src/contracts.ts              its own Zod schemas; imports the callback body from @mercatus/contracts
  src/signing.ts                both HMAC canonical forms, sign(), signatureMatches()
  src/store.ts                  the whole database: a Map
  src/settle.ts                 the five behaviours, one table
  src/page.ts                   the hosted HTML page, one string
  src/routes/health.ts          GET /health
  src/routes/payments.ts        POST /payments, GET /payments/:id
  src/routes/pay.ts             GET /pay/:id, POST /pay/:id/complete
  test/fake-bank.test.ts        17 tests, no database, no environment
```

All five endpoints from §6.3 exist and answer. In-memory store, no database, as specified.

## The five behaviours

| behaviour | bank's books | callback | our connection |
|---|---|---|---|
| `approve` (default) | `paid` | signed, `paid` | answered 200 |
| `decline` | `declined` | signed, `declined` | answered 200 |
| `bad-hash` | `paid` | sent with a signature made from the **wrong secret** | answered 200 |
| `no-callback` | `paid` | none — the money moved and we were never told | answered 200 |
| `drop` | `dropped` | none | socket destroyed, `curl: (52)` |

Chosen three ways, in this order: the body of `POST /pay/:id/complete` (the page's buttons), then
`?behaviour=` on that call, then whatever `POST /payments?behaviour=` opened the payment with,
then `approve`. So the page, a curl script and the platform's own integration test all drive one
code path.

## Signatures (CR1)

Both directions are HMAC-SHA256, lowercase hex, over the field **values** joined by `|`:

```
request   reference | amountMinor | currency | callbackUrl     platform  -> fake-bank
callback  providerRef | status | amountMinor | currency        fake-bank -> platform
```

`POST /payments` verifies the first one **before it creates anything** and answers 401 with the
canonical string it hashed in `details.canonical`. That string is the whole diagnostic — it is
what tells you the caller assembled the fields differently — and it contains no secret.

The callback body is `paymentCallbackBodySchema` **imported from `@mercatus/contracts`**, and
`settle.ts` parses the body against it before sending, so the two sides of the one contract that
crosses the app boundary cannot drift silently.

## Gate — executed, not claimed

Started the server on 4004 with a plain node HTTP callback receiver on 4444 that verifies the
HMAC the way the platform will, then drove every outcome with curl. Full transcript in
`lessons/04b-fake-bank.md` is not the place for it, so the load-bearing lines:

```
=== 0b. OUR signature is verified before anything is answered (CR1) ===
HTTP 401
{ "error": { "code": "UNAUTHENTICATED",
             "message": "The request signature does not match.",
             "details": { "canonical": "broken-hashing|49900|TRY|http://127.0.0.1:4444/payments/callback",
                          "algorithm": "HMAC-SHA256(secret, canonical) as lowercase hex" } } }

=== approve ===   HTTP 200  status=paid      callback {attempted:true, delivered:true,  httpStatus:204, signatureCorrupted:false}
=== decline ===   HTTP 200  status=declined  callback {attempted:true, delivered:true,  httpStatus:204, signatureCorrupted:false}
=== bad-hash ===  HTTP 200  status=paid      callback {attempted:true, delivered:false, httpStatus:401, signatureCorrupted:true}
=== no-callback = HTTP 200  status=paid      callback {attempted:false, delivered:false, httpStatus:null}
=== drop ===      HTTP 000  curl exit 52 -- no reply
                            status=dropped   callback {attempted:false}

receiver log — exactly the callbacks that should have arrived, and no others:
  signatureValid=true  status=paid       fb_36f396f0-…   (approve)
  signatureValid=true  status=declined   fb_71b6d88f-…   (decline)
  signatureValid=false status=paid       fb_3c678e78-…   (bad-hash)
  (nothing for no-callback, nothing for drop)

=== hosted page ===   HTTP 200  content-type=text/html; charset=utf-8  bytes=4839
  data-behaviour="approve" "bad-hash" "decline" "drop" "no-callback"
=== docs ===          /docs 301   /docs/ 200
  paths: /health /pay/{id} /pay/{id}/complete /payments /payments/{id}
=== run-mode gate === boot without MERCATUS_ALLOW_FAKE_BANK=1:
  ConfigInvalidError: Environment is not valid -- MERCATUS_ALLOW_FAKE_BANK: fake-bank is
  run-mode only and refuses to start without MERCATUS_ALLOW_FAKE_BANK=1 (CR1).
```

And the mechanised form:

```
pnpm turbo run typecheck lint test --filter=@mercatus/fake-bank
  Tasks: 5 successful, 5 total    Tests: 17 passed (17)
```

The suite needs no database and no environment variables, so it cannot skip silently.

## What the next agent needs to know

- **`apps/platform` must sign with `src/signing.ts`'s two canonical forms.** They are copied into
  `docs/decisions-made-overnight.md` verbatim. The platform will need its own copy of ~15 lines of
  HMAC code; do **not** import it from `@mercatus/fake-bank`, which never ships.
- **`providerRef` is `fb_<uuid>`** and is what the platform stores as `payments.provider_ref` and
  keys idempotency on (CK2). The `:id` in fake-bank's URLs is the bare uuid.
- **`paymentUrl` is built from the request** (`${req.protocol}://${req.host}/pay/${id}`), not from
  a configured base URL, so fake-bank does not read `FAKE_BANK_URL`. The platform still does.
- **`POST /payments?behaviour=decline`** is how an automated buy-a-store test drives a failure
  without opening the page.
- **`GET /payments/:id` is the assertion surface.** It reports `callback: { attempted, delivered,
  httpStatus, error, reportedStatus, signature, signatureCorrupted, at }`. `delivered` is 2xx
  only, so a `bad-hash` callback is `attempted: true, delivered: false, httpStatus: 401` — arrived
  and refused, which is a different fact from never sent.
- **Nothing outside `apps/fake-bank/` was changed**, in particular not `packages/core`,
  `packages/contracts` or `turbo.json`. `loadPlatformConfig()` in `packages/core/src/config.ts`
  is therefore still unwritten — it belongs to whoever builds `apps/platform`. fake-bank has its
  own `loadFakeBankConfig()` in-app on purpose: it is run-mode only and a loader for a service
  that must never ship does not belong in the package every app imports.
- **The commit is scoped to my own paths**, not `git add -A`: `apps/platform/` and
  `packages/db-platform/` were dirty with another agent's in-flight work at the time. The
  `pnpm-lock.yaml` change is included because `apps/fake-bank` needs its importer entry; it also
  carries an entry for `apps/platform`, which is harmless and will be re-written by their install.
- **The repo-wide `pnpm check` was not run** for the same reason — it would have graded someone
  else's half-finished package. The scoped turbo run above is the gate.
