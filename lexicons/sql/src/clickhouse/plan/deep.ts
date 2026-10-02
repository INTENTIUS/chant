/**
 * `observeResourcesDeep()` for the ClickHouse dialect: each declared object's
 * live definition as a property tree in the declaration's own shape, so
 * `chant lifecycle diff --live` and `plan` report property drift with no false
 * drift.
 *
 * The reader parses the server's `SHOW CREATE` with the same tag the
 * declaration used, which gives the same props shape. A field whose canonical
 * form (`./normalize.ts`) equals the declaration's is written with the
 * declaration's own value, so `INTERVAL 180 DAY` and `toIntervalDay(180)` do
 * not read as drift; a field that differs keeps the server's value.
 * `deepNormalizationHooks` prunes what is not a property of the object (the
 * DDL text, the template source, lineage, a view's reads and `TO` target).
 * `chant sql plan` covers the target, and classifies every change.
 */

import { deepObservation, type DeepObservationResult, type DeepResourceObservation, type DeepNormalizationHooks } from "@intentius/chant/deep-observation";
import type { UnobservedEntity } from "@intentius/chant/lexicon";
import { bindClickHouse, classifyClickHouseFailure, type BindOptions } from "../live/bind";
import { readLiveSchema, type LiveObject } from "../live/catalog";
import { database, table, view, CLICKHOUSE_ENTITY_TYPES, type ColumnDef } from "../entities";
import { canonicalObject, type CanonicalColumn, type CanonicalObject } from "./normalize";

type Props = Record<string, unknown>;

const PRUNED = new Set(["ddl", "source", "lineage", "reads", "to", "orReplace", "ifNotExists"]);

export const sqlDeepNormalizationHooks: DeepNormalizationHooks = {
  prune: (node) => PRUNED.has(node.pattern.split(/[.[]/)[0]!),
};

function liveProps(o: LiveObject): Props {
  const tag = o.type === CLICKHOUSE_ENTITY_TYPES.database ? database : o.type === CLICKHOUSE_ENTITY_TYPES.table ? table : view;
  const strings = Object.assign([o.statement], { raw: [o.statement] }) as unknown as TemplateStringsArray;
  return { ...(tag(strings).props as unknown as Props) };
}

const sameColumn = (a: CanonicalColumn, b: CanonicalColumn) => {
  const strip = ({ text: _t, position: _p, previously: _v, ...rest }: CanonicalColumn) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/** The live props, with each field the declaration means the same as written the declaration's way. */
export function inDeclaredVocabulary(declared: Props, live: Props, d: CanonicalObject, l: CanonicalObject): Props {
  const out: Props = { ...live };
  const same = (k: keyof CanonicalObject) => JSON.stringify(d[k]) === JSON.stringify(l[k]);
  const adopt = (key: string, equal: boolean) => {
    if (!equal) return;
    if (declared[key] === undefined) delete out[key];
    else out[key] = declared[key];
  };
  adopt("name", d.name === l.name);
  adopt("database", d.database === l.database);
  adopt("engine", same("engine"));
  for (const k of ["orderBy", "primaryKey", "partitionBy", "sampleBy", "ttl", "comment", "select", "refresh"] as const) adopt(k, same(k));
  adopt("settings", same("settings"));
  adopt("indexes", same("indexes"));
  adopt("projections", same("projections"));
  adopt("constraints", same("constraints"));

  const declaredColumns = (declared.columns as ColumnDef[] | undefined) ?? [];
  if (d.kind === "view" || d.kind === "materializedView") {
    // The server infers a view's columns; a declaration that lists none is not drift.
    if (declaredColumns.length === 0) out.columns = [];
  } else if (d.kind === "table") {
    const liveColumns = (live.columns as ColumnDef[] | undefined) ?? [];
    out.columns = liveColumns.map((c, i) => {
      const lc = l.columns[i];
      const dc = d.columns.find((x) => x.name === c.name);
      const di = dc ? declaredColumns[dc.position] : undefined;
      return lc && dc && di && sameColumn(lc, dc) ? di : c;
    });
  }
  return out;
}

export async function observeResourcesDeep(
  options: {
    environment: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  } & Omit<BindOptions, "environment">,
): Promise<DeepObservationResult> {
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  let target;
  let live: LiveObject[];
  try {
    target = await bindClickHouse(options);
    live = await readLiveSchema(target);
  } catch (err) {
    const why = classifyClickHouseFailure(err);
    for (const name of options.entityNames) {
      unobserved[name] = { type: options.entities.get(name)?.entityType ?? "", reason: why.reason, detail: why.detail };
    }
    return deepObservation({}, unobserved);
  }
  const byKey = new Map(live.map((o) => [`${o.database ?? ""}.${o.name}`, o]));
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    if (!entity || !entity.entityType.startsWith("ClickHouse::")) {
      unobserved[name] = { type: entity?.entityType ?? "", reason: "unsupported-kind" };
      continue;
    }
    const props = entity.props;
    const isDb = entity.entityType === CLICKHOUSE_ENTITY_TYPES.database;
    const db = isDb ? undefined : typeof props.database === "string" ? props.database : target.defaultDatabase;
    const o = byKey.get(`${db ?? ""}.${String(props.name)}`);
    if (!o) continue;
    try {
      const d = canonicalObject(String(props.ddl), target.defaultDatabase);
      const l = canonicalObject(o.statement, target.defaultDatabase);
      resources[name] = {
        type: o.type,
        physicalId: o.uuid ?? `${db ? `${db}.` : ""}${o.name}`,
        properties: inDeclaredVocabulary(props, liveProps(o), d, l),
      };
    } catch (err) {
      unobserved[name] = { type: entity.entityType, reason: "read-failed", detail: `the server's definition does not parse: ${(err as Error).message}` };
    }
  }
  return deepObservation(resources, unobserved);
}
