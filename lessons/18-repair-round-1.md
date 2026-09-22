# 18 — repair round 1: one sign-in path for both adapters

## Read first

- Lessons 14–17 still hold. The thing they each end with — "the browser UIs have no OIDC path" —
  is what this round closed. Do not re-derive it.
- `git diff v1.0.0 --stat` is still how you check you did not break what worked.

## The stub's own authorization page never existed, and that is why both front ends bypassed it

- `StubAuthAdapter.authorizeUrl()` has pointed `/auth/login` at `${devLoginUrl}` since task 03 and
  **nothing ever served that address** — `registerDevLoginRoutes` registered only the two POSTs.
  So the store's own `/auth/*` round trip 404'd under the stub, and the storefront and the
  dashboard each called `/dev/login/*` directly, which is precisely why `AUTH_ADAPTER=oidc` broke
  sign-in.
- Serving it is ~80 lines of plain HTML and makes the two adapters interchangeable from a front
  end's point of view. Do it before anything clever.
- Make it a **server-rendered form with no script**. There is nothing to hydrate, so the browser
  driver cannot click it before it works — the opposite of every React form in this repo.

## `stub:<kind>:<subject>[:<tenant>]` was split on `:` and both subjects contain one

```
stub:staff:dev-staff:acme:acme   -> split(':') -> subject = "dev-staff"
```

- Nobody noticed for five tasks because nothing had ever driven the stub's own code path end to
  end; `/dev/login/staff` builds the principal directly and never makes a code.
- Fix: `encodeURIComponent` the subject when minting, `decodeURIComponent` when parsing. It is a
  no-op for a subject that needs no escaping, so hand-written codes keep meaning what they say.

## A front end on another origin cannot be sent the store's cookie

- The session cookie is `HttpOnly`, `Path=/`, **host-only**. A storefront on its own host and a
  dashboard SPA on a third will never receive it.
- Two answers were rejected: `Domain=localtest.me` (every instance on the domain then sees every
  other's session) and an OIDC client per front end (a browser bundle cannot hold a secret; a
  second secret on a customer-owned box breaks `CE1`).
- What works: `POST /auth/exchange` returns the SAME session as a token, and the auth hook retries
  a bearer the adapter rejected against `SessionIssuer.verify`. One credential, two transports,
  no new trust boundary.

## Cookies ignore the port, and registered redirect URIs make the e2e workaround illegal

- Lesson 17 fixed the shared-jar collision by rewriting `localhost` to `<slug>.localtest.me`
  **inside the e2e helper**. Once the browser-facing addresses are REGISTERED redirect URIs, that
  rewrite sends the shopper to an address the issuer was never told about.
- Fix it in the AppHost: publish `<slug>.localtest.me:<aspire port>` and let `expectedHost`
  follow. In Aspire, a `ReferenceExpression` hole only accepts an `IValueProvider`, so a literal
  hostname has to arrive as a `ParameterResource`:

  ```csharp
  var publicHost = builder.AddParameter("public-host", $"{TenantSlug}.localtest.me");
  ReferenceExpression PublicUrl(EndpointReference ep) =>
      ReferenceExpression.Create($"http://{publicHost.Resource}:{ep.Property(EndpointProperty.Port)}");
  ```
- `getent hosts <x>.localtest.me` returns **`::1` only**, and Node 22's `fetch` and Chrome both
  fall back to 127.0.0.1 (measured). A server bound to `127.0.0.1` still answers; `0.0.0.0` is
  safer for anything the browser reaches.

## Logto 1.43's sign-in page, as Playwright sees it

- It is a React SPA: `curl` returns `<div id="app">` and no form at all. Selectors must come from
  a rendered dump, not from the HTML.
- The username input carries **no `for`/`id` pairing** — the visible "Username" is a sibling
  `<label>` and a `<legend>` — so `getByLabel` finds nothing. Address it by name:
  `input[name="identifier"]`, `input[name="password"]`, then `getByRole('button', {name: /^Sign in$/})`.
- **The issuer remembers the last person.** Signing four merchants in one after another signs
  numbers two to four in silently as merchant one. End the session between them:
  `GET {logto}/oidc/session/end` (no `id_token_hint`), which lands on `/oidc/session/end/success`.
  Do NOT do that between a shopper's stores — that silence is the SSO being demonstrated.
- Consent is per (user, application) and remembered, so the button appears on the first round trip
  for a pair and never again. Treat its absence as normal.

## The React-controlled-input trap, one more time

- The checkout form's phone field is `value={phone}` + `onChange`. A `fill()` before hydration
  lands in the DOM and is wiped by the first render, and the only symptom is the browser's own
  **"Please fill out this field"** on a field the driver believes it typed into.
- Put the fill INSIDE `expect(...).toPass()` and assert `toHaveValue` before clicking. Same rule
  as lessons/07a and /11, in a new place.

## Small things

- `pkill -f "playwright test"` kills the bash invocation that contains the pattern — exit 144, no
  output. Lesson 03's trap with a different pattern. Kill by pid from `pgrep -af`.
- A skip is not a pass. `test.skip(!bothUp, …)` on every test in a file makes the file green on a
  stack that proves none of it. Make the run DECLARE what it claims (`MERCATUS_E2E_DEDICATED`) and
  fail in global setup when a claim is not met.
- The e2e helpers' own `staffToken()` posted to `/dev/login/staff`, so the SUITE could only ever
  describe the stub. Read the token the merchant's browser was handed out of `localStorage`
  instead — adapter-agnostic, and a stronger claim.
- `apps/platform/src/identity.ts` runs in the PLATFORM process under AppHost A (lesson 16). Still
  true, still costs a restart cycle if you forget.
