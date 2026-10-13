import { AuditLogTable, TenantTable } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";

// tenant_id comes first in the primary key and in the one index.
export const documents = TenantTable({
  name: "documents",
  schema: app,
  columns: "id bigint GENERATED ALWAYS AS IDENTITY, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()",
  primaryKey: "id",
  indexOn: "created_at DESC",
});

// Partitioned by month on occurred_at, with a default partition.
export const audit = AuditLogTable({ name: "audit_log", schema: app });
