/**
 * A fake Postgres client for unit tests: answers the catalog reader's queries
 * (`../live/catalog.ts`) from rows the test gives, by which catalog each query
 * reads. Anything else answers no rows.
 */

import type { PostgresClient } from "../live/client";

export interface FakeCatalog {
  schemas?: Array<{ name: string; comment?: string }>;
  tables?: Array<{ schema: string; name: string; comment?: string; columns?: Array<{ name: string; type: string; notnull?: boolean; dflt?: string }> }>;
  views?: Array<{ schema: string; name: string; def: string; materialized?: boolean; comment?: string }>;
  indexes?: Array<{ schema: string; name: string; table: string; def: string }>;
}

export function fakeClient(catalog: FakeCatalog, log: string[] = []): PostgresClient {
  let oid = 16384;
  const tables = (catalog.tables ?? []).map((t) => ({ ...t, oid: String(oid++) }));
  return {
    async query<T>(sql: string): Promise<T[]> {
      log.push(sql);
      const rows = (r: unknown[]) => r as T[];
      if (sql.includes("FROM pg_catalog.pg_namespace n WHERE")) return rows((catalog.schemas ?? []).map((s, i) => ({ oid: String(100 + i), name: s.name, comment: s.comment ?? null })));
      if (sql.includes("c.relkind IN ('r', 'p')")) {
        return rows(tables.map((t) => ({ oid: t.oid, schema: t.schema, name: t.name, kind: "r", persistence: "p", ispartition: false, typed: false, partkey: null, bound: null, parents: [], reloptions: null, am: "heap", tablespace: null, comment: t.comment ?? null })));
      }
      if (sql.includes("FROM pg_catalog.pg_attribute a JOIN")) {
        return rows(
          tables.flatMap((t) =>
            (t.columns ?? []).map((c, i) => ({ rel: t.oid, num: i + 1, name: c.name, type: c.type, notnull: c.notnull ?? false, identity: "", generated: "", islocal: true, dflt: c.dflt ?? null, collation: null, comment: null, compression: "", storage: "x", typstorage: "x" })),
          ),
        );
      }
      if (sql.includes("c.relkind IN ('v', 'm')")) {
        return rows((catalog.views ?? []).map((v) => ({ oid: String(oid++), schema: v.schema, name: v.name, kind: v.materialized ? "m" : "v", def: v.def, reloptions: null, populated: true, am: null, tablespace: null, comment: v.comment ?? null, column_comments: [] })));
      }
      if (sql.includes("FROM pg_catalog.pg_index i")) return rows((catalog.indexes ?? []).map((x) => ({ oid: String(oid++), schema: x.schema, name: x.name, table_name: x.table, def: x.def, comment: null })));
      return [];
    },
    async end() {},
  };
}
