/**
 * Spike (#3196): a throwaway `sql` lexicon, loaded by module path, that
 * registers `table` and `view` as foldable tagged templates. Not the slice-1
 * package: it exists to answer whether the tagged-template form folds into
 * entities with references, dependency order and lineage, byte-identically
 * with running the file.
 */

import type { Declarable, LexiconPlugin, Serializer } from "@intentius/chant";
import { AttrRef } from "@intentius/chant/attrref";
import { table, view, LEXICON, TABLE_TYPE, VIEW_TYPE, type LineageEdge, type SqlEntity } from "./entity";

export { table, view };

function topoOrder(entities: Map<string, Declarable>, names: Map<Declarable, string>): string[] {
  const deps = new Map<string, string[]>();
  for (const [name, e] of entities) {
    const on = ((e as unknown as { dependsOn?: unknown[] }).dependsOn ?? []).map((v) =>
      v instanceof AttrRef ? names.get(v.parent.deref() as Declarable) : names.get(v as Declarable),
    );
    deps.set(name, [...new Set(on.filter((n): n is string => n !== undefined && n !== name))].sort());
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, stack: string[]) => {
    if (seen.has(n)) return;
    if (stack.includes(n)) throw new Error(`reference cycle: ${[...stack, n].join(" -> ")}`);
    for (const d of deps.get(n) ?? []) visit(d, [...stack, n]);
    seen.add(n);
    order.push(n);
  };
  for (const n of [...entities.keys()].sort()) visit(n, []);
  return order;
}

export const sqlSerializer: Serializer = {
  name: LEXICON,
  rulePrefix: "SQL",
  serialize(entities: Map<string, Declarable>): string {
    if (entities.size === 0) return "";
    const names = new Map<Declarable, string>();
    for (const [n, e] of entities) names.set(e, n);
    const refName = (r: AttrRef) => `${names.get(r.parent.deref() as Declarable) ?? "?"}.${r.attribute}`;
    const order = topoOrder(entities, names);
    const objects = order.map((name) => {
      const e = entities.get(name)! as SqlEntity;
      const p = e.props as Record<string, unknown>;
      const deps = ((e as unknown as { dependsOn: unknown[] }).dependsOn ?? []).map((v) =>
        v instanceof AttrRef ? refName(v) : names.get(v as Declarable),
      );
      const base: Record<string, unknown> = {
        export: name,
        type: e.entityType,
        name: p.name,
        ...(p.database ? { database: p.database } : {}),
        engine: p.engine,
        columns: p.columns,
        ...(e.entityType === TABLE_TYPE
          ? { orderBy: p.orderBy, primaryKey: p.primaryKey, partitionBy: p.partitionBy, sampleBy: p.sampleBy, ttl: p.ttl, settings: p.settings, indexes: p.indexes, projections: p.projections, constraints: p.constraints }
          : {}),
        ...(e.entityType === VIEW_TYPE
          ? {
              viewKind: p.viewKind,
              orderBy: p.orderBy,
              to: p.to && typeof p.to === "object" ? names.get(p.to as Declarable) : p.to,
              reads: (p.reads as Declarable[]).map((t) => names.get(t)),
              lineage: (p.lineage as LineageEdge[]).map((l) => ({ output: l.output, expr: l.expr, from: l.from.map(refName) })),
            }
          : {}),
        dependsOn: [...new Set(deps)],
        ddl: p.ddl,
      };
      return JSON.parse(JSON.stringify(base));
    });
    return JSON.stringify({ dialect: "clickhouse", applyOrder: order, objects }, null, 2) + "\n";
  },
};

const notImplemented = async () => {
  throw new Error("sql spike: not implemented");
};

export const sqlSpikePlugin: LexiconPlugin = {
  name: LEXICON,
  serializer: sqlSerializer,
  generate: notImplemented,
  validate: notImplemented,
  coverage: notImplemented,
  package: notImplemented,
  intrinsics() {
    return [
      { name: "table", isTag: true, description: "A ClickHouse CREATE TABLE, parsed into a table entity" },
      { name: "view", isTag: true, description: "A ClickHouse CREATE [MATERIALIZED] VIEW, parsed into a view entity" },
    ];
  },
};
