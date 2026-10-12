import { AuditLogTable, JoinTable, RefreshedView, SoftDeleteTable, TenantTable } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";

export const users = SoftDeleteTable({
  name: "users",
  schema: app,
  columns: "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL",
  liveKey: "email",
});

// A schema by name, and a name Postgres folds: the members are app.teams and app.teams_live.
export const teams = SoftDeleteTable({
  name: "Teams",
  schema: "app",
  columns: "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL",
});

export const documents = TenantTable({
  name: "documents",
  schema: app,
  columns: "id bigint GENERATED ALWAYS AS IDENTITY, body text NOT NULL",
  primaryKey: "id",
  indexOn: "id",
});

// No schema: public.
export const audit = AuditLogTable({ name: "audit_log" });

export const memberships = JoinTable({
  name: "memberships",
  schema: app,
  left: users.table,
  leftColumn: "user_id",
  right: teams.table,
  rightColumn: "team_id",
});

export const teamSizes = RefreshedView({
  name: "team_sizes",
  schema: app,
  source: memberships.table,
  select: "team_id, count(*) AS members",
  groupBy: "team_id",
});
