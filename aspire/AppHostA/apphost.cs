#:sdk Aspire.AppHost.Sdk@13.5.4
#:package Aspire.Hosting.PostgreSQL@13.5.4
#:property AspireUseCliBundle=true

// AppHost A -- the CONTROL PLANE and the pooled data plane (BUILD-PLAN 8.3).
//
// This file is the trust-boundary document (CO3). Everything in it is ours: the control plane,
// the pooled store that we operate, the databases behind both, and the edge in front of them.
// AppHost B ("their VPS") is a SEPARATE application model that binds to this one only through
// AddExternalService -- it cannot reference a database here, because these resources are not in
// its model. That is what makes the boundary a property of the tool rather than a convention a
// reviewer has to remember.
//
// Two Postgres SERVERS, not one server with two databases. The control plane and the data plane
// are separate blast radii; one container each costs nothing on a laptop and means a store
// process holding DATABASE_URL has nothing to reach even if it were handed the wrong credential.
// Both use the DEFAULT container lifetime -- never persistent (#818): a persistent container is
// shared by every checkout on the machine, so a second clone silently attaches to the same data.

var builder = DistributedApplication.CreateBuilder(args);

// ---------------------------------------------------------------------------------------------
// Dev literals. This topology only ever exists on a laptop; nothing below is a credential
// anywhere else. The role passwords match packages/db-*/sql/00-roles.sql, which is where the
// roles are actually created.
// ---------------------------------------------------------------------------------------------
const string StoreOwner = "mercatus_owner:mercatus_owner_dev";
const string StoreApp = "mercatus_app:mercatus_app_dev";
const string PlatformOwner = "mercatus_platform_owner:mercatus_platform_owner_dev";
const string PlatformApp = "mercatus_platform_app:mercatus_platform_app_dev";

// Both are >= 32 characters. jose refuses an HS256 key shorter than that, and fake-bank's config
// demands 32 -- a shorter secret boots the platform and fails the bank, which is a mismatch
// discovered at the first payment instead of at the first start.
const string AuthStubSecret = "mercatus-dev-auth-stub-secret-0123456789";
const string FakeBankHmacSecret = "mercatus-dev-fake-bank-hmac-secret-0123456789";
// The store signs its OWN session cookie with this, and keeps verifying it while the control
// plane is down (README Q20). Separate from the stub secret on purpose: the session outlives the
// stub, and a dedicated instance holds this one and nothing else of ours (CE1).
const string SessionSecret = "mercatus-dev-session-secret-0123456789";
// The credential the POOLED store polls its licences with (BUILD-PLAN 6.1: "instance token or
// internal"). A dedicated plane never gets this -- it registers and is given its own revocable
// instance token (CE1). This one is shared, and that is defensible for exactly one reason: the
// pooled plane is a process we run, on our machine, beside the control plane.
const string PlatformInternalToken = "mercatus-dev-internal-token-0123456789";

const int PlatformPort = 4001;
const int StorePooledPort = 4002;
const int FakeBankPort = 4004;
const int StorefrontPort = 3001;
const int DashboardPort = 5173;
const int AdminPort = 5174;
const int TraefikPort = 8080;
// Logto's own defaults are 3001 and 3002, which are the two storefronts here (BUILD-PLAN 8.1).
// The container keeps its internal ports; only the host side moves.
const int LogtoPort = 3011;
const int LogtoAdminPort = 3012;

var repoRoot = "../..";

// Pre-built strings. An interpolated literal handed to WithEnvironment binds to the
// ReferenceExpression overload, and an int is not an IValueProvider.
var platformBase = $"http://127.0.0.1:{PlatformPort}";
var storePooledBase = $"http://127.0.0.1:{StorePooledPort}";
var logtoBase = $"http://127.0.0.1:{LogtoPort}";
var logtoAdminBase = $"http://127.0.0.1:{LogtoAdminPort}";
var logtoIssuer = $"{logtoBase}/oidc";

// AUTH_ADAPTER for the data plane. The DEFAULT IS STILL `stub`, deliberately: the dashboard, the
// admin console and the storefront all sign in through `/dev/login/*`, which exists only while
// the stub is the adapter. `MERCATUS_AUTH_ADAPTER=oidc aspire run` swaps the whole data plane
// onto Logto, and nothing else about the topology changes (CC1).
var authAdapter = Environment.GetEnvironmentVariable("MERCATUS_AUTH_ADAPTER") is "oidc" ? "oidc" : "stub";
var fakeBankBase = $"http://127.0.0.1:{FakeBankPort}";
var storefrontBase = $"http://127.0.0.1:{StorefrontPort}";
var traefikEntrypoint = $"--entrypoints.web.address=:{TraefikPort}";

// The generated Postgres superuser password is random and may contain characters that are not
// safe in a URL. Every connection string here is a postgres:// URL (BUILD-PLAN 8.2), so the
// password is pinned to something URL-clean instead.
var pgUser = builder.AddParameter("pg-user", "postgres");
var pgPassword = builder.AddParameter("pg-password", "mercatusdevpassword", secret: true);

// ---------------------------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------------------------
var pgPlatform = builder.AddPostgres("pg-platform", pgUser, pgPassword);
var dbPlatform = pgPlatform.AddDatabase("db-platform", "platform");

var pgStore = builder.AddPostgres("pg-store", pgUser, pgPassword);
var dbStore = pgStore.AddDatabase("db-store", "store");

// Identity gets its OWN server too. It is a bought component (CD1, CD2) with a schema we do not
// own and must never migrate, so it does not share a cluster with anything we do own.
var pgLogto = builder.AddPostgres("pg-logto", pgUser, pgPassword);
var dbLogto = pgLogto.AddDatabase("db-logto", "logto");

// postgres://<role>@<host:port>/<database>. The endpoint is resolved by Aspire at run time --
// AddPostgres binds a random host port, so nothing here may hard-code one.
ReferenceExpression Url(IResourceBuilder<PostgresServerResource> server, string credentials, string database) =>
    ReferenceExpression.Create(
        $"postgres://{credentials}@{server.Resource.PrimaryEndpoint.Property(EndpointProperty.HostAndPort)}/{database}");

ReferenceExpression SuperuserUrl(IResourceBuilder<PostgresServerResource> server, string database) =>
    ReferenceExpression.Create(
        $"postgres://postgres:{pgPassword.Resource}@{server.Resource.PrimaryEndpoint.Property(EndpointProperty.HostAndPort)}/{database}");

// ---------------------------------------------------------------------------------------------
// Migrations. An ordered, observable step with its own exit code -- never in-process in a server.
//   DATABASE_SUPERUSER_URL  creates the roles (it is the only connection that can)
//   DATABASE_ADMIN_URL      owns the schema: drizzle-kit, the RLS policies, the seed
// No server resource below is ever given either of them (BE2).
// ---------------------------------------------------------------------------------------------
var migratePlatform = builder.AddExecutable("migrate-platform", "pnpm", repoRoot,
        "--filter", "@mercatus/db-platform", "migrate")
    .WithEnvironment("DATABASE_SUPERUSER_URL", SuperuserUrl(pgPlatform, "platform"))
    .WithEnvironment("DATABASE_ADMIN_URL", Url(pgPlatform, PlatformOwner, "platform"))
    .WithReference(dbPlatform)
    .WaitFor(dbPlatform);

var migrateStore = builder.AddExecutable("migrate-store", "pnpm", repoRoot,
        "--filter", "@mercatus/db-store", "migrate")
    .WithEnvironment("DATABASE_SUPERUSER_URL", SuperuserUrl(pgStore, "store"))
    .WithEnvironment("DATABASE_ADMIN_URL", Url(pgStore, StoreOwner, "store"))
    .WithReference(dbStore)
    .WaitFor(dbStore);

// ---------------------------------------------------------------------------------------------
// The dev seed. RUN MODE ONLY (CR1's sibling rule): a topology that is published must not carry
// a step that invents tenants. Two pooled tenants with products, and one dedicated tenant with
// an unspent installation record for AppHost B to register against in task 10.
// ---------------------------------------------------------------------------------------------
IResourceBuilder<ExecutableResource>? devSeed = null;
if (builder.ExecutionContext.IsRunMode)
{
    devSeed = builder.AddExecutable("dev-seed", "pnpm", repoRoot, "run", "dev-seed")
        // Two owners, one process: db-platform prefers PLATFORM_DATABASE_ADMIN_URL, exactly as
        // its test suite prefers PLATFORM_DATABASE_URL, for the same reason -- one variable
        // cannot name two databases.
        .WithEnvironment("PLATFORM_DATABASE_ADMIN_URL", Url(pgPlatform, PlatformOwner, "platform"))
        .WithEnvironment("DATABASE_ADMIN_URL", Url(pgStore, StoreOwner, "store"))
        .WaitForCompletion(migratePlatform)
        .WaitForCompletion(migrateStore);
}

// ---------------------------------------------------------------------------------------------
// Identity -- a Logto CONTAINER we configure, never fork (CD1, CD2). One issuer for both planes
// and both audiences, so a dedicated store on somebody else's server has exactly one JWKS to
// cache (CD4).
//
// The entrypoint is the one from Logto's own compose file: seed the database if it is empty
// ("--swe" = skip when exists, so a restart is not a re-seed), then start. ENDPOINT and
// ADMIN_ENDPOINT must be the HOST-VISIBLE urls, because they end up in the discovery document
// and in every redirect the browser follows.
// ---------------------------------------------------------------------------------------------
var logto = builder.AddContainer("logto", "svhd/logto", "1.43.0")
    .WithEntrypoint("sh")
    .WithArgs("-c", "npm run cli db seed -- --swe && npm start")
    .WithEnvironment("TRUST_PROXY_HEADER", "1")
    .WithEnvironment("DB_URL", SuperuserUrl(pgLogto, "logto"))
    .WithEnvironment("ENDPOINT", logtoBase)
    .WithEnvironment("ADMIN_ENDPOINT", logtoAdminBase)
    .WithHttpEndpoint(port: LogtoPort, targetPort: 3001, name: "core")
    .WithHttpEndpoint(port: LogtoAdminPort, targetPort: 3002, name: "admin")
    // /api/status answers **204**, and WithHttpHealthCheck defaults to expecting 200 -- leaving
    // the default makes the resource never go healthy and every WaitFor on it hang forever, with
    // nothing in the log but "changed state: Starting -> Waiting". There is no /health.
    .WithHttpHealthCheck("/api/status", 204, "core")
    .WaitFor(dbLogto);

// Provisioning, not migration: organizations = tenants, one application per surface, staff users
// with organization membership and shoppers with none (CD3). Idempotent, so a re-run is a no-op
// (CK2). It reads the seeded `m-default` M2M secret out of Logto's own database -- see
// packages/identity/src/logto.ts for why that is the only way in without a browser.
//
// It also writes the data plane's identity cache: client registration, discovery document, key
// set and the organization -> slug directory. That file is what lets a store verify an
// organization token offline from its first request rather than only after somebody signs in.
// `pnpm --filter <pkg> <script>` runs the script with cwd = the PACKAGE directory, NOT this
// executable's working directory. So the bootstrap's own paths climb back out of
// packages/identity, while the store's climb out of apps/store -- both landing on the same file
// at the repo root. Getting this wrong writes a cache nobody reads and fails silently.
var identityCache = ".identity/store-pooled.json";
var identityCacheFromPackage = $"../../{identityCache}";
var logtoBootstrap = builder.AddExecutable("logto-bootstrap", "pnpm", repoRoot,
        "--filter", "@mercatus/identity", "bootstrap")
    .WithEnvironment("LOGTO_ENDPOINT", logtoBase)
    .WithEnvironment("LOGTO_ADMIN_ENDPOINT", logtoAdminBase)
    .WithEnvironment("LOGTO_DB_URL", SuperuserUrl(pgLogto, "logto"))
    .WithEnvironment("IDENTITY_CACHE_PATH", identityCacheFromPackage)
    .WithEnvironment("IDENTITY_OUT", "../../.identity/bootstrap.json")
    .WithEnvironment("STORE_POOLED_URL", storePooledBase)
    .WithEnvironment("STORE_DEDICATED_URL", "http://127.0.0.1:4003")
    .WaitFor(logto);

// ---------------------------------------------------------------------------------------------
// Services. HOST=0.0.0.0 because Traefik reaches them from inside a container, over the docker
// host gateway; a listener bound to 127.0.0.1 is not reachable from there.
// ---------------------------------------------------------------------------------------------
IResourceBuilder<ExecutableResource> Node(string name, string appDirectory, int port) =>
    builder.AddExecutable(name, "node", $"{repoRoot}/apps/{appDirectory}",
            // Two preloads, in this order. tsx first, so the second one can BE TypeScript.
            // telemetry.ts second, so the OpenTelemetry SDK patches http and pg before the
            // application graph is evaluated -- imported from inside index.ts it would be too
            // late, and the failure is silent: the service runs, the dashboard stays empty.
            "--import", "tsx",
            "--import", "../../packages/core/src/telemetry.ts",
            "src/index.ts")
        // isProxied:false -- the process binds the port itself. A DCP proxy listens on
        // loopback only, and Traefik reaches these from inside a container over the host
        // gateway, so a proxied endpoint would be unreachable from the edge.
        .WithHttpEndpoint(port: port, targetPort: port, name: "http", env: "PORT", isProxied: false)
        .WithEnvironment("HOST", "0.0.0.0")
        .WithEnvironment("NODE_ENV", "development")
        .WithOtlpExporter()
        .WithHttpHealthCheck("/health");

var fakeBank = Node("fake-bank", "fake-bank", FakeBankPort)
    // The run-mode gate (CR1). Only an AppHost sets it, and a published topology never does.
    .WithEnvironment("MERCATUS_ALLOW_FAKE_BANK", "1")
    .WithEnvironment("FAKE_BANK_HMAC_SECRET", FakeBankHmacSecret);

var platform = Node("platform", "platform", PlatformPort)
    .WithEnvironment("DATABASE_URL", Url(pgPlatform, PlatformApp, "platform"))
    .WithEnvironment("AUTH_ADAPTER", "stub")
    .WithEnvironment("AUTH_STUB_SECRET", AuthStubSecret)
    .WithEnvironment("PLATFORM_INTERNAL_TOKEN", PlatformInternalToken)
    .WithEnvironment("PLATFORM_URL", platformBase)
    .WithEnvironment("FAKE_BANK_URL", fakeBankBase)
    .WithEnvironment("FAKE_BANK_HMAC_SECRET", FakeBankHmacSecret)
    .WithReference(dbPlatform)
    .WaitFor(dbPlatform)
    .WaitForCompletion(migratePlatform)
    .WaitFor(fakeBank);

var storePooled = Node("store-pooled", "store", StorePooledPort)
    // One image, two modes, no second code path (CC1). This is the pooled half.
    .WithEnvironment("DEPLOYMENT_MODE", "pooled")
    .WithEnvironment("DATABASE_URL", Url(pgStore, StoreApp, "store"))
    .WithEnvironment("AUTH_ADAPTER", authAdapter)
    // Both are always set. The stub secret is inert under AUTH_ADAPTER=oidc, and the issuer is
    // inert under `stub` -- which is what makes the swap one environment variable (CC1, CC3).
    .WithEnvironment("AUTH_STUB_SECRET", AuthStubSecret)
    .WithEnvironment("OIDC_ISSUER", logtoIssuer)
    // Relative to the store's own working directory, which is apps/store.
    .WithEnvironment("OIDC_JWKS_CACHE_PATH", $"../../{identityCache}")
    .WithEnvironment("SESSION_SECRET", SessionSecret)
    .WithEnvironment("STORE_PUBLIC_URL", storePooledBase)
    .WithEnvironment("BASE_HOST", "localtest.me")
    // CE4: the store PULLS. This is the only thing pointing at the control plane, and there is
    // no route in the other direction anywhere in this file.
    .WithEnvironment("PLATFORM_URL", platformBase)
    .WithEnvironment("PLATFORM_INTERNAL_TOKEN", PlatformInternalToken)
    // Read-only, and not a credential. The store asks the bank whether a payment settled and
    // records the answer, because "did this order get paid" is the one question the merchant
    // dashboard exists to answer -- and it used to live only in the storefront's memory.
    .WithEnvironment("FAKE_BANK_URL", fakeBankBase)
    // Five seconds, not the 10-second default: the demo flips a tenant to passive in the console
    // and the storefront has to refuse a checkout while somebody is still looking at the screen.
    .WithEnvironment("LICENCE_POLL_SECONDS", "5")
    // Sixty seconds, not the 72-hour default (CG2). A grace window is only demonstrable if you
    // can sit through it, and a laptop topology is the one place that is true. Production keeps
    // the default -- the number is configuration precisely so it can differ here.
    .WithEnvironment("LICENCE_GRACE_SECONDS", "60")
    .WithReference(dbStore)
    .WaitFor(dbStore)
    .WaitForCompletion(migrateStore);

if (authAdapter is "oidc")
{
    // The store PULLS its client registration and the key set out of the identity cache, so the
    // bootstrap has to have finished before it boots (CE7). Under `stub` this edge does not
    // exist and Logto is simply a resource sitting there, costing a container.
    storePooled.WaitForCompletion(logtoBootstrap);
}

if (devSeed is not null)
{
    // The gate curls for seeded products the moment health goes green, so the seed is a
    // precondition of the store being up rather than a race against it.
    storePooled.WaitForCompletion(devSeed);
    platform.WaitForCompletion(devSeed);
}

// ---------------------------------------------------------------------------------------------
// The edge. A FIXED port, because AppHost B binds to stable URLs later and a random one would
// make that a lookup instead of a constant. *.localtest.me resolves to loopback without touching
// /etc/hosts, so host-based tenant resolution (3.6) is exercised for real rather than faked with
// a Host header.
// ---------------------------------------------------------------------------------------------
builder.AddContainer("traefik", "traefik", "v3.5")
    .WithBindMount("traefik", "/etc/traefik/dynamic", isReadOnly: true)
    // The services run on the HOST, not in the container network. host-gateway is the docker
    // spelling of "the machine this container is running on".
    .WithContainerRuntimeArgs("--add-host=host.docker.internal:host-gateway")
    .WithArgs(
        traefikEntrypoint,
        // Traefik's OWN entrypoint defaults to :8080 and is not the one traffic arrives on.
        // Leaving it there collides with `web` and the container exits 1 before it serves
        // anything: "error opening listener: listen tcp :8080: bind: address already in use".
        "--entrypoints.traefik.address=:8099",
        "--providers.file.directory=/etc/traefik/dynamic",
        "--providers.file.watch=true",
        "--api.dashboard=false",
        "--accesslog=true",
        "--log.level=INFO")
    .WithEndpoint(port: TraefikPort, targetPort: TraefikPort, scheme: "http", name: "web")
    // The health check goes through the edge to the store, so "traefik is healthy" means the
    // whole path is -- routing, the host gateway and the backend -- not just that a process
    // is listening.
    .WithHttpHealthCheck("/health", endpointName: "web")
    .WaitFor(storePooled)
    .WaitFor(platform)
    .WaitFor(fakeBank);

// ---------------------------------------------------------------------------------------------
// The pooled front ends (BUILD-PLAN 7.2-7.4). Tasks 07a-07c built them and left them out of the
// application model; task 11 needs all three under one `aspire run`, because a browser gate
// against a stack somebody has to assemble by hand is a gate that does not get run.
//
// Each is the SAME package a dedicated instance runs (CC1) -- the storefront and the dashboard
// differ from AppHost B's copies by their environment and nothing else. Both binaries live under
// the APP's own node_modules; pnpm does not hoist, so there is nothing at the repo root.
// ---------------------------------------------------------------------------------------------
IResourceBuilder<ExecutableResource> Web(string name, string appDirectory, int port, params string[] args) =>
    builder.AddExecutable(name, "node", $"{repoRoot}/apps/{appDirectory}", args)
        .WithHttpEndpoint(port: port, targetPort: port, name: "http", env: "PORT", isProxied: false)
        .WithEnvironment("NODE_ENV", "development")
        .WithOtlpExporter();

Web("storefront", "storefront", StorefrontPort, "node_modules/next/dist/bin/next", "dev")
    // No TENANT_SLUG: this process is POOLED, so `/` lists the stores and `/t/:slug` is one of
    // them. That one absent variable is the whole of the mode difference in this app.
    .WithEnvironment("STOREFRONT_TENANT_SLUGS", "acme,borg")
    .WithEnvironment("STORE_API_URL", storePooledBase)
    .WithEnvironment("STOREFRONT_PUBLIC_URL", storefrontBase)
    .WithEnvironment("FAKE_BANK_URL", fakeBankBase)
    .WithEnvironment("FAKE_BANK_HMAC_SECRET", FakeBankHmacSecret)
    // AppHost B runs the same package out of the same directory. Without a distDir of its own,
    // whichever `next dev` starts second writes over the first one's build output.
    .WithEnvironment("NEXT_DIST_DIR", ".next-pooled")
    // A Next health check must name a path that answers 200 -- and this one is 200 only once the
    // store is up and seeded, which is exactly what a WaitFor on this resource should mean.
    .WithHttpHealthCheck("/t/acme")
    .WaitFor(storePooled);

// 0.0.0.0, not 127.0.0.1: Traefik reaches these from inside a container over the docker host
// gateway, and the demo is supposed to be reachable through ONE port (dash.localtest.me:8080,
// console.localtest.me:8080). strictPort in each vite.config.ts is what keeps the number fixed.
Web("dashboard", "dashboard", DashboardPort,
        "node_modules/vite/bin/vite.js", "--host", "0.0.0.0")
    .WithEnvironment("VITE_STORE_API_URL", storePooledBase)
    .WithHttpHealthCheck("/")
    .WaitFor(storePooled);

Web("admin", "admin", AdminPort,
        "node_modules/vite/bin/vite.js", "--host", "0.0.0.0")
    .WithEnvironment("VITE_PLATFORM_URL", platformBase)
    .WithHttpHealthCheck("/")
    .WaitFor(platform);

builder.Build().Run();
