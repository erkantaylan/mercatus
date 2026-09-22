# 04b — apps/fake-bank

## Fastify hands a body-less POST to the validator as `null`, not `undefined`

- `curl -X POST /pay/:id/complete` with no `-d` → **400**, `Invalid input: expected object,
  received null`, even though the body schema was `z.object({…}).strict().optional()`.
- `.optional()` accepts `undefined` only. Use **`.nullish()`** for any body a caller is allowed to
  omit entirely. Cost: one red test and ten minutes.
- The `content-type` header is irrelevant here — Fastify skips parsing, then still validates.

## Dropping a connection on purpose

- `reply.hijack(); req.socket.destroy();` is the whole of it. `wrap-thenable.js` starts with
  `if (reply[kReplyHijacked] === true) return`, so an async handler returning `undefined` after
  `hijack()` produces no warning and sends nothing. Verified by reading
  `node_modules/.pnpm/fastify@5.12.5/node_modules/fastify/lib/wrap-thenable.js`.
- With the Zod type provider the handler's return type is still pinned by the 200 schema, so that
  branch needs `return undefined as unknown as T`. There is no cleaner spelling short of dropping
  the response schema and losing it from the OpenAPI document.
- curl reports `exit 52` / `HTTP 000` (`Empty reply from server`); `fetch` rejects with
  `TypeError: fetch failed`.
- **`inject()` cannot test this.** light-my-request's socket is in-memory and has nothing to
  destroy, so the injected promise never settles and the test hangs. Boot on
  `listen({ port: 0, host: '127.0.0.1' })` and use real `fetch` instead — it is barely more code
  and it is the only way to exercise a transport failure.

## Shell traps while driving the gate

- `bash gate.sh | tee out.txt | head -150` **kills the script**: `head` closes the pipe, `tee`
  takes SIGPIPE, the script dies mid-loop and the output looks like a failure at that step. It
  looked exactly like the 4th of 5 behaviours crashing. Redirect to a file, then `sed -n` it.
- `curl -o file -w '%{http_code}'` leaves the **previous** body in `file` when the connection is
  dropped (nothing is written). Truncate the file between iterations or you will read a stale
  200 body under an `HTTP 000`.
- HMAC from a shell: `printf '%s' "$canonical" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1`.
  `-r` gives `<hex> *stdin`; without it the output is `(stdin)= <hex>`. Use `printf`, never `echo`
  — a trailing newline changes the digest.

## Running one-off TypeScript

- `node --import tsx /path/outside/the/repo/probe.ts` importing repo files by **absolute path with
  `.js` extensions** dies with an esbuild `TransformError`. Put a scratch probe inside the package
  and use relative imports, or skip it and curl the running server, which is the gate anyway.
- `pnpm --filter <pkg> start` swallows a boot failure behind `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
  and prints none of the error. To see why a process refuses to boot, run the binary directly:
  `cd apps/<app> && ../../node_modules/.bin/tsx src/index.ts`.

## Verified, so do not re-derive

- `createServer()` from `@mercatus/core` with **no `auth` option at all** works. `AuthContextOptions`
  is already documented for this case; nothing in core needed changing for a service with no
  tenants and no tokens.
- `request.protocol` + `request.host` (host **with** port, unlike `request.hostname`) build a
  correct absolute self-URL behind `trustProxy: true`. No base-URL env var needed.
- Route options accept `produces: ['text/html']` alongside `params`, and **omitting the `response`
  key entirely** is what lets a handler return a string — a Zod response schema would JSON-encode
  it.
- Scalar behaves exactly as lesson 03 recorded, in a second app: `/docs` 301, `/docs/` 200,
  `/docs/openapi.json` 200.
- `z.url()` in a **response** schema rejects a plain `http://127.0.0.1:4004/pay/<uuid>`? No — it
  accepts it. Worth knowing before you weaken the schema for localhost.
- A test file that needs neither a database nor an env var cannot skip silently, which is the
  trap lesson 03 had to close in `turbo.json`. `@mercatus/fake-bank` adds no entry to the `env`
  lists there.

## Concurrency

- Two agents in one worktree: `git add -A` will sweep the other one's half-written package into
  your commit. Add your own paths explicitly. `pnpm install` is safe to run (it only adds
  importers), but `pnpm check` at the repo root grades their work as well as yours.
