-- Roles for the control plane. Applied before migrations by DATABASE_SUPERUSER_URL.
--
--   mercatus_platform_owner  owns the schema. Migrations, grants and seed run as it.
--   mercatus_platform_app    the platform API at runtime. LOGIN, NOBYPASSRLS, DML only.
--
-- There is no RLS in this database -- it has one tenant, which is us -- so these roles are about
-- privilege hygiene rather than isolation. What IS about isolation is the last statement: the
-- data plane's mercatus_app is not granted CONNECT here, so a store process holding DATABASE_URL
-- cannot open the control plane's database even though both live in one cluster. The
-- control-plane / data-plane boundary is meant to be a property of the topology (CO3), and this
-- is the database half of it.
--
-- Passwords are local-development literals; this cluster only ever exists on a laptop.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mercatus_platform_owner') then
    create role mercatus_platform_owner login password 'mercatus_platform_owner_dev';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'mercatus_platform_app') then
    create role mercatus_platform_app login password 'mercatus_platform_app_dev';
  end if;
end
$$;

alter role mercatus_platform_owner with login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
alter role mercatus_platform_app   with login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;

do $$
begin
  execute format('alter database %I owner to mercatus_platform_owner', current_database());
  execute format('revoke connect on database %I from public', current_database());
  execute format('grant connect on database %I to mercatus_platform_owner, mercatus_platform_app', current_database());
end
$$;

alter schema public owner to mercatus_platform_owner;
grant usage on schema public to mercatus_platform_app;
revoke create on schema public from public;
