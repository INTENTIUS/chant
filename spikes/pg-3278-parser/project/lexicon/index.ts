/**
 * Spike (#3278): a throwaway `sql` lexicon for the Postgres dialect, loaded by
 * module path (#2520), registering the Postgres tags as foldable tagged
 * templates. It answers whether the tags fold into entities with references,
 * dependency order and column lineage, byte-identically with running the file,
 * using #3221's core fold support. Not the slice-1 package.
 */

import type { Declarable, LexiconPlugin, Serializer } from "@intentius/chant";
import { isAttrRefLike } from "@intentius/chant/utils";
import { isPostgresObject, type PostgresObject } from "./postgres/entities";
import type { LineageEdge } from "./core/template";

export { schema, table, index, view, sequence, type, domain, extension, literal } from "./postgres/entities";

function refName(value: unknown, names: Map<Declarable, string>): string | undefined {
  if (isAttrRefLike(value)) {
    const owner = names.get(value.parent.deref() as Declarable);
    return owner ? `${owner}.${value.attribute}` : undefined;
  }
  return names.get(value as Declarable);
}

export function applyOrder(objects: Map<string, PostgresObject>, names: Map<Declarable, string>): string[] {
  const deps = new Map<string, string[]>();
  for (const [name, obj] of objects) {
    const on = new Set<string>();
    for (const ref of obj.dependsOn) {
      const parent = isAttrRefLike(ref) ? (ref.parent.deref() as Declarable | undefined) : (ref as Declarable);
      const dep = parent ? names.get(parent) : undefined;
      if (dep !== undefined && dep !== name && objects.has(dep)) on.add(dep);
    }
    deps.set(name, [...on].sort());
  }
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (n: string, stack: string[]) => {
    if (done.has(n)) return;
    if (stack.includes(n)) throw new Error(`sql: a reference cycle between schema objects: ${[...stack, n].join(" -> ")}`);
    for (const d of deps.get(n) ?? []) visit(d, [...stack, n]);
    done.add(n);
    order.push(n);
  };
  for (const n of [...objects.keys()].sort()) visit(n, []);
  return order;
}

/** A props value with entity and column references written as export names. */
function jsonValue(v: unknown, names: Map<Declarable, string>): unknown {
  if (isPostgresObject(v) || isAttrRefLike(v)) return refName(v, names) ?? null;
  if (Array.isArray(v)) return v.map((x) => jsonValue(x, names));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonValue(x, names)]));
  return v;
}

export const sqlSerializer: Serializer = {
  name: "sql",
  rulePrefix: "SQL",
  serialize(entities: Map<string, Declarable>) {
    const objects = new Map<string, PostgresObject>();
    for (const [n, e] of entities) if (isPostgresObject(e)) objects.set(n, e);
    if (objects.size === 0) return "";
    const names = new Map<Declarable, string>();
    for (const [n, e] of objects) names.set(e, n);
    const order = applyOrder(objects, names);
    const out = order.map((name) => {
      const e = objects.get(name)!;
      const props = { ...(e.props as Record<string, unknown>) };
      delete props.source;
      const ddl = props.ddl;
      delete props.ddl;
      if (props.lineage) {
        props.lineage = (props.lineage as LineageEdge[]).map((l) => ({ output: l.output, expr: l.expr, from: l.from.map((r) => refName(r, names) ?? null) }));
      }
      const dependsOn = [...new Set(e.dependsOn.map((r) => refName(r, names)).filter((x) => x !== undefined))];
      return { export: name, type: e.entityType, sqlName: e.sqlName, ...(jsonValue(props, names) as object), dependsOn, ddl };
    });
    const doc = JSON.stringify({ dialect: "postgres", applyOrder: order, objects: out }, null, 2) + "\n";
    const sql = order.map((n) => `${(objects.get(n)!.props as { ddl: string }).ddl};\n`).join("\n");
    return { primary: doc, files: { "postgres.sql": sql } };
  },
};

const notImplemented = async () => {
  throw new Error("sql spike: not implemented");
};

const TAGS: Array<[string, string]> = [
  ["schema", "CREATE SCHEMA"],
  ["table", "CREATE TABLE"],
  ["index", "CREATE INDEX"],
  ["view", "CREATE VIEW or CREATE MATERIALIZED VIEW"],
  ["sequence", "CREATE SEQUENCE"],
  ["type", "CREATE TYPE ... AS ENUM"],
  ["domain", "CREATE DOMAIN"],
  ["extension", "CREATE EXTENSION"],
];

export const sqlSpikePlugin: LexiconPlugin = {
  name: "sql",
  serializer: sqlSerializer,
  generate: notImplemented,
  validate: notImplemented,
  coverage: notImplemented,
  package: notImplemented,
  intrinsics() {
    return [
      ...TAGS.map(([name, what]) => ({ name, isTag: true, description: `A Postgres ${what}, parsed into an entity` })),
      { name: "literal", isTag: false, foldsAsCall: true, description: "A quoted Postgres string literal" },
    ];
  },
};

export default sqlSpikePlugin;
