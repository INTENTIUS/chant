/**
 * A {@link Mirror} as text: ClickHouse DDL, the TypeScript declarations that
 * write it, or the statements a server runs (#4399).
 *
 * With `composite`, a mirror is a `CdcMirror` call (`../../composites/cdc-mirror.ts`)
 * that adds the version and deleted columns and the view of live rows
 * itself. Without it, a mirror is a `table` declaration with the engine and
 * the two columns written out, and no view.
 */

import { CdcMirror } from "../../composites/cdc-mirror";
import { CLICKHOUSE_ENTITY_TYPES } from "../../clickhouse/entities";
import type { ImportedObject } from "../../clickhouse/import/ir";
import { engineReview } from "../../clickhouse/review-catalog";
import { MIRROR_COLUMNS, type Mirror } from "./translate";

const ident = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``);
const chString = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `id Int64`, `email String COMMENT '...'`. */
export const columnSql = (c: Mirror["columns"][number]): string => `${ident(c.name)} ${c.type}${c.comment ? ` COMMENT ${chString(oneLine(c.comment))}` : ""}`;

/** The sort key as `CdcMirror`'s `primaryKey` and `ORDER BY` write it. */
export const orderBySql = (m: Mirror): string => (m.primaryKey.length === 0 ? "tuple()" : m.primaryKey.length === 1 ? ident(m.primaryKey[0]!) : `(${m.primaryKey.map(ident).join(", ")})`);

/** The `columns` string of a `CdcMirror` call. */
export const mirrorColumns = (m: Mirror): string => m.columns.map(columnSql).join(", ");

/** The table as a bare `CREATE TABLE`, constraint comments first. */
export function tableSql(m: Mirror): string {
  const engine = engineReview({ object: m.name, mode: "cdc", cdcColumns: { version: MIRROR_COLUMNS.version, deleted: MIRROR_COLUMNS.deleted } });
  const settings = Object.entries(m.settings).map(([k, v]) => `${k} = ${v}`);
  return [
    ...m.constraintComments,
    `CREATE TABLE ${ident(m.name)}`,
    "(",
    [...m.columns.map(columnSql), ...engine.extraColumns.map((c) => `${c.name} ${c.type}`)].map((l) => `    ${l}`).join(",\n"),
    ")",
    `ENGINE = ${engine.engine}`,
    `ORDER BY ${orderBySql(m)}`,
    ...(settings.length > 0 ? [`SETTINGS ${settings.join(", ")}`] : []),
    ...(m.comment ? [`COMMENT ${chString(oneLine(m.comment))}`] : []),
  ].join("\n");
}

/** The call's props, for `CdcMirror` and for the TypeScript that writes it. */
function callProps(m: Mirror) {
  return { name: m.name, columns: mirrorColumns(m), primaryKey: orderBySql(m) };
}

/** The statements a server runs for the mirrors, in creation order. */
export function mirrorObjects(mirrors: readonly Mirror[], composite: boolean): ImportedObject[] {
  const out: ImportedObject[] = [];
  for (const m of mirrors) {
    if (!composite) {
      out.push({ type: CLICKHOUSE_ENTITY_TYPES.table, name: m.name, ddl: tableSql(m) });
      continue;
    }
    // The composite writes the DDL: what is validated is what `chant build` makes of the call.
    const { table, current } = CdcMirror(callProps(m));
    out.push({ type: CLICKHOUSE_ENTITY_TYPES.table, name: m.name, ddl: (table.props as { ddl: string }).ddl });
    out.push({ type: CLICKHOUSE_ENTITY_TYPES.view, name: `${m.name}_current`, ddl: (current.props as { ddl: string }).ddl });
  }
  return out;
}

/** `--emit sql`: the statements, each ended with a semicolon. */
export function emitSql(mirrors: readonly Mirror[], composite: boolean): string {
  const objects = mirrorObjects(mirrors, composite);
  // A constraint comment sits in the table's own text, so a statement is the object's ddl as it is.
  const comments = composite ? new Map(mirrors.map((m) => [m.name, m.constraintComments])) : new Map<string, string[]>();
  return `${objects.map((o) => `${(comments.get(o.name) ?? []).map((c) => `${c}\n`).join("")}${o.ddl.replace(/\s+$/, "")};`).join("\n\n")}\n`;
}

const str = (s: string): string => JSON.stringify(s);
const templateSafe = (s: string): string => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/** `--emit ts`: the declarations, as a file of `CdcMirror` calls or of `table` templates. */
export function emitTs(mirrors: readonly Mirror[], composite: boolean): string {
  const lines: string[] = [];
  if (composite) {
    lines.push(`import { CdcMirror } from "@intentius/chant-lexicon-sql/clickhouse";`, "");
    for (const m of mirrors) {
      for (const c of m.constraintComments) lines.push(`//${c.slice(2)}`);
      const p = callProps(m);
      lines.push(`export const ${m.export} = CdcMirror({`, `  name: ${str(p.name)},`, `  columns: ${str(p.columns)},`, `  primaryKey: ${str(p.primaryKey)},`, `});`, "");
    }
  } else {
    lines.push(`import { table } from "@intentius/chant-lexicon-sql/clickhouse";`, "");
    for (const m of mirrors) {
      lines.push(`export const ${m.export} = table\``, ...tableSql(m).split("\n").map((l) => `  ${templateSafe(l)}`), "`;", "");
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}
