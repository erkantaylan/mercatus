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

const int PlatformPort = 4001;
const int StorePooledPort = 4002;
const int FakeBankPort = 4004;
const int TraefikPort = 8080;

var repoRoot = "../..";

// Pre-built strings. An interpolated literal handed to WithEnvironment binds to the
// ReferenceExpression overload, and an int is not an IValueProvider.
var platformBase = $"http://127.0.0.1:{PlatformPort}";
var fakeBankBase = $"http://127.0.0.1:{FakeBankPort}";
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
    .WithEnvironment("AUTH_ADAPTER", "stub")
    .WithEnvironment("AUTH_STUB_SECRET", AuthStubSecret)
    .WithEnvironment("BASE_HOST", "localtest.me")
    .WithEnvironment("PLATFORM_URL", platformBase)
    .WithReference(dbStore)
    .WaitFor(dbStore)
    .WaitForCompletion(migrateStore);

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

builder.Build().Run();
