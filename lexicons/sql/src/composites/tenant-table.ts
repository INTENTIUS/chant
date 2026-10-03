/**
 * `TenantTable`: a multi-tenant table whose tenant key leads every key and index.
 *
 * The composite adds the tenant column (`NOT NULL`) in front of the columns it
 * is given, makes the primary key `(<tenant>, <primaryKey>)` and creates one
 * index on `(<tenant>, <indexOn>)`. With the tenant first in each, a query
 * scoped to one tenant reads one contiguous range of every index, and no index
 * serves a cross-tenant scan by accident. Row-level security is separate: a
 * policy on the table is what keeps one tenant's role out of another's rows.
 */

import { Composite } from "@intentius/chant/composite";
import { index, table, type PostgresIndex, type PostgresSchema, type PostgresTable } from "../postgres/entities";

export interface TenantTableProps {
  /** The table's name, unqualified. The index is `<name>_tenant_idx`. */
  name: string;
  /** The schema the table lives in: the entity, or its name (default `public`). */
  schema?: PostgresSchema | string;
  /** Every column except the tenant's, as SQL: `id bigint GENERATED ALWAYS AS IDENTITY, title text NOT NULL`. */
  columns: string;
  /** The columns that, after the tenant, make a row unique: `id`. */
  primaryKey: string;
  /** The columns the secondary index covers after the tenant: `created_at DESC`. */
  indexOn: string;
  /** The tenant column (default `tenant_id`). */
  tenant?: string;
  /** The tenant column's type (default `uuid`). */
  tenantType?: string;
}

export type TenantTableMembers = {
  table: PostgresTable;
  index: PostgresIndex;
};

/** A multi-tenant table with the tenant key first in its primary key and its index. */
export const TenantTable = Composite<TenantTableProps, TenantTableMembers>((props) => {
  const schema = props.schema ?? "public";
  const tenant = props.tenant ?? "tenant_id";
  const rows = table`
    CREATE TABLE ${schema}.${props.name} (
      ${tenant} ${props.tenantType ?? "uuid"} NOT NULL,
      ${props.columns},
      PRIMARY KEY (${tenant}, ${props.primaryKey})
    )`;
  const byTenant = index`
    CREATE INDEX ${`${props.name}_tenant_idx`} ON ${rows} (${tenant}, ${props.indexOn})`;
  return { table: rows, index: byTenant };
}, "TenantTable");
