-- Row level security for the data plane (BUILD-PLAN §3.3, BE1). Applied after the drizzle
-- migrations, as mercatus_owner.
--
-- Hand-authored rather than generated: policies and grants belong to the same statement list, and
-- J1 says never hand-edit a generated migration. Keeping them here keeps migrations/ generated
-- and this file owned.
--
-- The nullif is not decoration. Verified on postgres:18.3: after a transaction that set
-- app.tenant_id, the setting reverts to the EMPTY STRING rather than NULL for the rest of that
-- session. Without nullif, a pooled connection that served one tenant-scoped request and is then
-- reused outside tenant context raises `invalid input syntax for type uuid: ""` -- and only on
-- connections that happened to serve one before, so it is intermittent. With nullif, no context
-- always means zero rows. Fail closed, quietly, every time.
--
-- FORCE matters as much as ENABLE: without it the table owner is exempt from its own policies,
-- and the seed and the migration step both connect as the owner.

-- tenants deliberately has NO policy. It is the lookup that establishes tenant context, so a
-- policy on it would require the context it is being read to produce.
--
-- OPEN-DEFECTS F2: it used to be `grant select on table tenants to mercatus_app`, which in a
-- POOLED deployment means any code path holding a store connection can enumerate every merchant
-- on the box -- names, branding, the lot -- with no tenant context at all. The table grant is
-- gone; three SECURITY DEFINER functions are the only way in, and each one returns exactly what
-- its caller needs:
--
--   mercatus_tenant_by_slug(text)  one row, the request's tenant candidate (§3.6)
--   mercatus_tenant_by_id(uuid)    one row, the tenant already established by the token
--   mercatus_tenant_directory()    id and slug ONLY -- the pooled licence agent's poll list,
--                                  which cannot be derived from an RLS-protected table because
--                                  it is the thing that names the contexts
--
-- SECURITY DEFINER runs as the owner, which does hold SELECT. `set search_path` is not optional
-- on a definer function: without it the caller chooses which `tenants` the body reads.
revoke all on table tenants from mercatus_app;

create or replace function mercatus_tenant_by_slug(p_slug text)
returns table (id uuid, slug text, name text, branding jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select t.id, t.slug, t.name, t.branding, t.updated_at from tenants t where t.slug = p_slug;
$fn$;

create or replace function mercatus_tenant_by_id(p_id uuid)
returns table (id uuid, slug text, name text, branding jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select t.id, t.slug, t.name, t.branding, t.updated_at from tenants t where t.id = p_id;
$fn$;

create or replace function mercatus_tenant_directory()
returns table (id uuid, slug text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select t.id, t.slug from tenants t order by t.slug;
$fn$;

-- EXECUTE is granted to PUBLIC by default; a definer function left that way is the leak.
revoke all on function mercatus_tenant_by_slug(text) from public;
revoke all on function mercatus_tenant_by_id(uuid) from public;
revoke all on function mercatus_tenant_directory() from public;
grant execute on function mercatus_tenant_by_slug(text) to mercatus_app;
grant execute on function mercatus_tenant_by_id(uuid) to mercatus_app;
grant execute on function mercatus_tenant_directory() to mercatus_app;

-- licence_state
alter table licence_state enable row level security;
alter table licence_state force row level security;
drop policy if exists licence_state_tenant_isolation on licence_state;
create policy licence_state_tenant_isolation on licence_state
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on table licence_state to mercatus_app;

-- products
alter table products enable row level security;
alter table products force row level security;
drop policy if exists products_tenant_isolation on products;
create policy products_tenant_isolation on products
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on table products to mercatus_app;

-- shoppers
alter table shoppers enable row level security;
alter table shoppers force row level security;
drop policy if exists shoppers_tenant_isolation on shoppers;
create policy shoppers_tenant_isolation on shoppers
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on table shoppers to mercatus_app;

-- orders
alter table orders enable row level security;
alter table orders force row level security;
drop policy if exists orders_tenant_isolation on orders;
create policy orders_tenant_isolation on orders
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on table orders to mercatus_app;

-- order_lines. Carries tenant_id and its own policy: a policy on the parent is not a policy on
-- the child (BE4).
alter table order_lines enable row level security;
alter table order_lines force row level security;
drop policy if exists order_lines_tenant_isolation on order_lines;
create policy order_lines_tenant_isolation on order_lines
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on table order_lines to mercatus_app;

-- order_counters. The row taken `for update` inside the order transaction (BG2) is found by RLS,
-- not by a where clause, so the policy is what makes the numbering per-tenant.
alter table order_counters enable row level security;
alter table order_counters force row level security;
drop policy if exists order_counters_tenant_isolation on order_counters;
create policy order_counters_tenant_isolation on order_counters
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on table order_counters to mercatus_app;

-- The app creates nothing and owns nothing. No sequences exist: every id is a uuid.
revoke all on schema public from mercatus_app;
grant usage on schema public to mercatus_app;
