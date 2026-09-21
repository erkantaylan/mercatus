-- Table privileges for the control plane, applied after the migrations, as the owner.
-- DML only: the runtime role creates nothing and owns nothing.
grant select, insert, update, delete on table users, tenants, memberships, licences, installations, payments
  to mercatus_platform_app;
