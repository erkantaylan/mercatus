-- Roles for the data plane (BUILD-PLAN §3.4, BE2). Applied before migrations, by a connection
-- that can create roles -- DATABASE_SUPERUSER_URL, which is whatever Aspire hands out.
--
--   mercatus_owner  owns the schema. drizzle-kit migrate, sql/02-rls.sql and the seed run as it.
--   mercatus_app    the runtime role. LOGIN, NOBYPASSRLS, and granted nothing but DML.
--
-- BE2 is the whole reason this file exists: a role with BYPASSRLS makes every policy in
-- sql/02-rls.sql decoration, and a SUPERUSER bypasses RLS even where FORCE is set. The
-- attributes are re-asserted on every run because a role created by hand earlier, with different
-- attributes, is exactly the accident this guards against.
--
-- Passwords are local-development literals. This database only ever exists on a laptop or inside
-- an Aspire run; nothing here is a credential anywhere else.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mercatus_owner') then
    create role mercatus_owner login password 'mercatus_owner_dev';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'mercatus_app') then
    create role mercatus_app login password 'mercatus_app_dev';
  end if;
end
$$;

alter role mercatus_owner with login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
alter role mercatus_app   with login nosuperuser nobypassrls nocreatedb nocreaterole noreplication;

do $$
begin
  execute format('alter database %I owner to mercatus_owner', current_database());
  -- OPEN-DEFECTS F3: the connect boundary was one-directional. db-platform/sql/00-roles.sql has
  -- always revoked CONNECT from public, so the data plane's mercatus_app cannot open the control
  -- plane's database; this file did not, so mercatus_platform_app -- and any role later added to
  -- the cluster -- had a free foothold in the data plane. Table grants denied it today; a
  -- boundary that depends on nobody ever adding a role is not a boundary.
  execute format('revoke connect on database %I from public', current_database());
  execute format('grant connect on database %I to mercatus_owner, mercatus_app', current_database());
end
$$;

alter schema public owner to mercatus_owner;
grant usage on schema public to mercatus_app;

-- PG15+ already removes this, but an upgraded cluster may not have. mercatus_app creates nothing.
revoke create on schema public from public;
revoke create on schema public from mercatus_app;
