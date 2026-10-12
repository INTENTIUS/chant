import { SoftDeleteTable, schema, type PostgresTable, type RowOf } from "@intentius/chant-lexicon-sql/postgres";
import { audit, documents, teamSizes, teams, users } from "../src/accounts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>(): T | undefined => undefined;

ok<Equal<RowOf<typeof users.table>, { id: string; email: string; created_at: Date; updated_at: Date; deleted_at: Date | null }>>();
ok<Equal<RowOf<typeof users.live>, RowOf<"app.users_live">>>();
ok<Equal<RowOf<typeof teams.table>, RowOf<"app.teams">>>();
ok<Equal<RowOf<typeof teams.live>, RowOf<"app.teams_live">>>();
ok<Equal<RowOf<typeof documents.table>, { tenant_id: string; id: string; body: string }>>();
ok<Equal<RowOf<typeof audit.table>, RowOf<"public.audit_log">>>();
ok<Equal<RowOf<typeof audit.defaultPartition>, RowOf<"public.audit_log_default">>>();
ok<Equal<RowOf<typeof teamSizes.view>, RowOf<"app.team_sizes">>>();

// A typed member is still a table.
const takesTable = (t: PostgresTable) => t.sqlName;
takesTable(users.table);

// A name or a schema the type system cannot read keeps unchecked columns: any name type-checks.
declare const someName: string;
const loose = SoftDeleteTable({ name: someName, columns: "id bigint PRIMARY KEY" });
export const anyColumn = loose.table.columns.anything;
const unnamedSchema = schema`CREATE SCHEMA other`;
const elsewhere = SoftDeleteTable({ name: "things", schema: unnamedSchema, columns: "id bigint PRIMARY KEY" });
export const alsoAny = elsewhere.live.columns.anything;
