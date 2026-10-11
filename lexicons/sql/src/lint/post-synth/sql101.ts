import type { PostSynthCheck, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { clickhouseObjects, postgresObjects, type OutputObject } from "./sql-helpers";

/**
 * Kinds whose name is not the object's identity on the server, so two
 * exports may share it: grants; Postgres functions and procedures, which
 * overload; triggers and policies, named per table; ClickHouse row policies,
 * also per table.
 */
const NOT_UNIQUE = new Set([
  "ClickHouse::Grant",
  "ClickHouse::RowPolicy",
  "Postgres::Grant",
  "Postgres::DefaultPrivileges",
  "Postgres::Function",
  "Postgres::Procedure",
  "Postgres::Trigger",
  "Postgres::Policy",
]);

const kindOf = (type: string): string =>
  type
    .replace(/^(ClickHouse|Postgres)::/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

/**
 * SQL101: two exports declare the same object, the same kind under the same
 * qualified name (`shop.events` twice). The build writes both `CREATE`
 * statements, and the second fails on the server, or replaces the first
 * under `OR REPLACE`.
 */
export const sql101: PostSynthCheck = {
  id: "SQL101",
  description: "Two exports declare the same object",
  check(ctx) {
    const out: PostSynthDiagnostic[] = [];
    const scan = (dialect: string, objects: readonly OutputObject[]) => {
      const first = new Map<string, OutputObject>();
      for (const o of objects) {
        const name = typeof o.sqlName === "string" && o.sqlName !== "" ? o.sqlName : undefined;
        if (!name || NOT_UNIQUE.has(o.type)) continue;
        const key = `${o.type}\u0000${name}`;
        const prior = first.get(key);
        if (!prior) {
          first.set(key, o);
          continue;
        }
        out.push({
          checkId: "SQL101",
          severity: "error",
          message: `${prior.export} and ${o.export} both declare ${dialect} ${kindOf(o.type)} ${name}; the build would create it twice`,
          entity: o.export,
          lexicon: "sql",
        });
      }
    };
    scan("ClickHouse", clickhouseObjects(ctx));
    scan("Postgres", postgresObjects(ctx));
    return out;
  },
};
