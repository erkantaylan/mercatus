# Architecture — POC

A generic multi-tenant commerce platform: merchants buy a store, add products, and sell.
Some stores run on our shared infrastructure; some run on the merchant's own server. Everyone
signs in through one identity service, and everything reports telemetry to one place.

**The POC has no external service dependencies.** Payments go through `fake-bank`, a stand-in we
control that can be told to decline, return a bad hash, never call back, or drop the connection —
so the showcase runs offline, on one machine, with no accounts to register.

Rules referenced below (`CE2`, `BE1`, …) are in [`dos-and-donts.md`](./dos-and-donts.md).

---

## 1. System context

Who talks to what, and where the trust boundary falls.

```mermaid
flowchart LR
    shopper["Shopper"]
    merchant["Merchant staff"]
    operator["Platform operator"]

    subgraph cp["CONTROL PLANE — we run this"]
        idp["identity<br/>OIDC, organizations, phone OTP"]
        platform["platform<br/>tenants, licences, telemetry ingest"]
        padmin["admin<br/>platform console"]
        bank["fake-bank<br/>payment stand-in"]
    end

    subgraph pooled["POOLED DATA PLANE — we run this"]
        papi["store-api"]
        pweb["storefront + dashboard"]
    end

    subgraph ded["DEDICATED DATA PLANE — customer's VPS"]
        dapi["store-api"]
        dweb["storefront + dashboard"]
    end

    shopper --> pweb
    shopper --> dweb
    merchant --> pweb
    merchant --> dweb
    operator --> padmin

    pweb --> papi
    dweb --> dapi

    pweb -->|"sign in"| idp
    dweb -->|"sign in"| idp
    papi -->|"verify via JWKS"| idp
    dapi -->|"verify via cached JWKS"| idp

    papi --> platform
    dapi -->|"outbound only: licence, telemetry"| platform

    papi --> bank
    dapi -->|"payments proxied, never direct"| platform
    platform --> bank

    padmin --> platform
    padmin --> idp
```

Two things the diagram is making a point of:

- **`dapi` never touches a control-plane database.** It sees HTTP endpoints only. That's `CO3`,
  and it's assertable in the Aspire application model.
- **The dedicated plane does not call `fake-bank` directly** — payments proxy through the control
  plane, because our payment credentials must never sit on a customer's server (`CE2`).

---

## 2. Service graph

Each deployable and the store it owns. Same colour of box on both planes means *the same image*.

```mermaid
flowchart TD
    subgraph control["Control plane"]
        direction TB
        idp["identity<br/><i>Logto container</i>"]
        idpdb[("db-identity")]
        platform["platform<br/><i>Fastify</i>"]
        pfdb[("db-platform")]
        padmin["admin console<br/><i>TanStack Start</i>"]
        bank["fake-bank<br/><i>Fastify</i>"]

        idp --- idpdb
        platform --- pfdb
        padmin --> platform
        platform --> bank
        platform --> idp
    end

    subgraph plane["Data plane — one image, two modes"]
        direction TB
        api["store-api<br/><i>Fastify</i>"]
        db[("store db")]
        dash["dashboard<br/><i>TanStack Start</i>"]
        front["storefront<br/><i>Next.js</i>"]

        api --- db
        dash --> api
        front --> api
    end

    api -->|"JWKS"| idp
    api -->|"licence, telemetry, payments"| platform
    dash -->|"OIDC redirect"| idp
    front -->|"OIDC redirect"| idp
```

`DEPLOYMENT_MODE=pooled` gives that box N tenants in one database.
`DEPLOYMENT_MODE=dedicated` gives it exactly one. **No other difference** (`CC1`, `CC2`).

---

## 3. Tenancy tiers and routing

Three tiers, and the middle one is the one worth building early — it delivers most of what
merchants mean by "my own site" at a fraction of the cost of tier 3.

```mermaid
flowchart TD
    A["Merchant wants a store"] --> B{"Own domain?"}
    B -->|"no"| T1["<b>Tier 1 — pooled, path</b><br/>platform.example/shop/acme"]
    B -->|"yes"| C{"Own server?"}
    C -->|"no"| T2["<b>Tier 2 — pooled, custom domain</b><br/>acme.com, CNAME to our edge<br/>Traefik issues the cert"]
    C -->|"yes"| T3["<b>Tier 3 — dedicated</b><br/>acme.com on their VPS<br/>their database, our image"]

    T1 --> S1["shared database<br/>RLS, tenant_id per row"]
    T2 --> S1
    T3 --> S3["their database<br/>RLS on, exactly one tenant"]
```

**Tier 2 is out of the POC** — it is tier 1 code with the tenant resolved from a hostname instead
of a path, so it adds certificate automation and proves no new architecture. What the POC *does*
build is the seam: tenant resolution takes a **request** and checks host before path, so tier 2
later means adding a `domains` table and pointing DNS, not touching every route.

Routing at request time:

```mermaid
flowchart LR
    req["Incoming request"] --> edge["Traefik — our edge"]
    edge -->|"path /shop/:slug"| pooled["pooled store-api<br/>tenant from token"]
    edge -->|"Host: acme.com"| pooled
    direct["Incoming request"] --> theiredge["Traefik — their VPS"] --> dedic["dedicated store-api<br/>single tenant"]
```

The host **selects branding**. The **token decides** what you can read (`BI1`). A token whose
tenant disagrees with the host is a 403, not a tenant switch.

---

## 4. Who owns which data

```mermaid
flowchart LR
    subgraph cpd["Control plane owns"]
        u["users"]
        o["organizations = tenants"]
        m["memberships and roles"]
        l["licences and entitlements"]
        i["installations"]
        t["telemetry"]
    end

    subgraph tpd["Data plane owns"]
        p["products"]
        ord["orders"]
        inv["invoices"]
        cust["shoppers"]
        set["store settings"]
    end

    cpd -.->|"tenant id and entitlements<br/>flow down"| tpd
    tpd -.->|"signed usage and telemetry<br/>flow up"| cpd
```

Note where **shoppers** sit: in the data plane, per tenant — *not* in the IdP (`CD3`). Merchant
staff are in the IdP; storefront customers are rows.

---

## 5. Sign-in and token flow

The part that makes a server we don't control able to trust a token we issued.

```mermaid
sequenceDiagram
    autonumber
    actor M as Merchant staff
    participant W as dashboard
    participant ID as identity
    participant API as store-api<br/>(pooled or their VPS)

    M->>W: open dashboard
    W->>ID: OIDC redirect
    ID->>M: phone number
    M->>ID: OTP code
    ID-->>W: session, tenant-less
    W->>ID: request token for organization "acme"
    ID-->>W: access token, 15 min<br/>sub, tid=acme, roles
    W->>API: GET /products, Bearer token
    API->>ID: fetch JWKS (cached, rotated)
    API->>API: verify signature offline<br/>set local app.tenant_id = tid
    API-->>W: products for acme only
```

Steps 8–10 are the whole design: the data plane verifies **offline** against cached keys, then
hands the tenant to Postgres, where RLS — not application code — decides what the query can see
(`BE1`, `BE3`). Switching tenants means going back to step 6 for a new token (`BC1`).

---

## 6. Buy a store

The signup flow, with `fake-bank` standing in for a payment provider.

```mermaid
sequenceDiagram
    autonumber
    actor B as Buyer
    participant SITE as marketing site
    participant PF as platform
    participant BANK as fake-bank
    participant ID as identity

    B->>SITE: choose a plan
    SITE->>PF: POST /signup
    PF->>ID: create user if new
    PF->>PF: create tenant (status: pending)
    Note over PF: our own tenant id, minted here.<br/>The payment reference is an attribute (BV1)
    PF->>BANK: create payment
    BANK-->>B: payment page
    B->>BANK: pay
    BANK->>PF: callback, signed
    PF->>PF: verify signature, activate tenant
    PF->>ID: create organization + make buyer admin
    PF->>PF: issue licence
    PF-->>B: redirect to dashboard
```

Two deliberate choices here:

- **Signup creates the tenant; payment activates it.** That's why trials, internal demo stores and
  manually-onboarded merchants exist without faking a bank callback.
- **`fake-bank` verifies our signature before answering**, so a break in our request hash shows up
  on a laptop instead of at a real bank later (`CR1`).

---

## 7. Provisioning a dedicated instance

```mermaid
sequenceDiagram
    autonumber
    actor OP as Merchant's admin
    participant PAD as platform console
    participant PF as platform
    participant VPS as their VPS
    participant ID as identity

    OP->>PAD: request a dedicated instance
    PAD->>PF: create installation
    PF-->>OP: install command + one-time bootstrap token
    OP->>VPS: run the install command
    VPS->>PF: register, presenting bootstrap token
    PF-->>VPS: per-instance credentials + signed licence
    Note over PF,VPS: per-instance, revocable.<br/>Never a shared secret (CE1)
    VPS->>VPS: pull image, run migrations, seed one tenant
    VPS->>ID: fetch JWKS, cache it
    VPS->>PF: first telemetry batch:<br/>version, tenant, licence id
    PF-->>PAD: instance healthy
```

Every arrow is **outbound from the VPS** (`CE4`). Nothing reaches in — no SSH, no callback port,
no VPN.

---

## 8. What happens when the link breaks

The showcase demo: stop `platform` in the Aspire dashboard and watch the dedicated store keep
selling.

```mermaid
stateDiagram-v2
    [*] --> Healthy
    Healthy --> Grace: control plane unreachable
    Grace --> Healthy: reconnected
    Grace --> ReadOnly: grace window expired
    ReadOnly --> Healthy: reconnected, licence revalidated

    note right of Healthy
        licence fresh, JWKS fresh
        telemetry streaming
    end note

    note right of Grace
        cached JWKS still verifies tokens
        storefront and checkout keep working
        telemetry buffered on disk
    end note

    note right of ReadOnly
        browse and read still work
        no new orders, no config changes
        never a hard stop
    end note
```

A merchant's shop going dark because our licence server had a bad afternoon is the thing that
would kill the tier, so the terminal state is degraded, never off (`CG1`, `CG2`).

---

## 9. Data model

Control plane above the line, data plane below it.

```mermaid
erDiagram
    USER ||--o{ MEMBERSHIP : has
    TENANT ||--o{ MEMBERSHIP : has
    TENANT ||--|| LICENCE : holds
    TENANT ||--o{ INSTALLATION : "may have"
    TENANT ||--o{ DOMAIN : "may have"

    USER {
        uuid id PK
        string phone UK
        string name
    }
    TENANT {
        uuid id PK
        string slug UK
        string status
        string payment_ref "attribute, not the key"
        string tier "pooled or dedicated"
    }
    MEMBERSHIP {
        uuid user_id FK
        uuid tenant_id FK
        string role
    }
    LICENCE {
        uuid tenant_id FK
        jsonb entitlements
        date valid_until
    }
    INSTALLATION {
        uuid id PK
        uuid tenant_id FK
        string version
        timestamp last_seen
    }
    DOMAIN {
        uuid tenant_id FK
        string hostname UK
        string cert_status
    }

    TENANT_ROW ||--o{ PRODUCT : owns
    TENANT_ROW ||--o{ SHOPPER : owns
    TENANT_ROW ||--o{ ORDER_T : owns
    SHOPPER ||--o{ ORDER_T : places
    ORDER_T ||--|{ ORDER_LINE : contains
    PRODUCT ||--o{ ORDER_LINE : "appears in"
    ORDER_T ||--o| PAYMENT : has

    TENANT_ROW {
        uuid id PK "mirrored from control plane"
        string name
    }
    PRODUCT {
        uuid id PK
        uuid tenant_id FK
        string sku "unique per tenant, never global"
        numeric price
        timestamp starts_at "campaign window"
        timestamp ends_at
    }
    SHOPPER {
        uuid id PK
        uuid tenant_id FK
        string phone "unique per tenant"
    }
    ORDER_T {
        uuid id PK
        uuid tenant_id FK
        bigint number "per-tenant, gapless"
        string status
    }
    ORDER_LINE {
        uuid order_id FK
        uuid product_id FK
        int qty
    }
    PAYMENT {
        uuid order_id FK
        string provider_ref
        string status
    }
```

Every data-plane table carries `tenant_id` and an RLS policy — including in a dedicated install
where there is only ever one value in it (`CC2`). Uniqueness is always composite (`BG1`), and
order numbers come from a per-tenant counter, never a sequence (`BG2`).

---

## 10. What `aspire run` starts

One command brings up the control plane, a pooled store with two tenants, and a dedicated store
standing in for a customer's VPS.

```mermaid
flowchart TD
    subgraph always["starts by default"]
        direction TB
        idp["identity"]
        idpdb[("db-identity")]
        pf["platform"]
        pfdb[("db-platform")]
        adm["admin console"]
        bank["fake-bank"]
        papi["store-pooled"]
        pdb[("db-pooled")]
        pdash["dashboard-pooled"]
        pfront["storefront-pooled"]
        seed["dev-seed<br/>2 pooled tenants, 1 install"]
    end

    subgraph explicit["WithExplicitStart — start when needed"]
        direction TB
        dapi["store-acme<br/>DEPLOYMENT_MODE=dedicated"]
        ddb[("db-acme")]
        ddash["dashboard-acme"]
        old["store-oldco<br/>pinned N-1 image"]
    end

    edge["traefik<br/>*.localtest.me"]

    idp --- idpdb
    pf --- pfdb
    papi --- pdb
    dapi --- ddb
    edge --> pfront
    edge --> pdash
    edge --> ddash
    papi --> pf
    dapi -.->|"HTTP only"| pf
    dapi -.->|"HTTP only"| idp
    old -.-> pf
    seed --> pf
```

What that buys, beyond convenience:

| Demo | How |
|---|---|
| Tenant isolation is real | two pooled tenants seeded; the leak suite runs against them (`BL1`) |
| Same code, both modes | `store-pooled` and `store-acme` are the same app directory (`CC1`) |
| Offline behaviour | stop `platform` in the dashboard, watch `store-acme` degrade (§8) |
| Version skew | `store-oldco` runs the N-1 image against today's control plane (`CO2`) |
| Payment failure paths | `fake-bank` is told what to answer (`CR1`) |
| Unified telemetry | every resource, including the "remote" one, pushes OTLP to the Aspire dashboard |

Local hostnames use `*.localtest.me`, which resolves to 127.0.0.1 with no `/etc/hosts` editing:
`platform.localtest.me/shop/acme` (tier 1), `acme-store.localtest.me` (tier 2),
`acme.localtest.me` (tier 3).

---

## 11. POC scope

What the showcase needs to be convincing, and what it deliberately leaves out.

```mermaid
flowchart LR
    subgraph in["In scope"]
        direction TB
        i1["sign in with phone OTP"]
        i2["buy a store via fake-bank"]
        i3["dashboard: add products"]
        i4["storefront: browse, order"]
        i5["two pooled tenants, isolated"]
        i6["one dedicated instance"]
        i7["stop the control plane, keep selling"]
        i8["platform console sees both"]
    end

    subgraph out["Out of scope"]
        direction TB
        o1["real payment provider"]
        o2["invoicing and tax"]
        o3["custom domains and certs"]
        o4["SSO federation per tenant"]
        o5["search, recommendations"]
        o6["mobile"]
    end
```

The demo that makes the architecture land is **i7**: kill the control plane on stage and show a
merchant's shop still taking orders on its own server, then bring it back and watch the buffered
telemetry arrive. Everything else is table stakes; that one is the argument.

---

*Companion to [`../README.md`](../README.md) and [`dos-and-donts.md`](./dos-and-donts.md).*
