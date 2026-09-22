#:sdk Aspire.AppHost.Sdk@13.5.4
#:package Aspire.Hosting.PostgreSQL@13.5.4
#:property AspireUseCliBundle=true

// AppHost B -- a DEDICATED data plane, on a machine we do not own (BUILD-PLAN 8.4). One tenant,
// named by MERCATUS_TENANT_SLUG; "Zenith's VPS" is what the default slug makes it.
//
// This is the other half of the trust-boundary document, and the half that makes it a property of
// the tool rather than a convention (CO3). Read what is NOT in this file: there is no
// db-platform, no db-logto, no fake-bank, no platform process, no seed that reaches into our
// databases. AppHost B *cannot* reference AppHost A's Postgres, because those resources are not
// in this application model -- not "must not", cannot. The only edges to the control plane are
// the three AddExternalService entries below, and each of them is an HTTP URL.
//
// Everything is outbound (CE4). The control plane never calls in, holds no callback URL for this
// box and needs no route into its network. The store registers itself with a one-time bootstrap
// token, is given a per-instance credential (CE1), then pulls its licence and pushes its
// heartbeat on a timer.
//
// Run it with AppHost A already up:
//
//   cd aspire/AppHostA && aspire run --detach --non-interactive --nologo --format Json
//   cd aspire/AppHostB && MERCATUS_TENANT_SLUG=zenith aspire run --detach --non-interactive --nologo --format Json
//
// and stop each with `aspire stop` from its own directory. Two AppHosts means two dashboards,
// which is the honest arrangement: the control plane knows about this box exactly what this box
// chose to tell it (EQ, CL1).
//
// ONE FILE, ANY TENANT (v2.0.0 phase 2). There is no AppHost C and there never will be: a second
// dedicated tenant is this same model with a different MERCATUS_TENANT_SLUG. A second one running
// AT THE SAME TIME adds `--isolated`, which is the CLI's own answer to two AppHosts wanting one
// dashboard port -- see the note beside task-stack-manifest at the bottom of this file.

var builder = DistributedApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------------------------
// The control plane, as seen from someone else's server: three URLs and nothing else.
//
// They are AppHost A's STABLE addresses -- its Traefik on a fixed port, with *.localtest.me
// resolving to loopback without touching /etc/hosts. Stable is the requirement: a random
// Aspire-assigned port would make this a lookup into another application model, which is exactly
// the coupling the two-AppHost split exists to prevent. Everything else in this file IS
// Aspire-assigned; these are the addresses that cannot be, and they read the same environment
// variables A does, so overriding a collision is one variable exported to both commands and never
// an edit in two places.
//
// No WaitFor on any of them. A dedicated instance must boot with the control plane unreachable --
// that is the demo, and a store that refuses to start because our licence server had a bad
// afternoon is the failure CG1 exists to stop.
// ---------------------------------------------------------------------------------------------
int Port(string variable, int fallback) =>
    int.TryParse(Environment.GetEnvironmentVariable(variable), out var parsed) ? parsed : fallback;

var edgePort = Port("MERCATUS_EDGE_PORT", 28080);
var ControlPlaneUrl = $"http://platform.localtest.me:{edgePort}";
var FakeBankUrl = $"http://bank.localtest.me:{edgePort}";
// Logto keeps its own fixed host port; A's edge has no router for it, and its ENDPOINT (which is
// baked into the discovery document and every redirect) names this address.
var IdentityUrl = $"http://127.0.0.1:{Port("MERCATUS_LOGTO_PORT", 28311)}";

var controlPlane = builder.AddExternalService("ext-control-plane", ControlPlaneUrl)
    .WithHttpHealthCheck("/health");

// The payment stand-in (CR1). A dedicated plane calling it DIRECTLY is a known CE2 compromise
// carried since task 07a: our bank credentials have no business on a customer's server, and the
// correct path is the control plane's POST /payments/proxy. It is recorded in
// decisions-made-overnight.md and it is visible here rather than hidden in an app's environment.
var fakeBank = builder.AddExternalService("ext-fake-bank", FakeBankUrl)
    .WithHttpHealthCheck("/health");

// One issuer, one JWKS, for both planes (CD4). Unused while this instance runs on the stub
// adapter, and named anyway, because the dependency is real the moment AUTH_ADAPTER=oidc.
var identity = builder.AddExternalService("ext-identity", IdentityUrl);

// ---------------------------------------------------------------------------------------------
// Dev literals. Note which of A's secrets appear here and which do not.
//
//   FAKE_BANK_HMAC_SECRET  shared with A, and that is the CE2 compromise named above
//   AUTH_STUB_SECRET       NOT A's. This box mints and verifies its own stub tokens; there is no
//                          reason for it to hold the pooled plane's key, and CE1 says not to
//   SESSION_SECRET         NOT A's. The store signs its own session cookie, which is what keeps
//                          a signed-in shopper checking out while the control plane is dark (Q20)
//   PLATFORM_INTERNAL_TOKEN  ABSENT, deliberately. It is the POOLED plane's shared licence-poll
//                          credential. Handing a box someone else owns a platform-wide secret is
//                          precisely what CE1 forbids -- this instance polls with the per-instance
//                          token it was given at registration
// ---------------------------------------------------------------------------------------------
const string StoreOwner = "mercatus_owner:mercatus_owner_dev";
const string StoreApp = "mercatus_app:mercatus_app_dev";
const string FakeBankHmacSecret = "mercatus-dev-fake-bank-hmac-secret-0123456789";

// ---------------------------------------------------------------------------------------------
// WHICH TENANT THIS BOX SERVES -- the only thing that distinguishes one dedicated instance from
// another (v2.0.0 phase 2).
//
//   MERCATUS_TENANT_SLUG=orion aspire run --detach --non-interactive --nologo --format Json
//
// EVERYTHING per-tenant below is derived from this one string: the resource names, the Postgres
// container and its database, the credential file, the identity cache, the storefront's build
// directory, the dev bootstrap token and the half of the address book this box publishes. There
// is no second copy of this file to keep in step, and adding a tenant is still zero edits to
// AppHost A.
//
// The slug is VALIDATED, not trusted. It becomes a resource name, a container name and a file
// path; `../etc/passwd` is not a tenant. `zenith` is the default so the everyday loop, the README
// and the e2e suite keep working with a bare `aspire run`.
// ---------------------------------------------------------------------------------------------
string Env(string name, string fallback) =>
    Environment.GetEnvironmentVariable(name) is { Length: > 0 } value ? value : fallback;

var TenantSlug = Env("MERCATUS_TENANT_SLUG", "zenith");
if (!System.Text.RegularExpressions.Regex.IsMatch(TenantSlug, "^[a-z][a-z0-9-]{1,38}$"))
{
    throw new InvalidOperationException(
        $"MERCATUS_TENANT_SLUG '{TenantSlug}' is not a slug: lower-case, starting with a letter, " +
        "letters/digits/hyphens only, 2-39 characters. It becomes a resource name, a container " +
        "name and a file path, so it is checked here rather than trusted.");
}

// ---------------------------------------------------------------------------------------------
// AND THE HOSTNAME IT ANSWERS ON. A dedicated instance is a box of its own, so it gets an address
// of its own: `<slug>.localtest.me`, which resolves to loopback with no /etc/hosts entry.
//
// This is not decoration, it is the cookie jar. Cookies are scoped by host and IGNORE THE PORT,
// so every storefront published as `localhost:<port>` shares one jar: signing the shopper in at
// the second shop overwrites the first shop's session, and since every box has its own session
// key (CE1, correctly) the token left behind is one the other store refuses. The symptom is a
// checkout that answers UNAUTHENTICATED on a page still naming the shopper (lessons/17). The e2e
// suite used to paper over this by rewriting the hostname on its way into the browser; since
// v2.0.0 the browser-facing addresses are registered as redirect URIs, so the rewrite would send
// the shopper to an address the issuer was never told about. Publishing the real hostname fixes
// both at once.
//
// The port is still Aspire-assigned -- only the host is ours. A ParameterResource carries the
// literal, because a ReferenceExpression hole only accepts an IValueProvider (lessons/05).
// ---------------------------------------------------------------------------------------------
var publicHost = builder.AddParameter("public-host", $"{TenantSlug}.localtest.me");

ReferenceExpression PublicUrl(EndpointReference endpoint) =>
    ReferenceExpression.Create($"http://{publicHost.Resource}:{endpoint.Property(EndpointProperty.Port)}");

// NOT A's, and now not a literal either: per-instance by construction (CE1). A second dedicated
// tenant on this machine mints its own stub key and its own session key, and neither box can read
// the other's cookies.
var AuthStubSecret = $"mercatus-dev-{TenantSlug}-auth-stub-secret-0123456789";
var SessionSecret = $"mercatus-dev-{TenantSlug}-session-secret-0123456789";

// The one-time bootstrap token. In the product an operator mints it once in the platform console
// (`POST /installations {tenantSlug, expectedHost}`) and pastes it into the install command, which
// is what MERCATUS_BOOTSTRAP_TOKEN is for. The default is the literal
// `pnpm --filter @mercatus/db-platform seed:dedicated` seeds in AppHost A, so the dev loop has no
// human in it. It is spent on first use and is worthless afterwards.
var BootstrapToken = Env("MERCATUS_BOOTSTRAP_TOKEN", $"mercatus-dev-bootstrap-token-for-{TenantSlug}-001");

// NO TENANT NAME HERE. The control plane owns the tenant's display name and says what it is in
// the registration answer; the install command mirrors that (BV1). A name in this file would be
// a second copy of a fact we already ask for, and the one string that could not be derived from
// the slug.

// NOTHING IN THIS FILE IS A FIXED PORT. Until v2.0.0 the store API was: AppHost A had to register
// it as an OIDC redirect target before this AppHost had ever run, so both models read
// MERCATUS_STORE_DEDICATED_PORT and agreed on 28403 in advance. That agreement is gone. The store
// is Aspire-assigned like everything else here, the install command REPORTS the address it was
// given (`POST /installations/register`), and the control plane registers exactly that. Adding a
// second dedicated tenant is now zero edits to AppHost A.

var repoRoot = "../..";

// The credential the install command writes and the store reads (CE1). Both resources run with
// their working directory inside apps/store -- `pnpm --filter` runs a script with cwd = the
// package directory -- so one relative path serves both and lands at the repo root.
var instanceTokenPath = $"../../.instance/{TenantSlug}.json";

// The identity cache: this instance's OIDC client, the issuer's key set, and the one organization
// that is this tenant. WRITTEN BY THE INSTALL COMMAND from what registration answered -- AppHost A
// does not write it, does not know this address, and no longer has a second client to hand over.
//
// The store's adapter reads this file ONCE, in its constructor, and never again. That is why the
// store waits for the install command to FINISH and not merely to start.
var identityCachePath = $"../../.identity/store-{TenantSlug}.json";

var authAdapter = Environment.GetEnvironmentVariable("MERCATUS_AUTH_ADAPTER") is "oidc" ? "oidc" : "stub";

var pgUser = builder.AddParameter("pg-user", "postgres");
var pgPassword = builder.AddParameter("pg-password", "mercatusdevpassword", secret: true);

// ---------------------------------------------------------------------------------------------
// THEIR database. One Postgres, one tenant in it, and the same schema and the same RLS policies
// the pooled plane runs (CC2) -- N=1 is a configuration, not a second product. Default container
// lifetime, never persistent (#818).
// ---------------------------------------------------------------------------------------------
var pgTenant = builder.AddPostgres($"pg-tenant-{TenantSlug}", pgUser, pgPassword);
var dbTenant = pgTenant.AddDatabase($"db-tenant-{TenantSlug}", "store");

ReferenceExpression Url(IResourceBuilder<PostgresServerResource> server, string credentials, string database) =>
    ReferenceExpression.Create(
        $"postgres://{credentials}@{server.Resource.PrimaryEndpoint.Property(EndpointProperty.HostAndPort)}/{database}");

ReferenceExpression SuperuserUrl(IResourceBuilder<PostgresServerResource> server, string database) =>
    ReferenceExpression.Create(
        $"postgres://postgres:{pgPassword.Resource}@{server.Resource.PrimaryEndpoint.Property(EndpointProperty.HostAndPort)}/{database}");

var migrate = builder.AddExecutable($"task-migrate-tenant-{TenantSlug}", "pnpm", repoRoot,
        "--filter", "@mercatus/db-store", "migrate")
    .WithEnvironment("DATABASE_SUPERUSER_URL", SuperuserUrl(pgTenant, "store"))
    .WithEnvironment("DATABASE_ADMIN_URL", Url(pgTenant, StoreOwner, "store"))
    .WithReference(dbTenant)
    .WaitFor(dbTenant);

// ---------------------------------------------------------------------------------------------
// The install command (architecture.md 7). Registers with the bootstrap token, writes the
// per-instance credential 0600, mirrors the tenant the control plane named into THIS database,
// and -- dev loop only -- puts a catalog in it.
//
// It needs the control plane to be reachable exactly once, ever. After that the credential file
// is on the box and this step is a no-op, which is what makes it idempotent and resumable (CK2).
// ---------------------------------------------------------------------------------------------
var provision = builder.AddExecutable($"task-provision-tenant-{TenantSlug}", "pnpm", repoRoot,
        "--filter", "@mercatus/store", "provision")
    .WithEnvironment("PLATFORM_URL", ControlPlaneUrl)
    .WithEnvironment("INSTANCE_BOOTSTRAP_TOKEN", BootstrapToken)
    .WithEnvironment("INSTANCE_TOKEN_PATH", instanceTokenPath)
    .WithEnvironment("DATABASE_ADMIN_URL", Url(pgTenant, StoreOwner, "store"))
    .WithEnvironment("TENANT_SLUG", TenantSlug)
    // Run mode only. A published topology must never invent stock (the sibling of CR1's gate).
    .WithEnvironment("DEV_SEED_CATALOG", builder.ExecutionContext.IsRunMode ? "1" : "0")
    .WithEnvironment("IDENTITY_CACHE_PATH", identityCachePath)
    .WithReference(controlPlane)
    .WithReference(identity)
    .WaitForCompletion(migrate);

// ---------------------------------------------------------------------------------------------
// The apps. The SAME code as the pooled plane, with DEPLOYMENT_MODE=dedicated and one tenant
// (CC1): no fork, no self-hosted edition, no second code path.
// ---------------------------------------------------------------------------------------------
// `port: null` means Aspire allocates -- for EVERY resource here now, the store included.
// isProxied:false throughout -- the process binds the port itself, which is what makes the
// allocated number the number that is actually listening, and therefore the number worth
// reporting to the control plane as a redirect target.
IResourceBuilder<ExecutableResource> Node(string name, string appDirectory, int? port, params string[] args) =>
    builder.AddExecutable(name, "node", $"{repoRoot}/apps/{appDirectory}", args)
        .WithHttpEndpoint(port: port, targetPort: port, name: "http", env: "PORT", isProxied: false)
        .WithEnvironment("NODE_ENV", "development")
        .WithOtlpExporter();

var store = Node($"api-store-tenant-{TenantSlug}", "store", null,
        // tsx first, so the second preload can BE TypeScript; telemetry second, so the SDK
        // patches http and pg before the application graph is built.
        "--import", "tsx",
        "--import", "../../packages/core/src/telemetry.ts",
        "src/index.ts")
    .WithEnvironment("HOST", "0.0.0.0")
    .WithEnvironment("DEPLOYMENT_MODE", "dedicated")
    .WithEnvironment("TENANT_SLUG", TenantSlug)
    .WithEnvironment("DATABASE_URL", Url(pgTenant, StoreApp, "store"))
    .WithEnvironment("AUTH_ADAPTER", authAdapter)
    .WithEnvironment("AUTH_STUB_SECRET", AuthStubSecret)
    .WithEnvironment("OIDC_ISSUER", $"{IdentityUrl}/oidc")
    .WithEnvironment("OIDC_JWKS_CACHE_PATH", identityCachePath)
    .WithEnvironment("SESSION_SECRET", SessionSecret)
    .WithEnvironment("BASE_HOST", "localtest.me")
    // CE4: this box PULLS. One URL out, no route in.
    .WithEnvironment("PLATFORM_URL", ControlPlaneUrl)
    // Read-only, and NOT a credential: the store asks the bank whether a payment settled so the
    // merchant's own dashboard can say whether an order was paid. It holds no HMAC secret, so
    // nothing here can create a payment or sign anything (CE2). The storefront beside it still
    // does, which is the compromise named above.
    .WithEnvironment("FAKE_BANK_URL", FakeBankUrl)
    // ... with the credential it minted for itself at registration. There is no
    // PLATFORM_INTERNAL_TOKEN on this resource and there must never be one (CE1).
    .WithEnvironment("INSTANCE_TOKEN_PATH", instanceTokenPath)
    .WithEnvironment("LICENCE_POLL_SECONDS", "5")
    // Sixty seconds rather than the 72-hour default (CG2), for the same reason A uses it: a grace
    // window is only demonstrable if you can sit through it.
    .WithEnvironment("LICENCE_GRACE_SECONDS", "60")
    .WithHttpHealthCheck("/health")
    .WithReference(dbTenant)
    .WithReference(controlPlane)
    .WithReference(fakeBank)
    .WithReference(identity)
    .WaitFor(dbTenant)
    .WaitForCompletion(provision);

// Ships with the instance (DK): the same Next.js app as the pooled storefront, with TENANT_SLUG
// set. That one variable is the whole of "dedicated mode" here -- the root path becomes this one
// store instead of an index of stores.
// Two addresses for the same socket, and the difference matters.
//
//   storeUrl        what Aspire assigned: `localhost:<port>`. Internal wiring only.
//   storePublicUrl  where a BROWSER is sent: `<slug>.localtest.me:<same port>`. It is what gets
//                   registered as a redirect URI and what the control plane pins the host on.
var storeUrl = store.GetEndpoint("http");
var storePublicUrl = PublicUrl(store.GetEndpoint("http"));

// Self-reference, no WaitFor: the store builds absolute URLs out of its own address and cannot
// wait on an endpoint it owns.
store.WithEnvironment("STORE_PUBLIC_URL", storePublicUrl);

var storefront = Node($"web-storefront-tenant-{TenantSlug}", "storefront", null,
        "node_modules/next/dist/bin/next", "dev")
    .WithEnvironment("TENANT_SLUG", TenantSlug)
    .WithEnvironment("STORE_API_URL", storeUrl)
    // The CE2 compromise, in the open: their box signs payment requests with our bank's key.
    .WithEnvironment("FAKE_BANK_URL", FakeBankUrl)
    .WithEnvironment("FAKE_BANK_HMAC_SECRET", FakeBankHmacSecret)
    // AppHost A runs the same package out of the same directory. Without a distDir of its own,
    // whichever `next dev` starts second writes over the first one's build output.
    .WithEnvironment("NEXT_DIST_DIR", $".next-{TenantSlug}")
    .WithReference(fakeBank)
    .WithHttpHealthCheck($"/t/{TenantSlug}")
    .WaitFor(store);

// The merchant's own dashboard, on their own server (DK). It is the same build as the pooled
// one with a different VITE_STORE_API_URL, and it is why "the control plane is down" does not
// mean "the merchant cannot see their orders".
// 0.0.0.0, not 127.0.0.1: this is reached at `<slug>.localtest.me`, whose only A record is
// loopback but whose AAAA record is `::1` -- a browser tries the v6 address first and falls back,
// and a server bound to one interface makes that fallback the difference between working and not.
var dashboard = Node($"web-dashboard-tenant-{TenantSlug}", "dashboard", null,
        "node_modules/vite/bin/vite.js", "--host", "0.0.0.0")
    .WithEnvironment("VITE_STORE_API_URL", storeUrl)
    .WithHttpHealthCheck("/")
    .WaitFor(store);

var storefrontUrl = PublicUrl(storefront.GetEndpoint("http"));
var dashboardUrl = PublicUrl(dashboard.GetEndpoint("http"));
storefront.WithEnvironment("STOREFRONT_PUBLIC_URL", storefrontUrl);

// ---------------------------------------------------------------------------------------------
// v2.0.0: the install command is told where the three surfaces it is about to register ACTUALLY
// answer. Attached here rather than at the declaration above only because a C# variable has to
// exist before it can be referenced -- AppHost A does the same for its identity bootstrap.
//
// These are EndpointReferences, so the strings are the ones Aspire assigned, spelled the way
// Aspire spells them (`localhost`). That is the point: Logto matches a redirect_uri as a string,
// so the address registered as a redirect target has to be character-for-character the address
// the store will later send as its `redirect_uri` -- and it is, because both come from here
// (lessons/14). The installation is also HOST-PINNED at the control plane, so a box that reports
// somewhere else is refused (GK).
//
// No WaitFor is created by any of these: the store waits for this task, not the other way round.
// ---------------------------------------------------------------------------------------------
provision
    .WithEnvironment("STORE_PUBLIC_URL", storePublicUrl)
    .WithEnvironment("STOREFRONT_PUBLIC_URL", storefrontUrl)
    .WithEnvironment("DASHBOARD_PUBLIC_URL", dashboardUrl);

// And the STORE gets the same two, because the store is the only OIDC client on this box: it is
// the one process holding a client secret, so `/auth/login?via=storefront|dashboard` builds its
// redirect_uri from these. Same variables, same strings, same spelling as what was registered.
store
    .WithEnvironment("STOREFRONT_PUBLIC_URL", storefrontUrl)
    .WithEnvironment("DASHBOARD_PUBLIC_URL", dashboardUrl);

// ---------------------------------------------------------------------------------------------
// This box's half of the address book (see AppHostA for the other).
//
// ONE FILE PER INSTANCE, named after the tenant -- `.stack/apphost-{slug}.json` -- because there
// is no longer "the" dedicated instance to call `apphost-b.json`. The keys inside it are
// unqualified (`store`, `storefront`, `dashboard`) and the tenant is named ONCE, at the top of
// the file: the reader groups by instance rather than parsing a slug back out of a key it also
// has to camel-case. `packages/e2e/tests/helpers/stack.ts` globs these and skips the specs of an
// instance that is not up, which is the same signal "B is not up" always was.
//
// TWO OF THESE AT ONCE (phase 3) is `aspire run --isolated` for the second one: the AppHost's own
// dashboard, OTLP and resource-service ports are the fixed numbers in `apphost.run.json`, and
// `--isolated` is the CLI's own answer to wanting them randomised. Nothing else collides --
// every resource port here is Aspire-assigned, the container names, the paths and this manifest
// are all keyed by the slug.
// ---------------------------------------------------------------------------------------------
builder.AddExecutable("task-stack-manifest", "node", repoRoot, "aspire/scripts/write-stack-manifest.mjs")
    .WithEnvironment("MERCATUS_MANIFEST_OUT", $".stack/apphost-{TenantSlug}.json")
    .WithEnvironment("MERCATUS_MANIFEST_TENANT", TenantSlug)
    // The PUBLIC spelling, in all three: drive a store at the address it publishes or you will
    // spend an afternoon on a cookie that was set on the other name (lessons/14).
    .WithEnvironment("MERCATUS_EP_STORE", storePublicUrl)
    .WithEnvironment("MERCATUS_EP_STOREFRONT", storefrontUrl)
    .WithEnvironment("MERCATUS_EP_DASHBOARD", dashboardUrl);

builder.Build().Run();
