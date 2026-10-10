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
 *
 * On a `cluster:<name>` topology every replica of every shard is read
 * (#3664). When a server's copy of a table differs from the profile
 * server's, that copy is what is reported, with the server in `observedOn`,
 * which the drift report prints as `seen on`.
 */

import { deepObservation, type DeepObservationResult, type DeepResourceObservation, type DeepNormalizationHooks } from "@intentius/chant/deep-observation";
import type { UnobservedEntity } from "@intentius/chant/lexicon";
import { bindClickHouse, classifyClickHouseFailure, type BindOptions, type ClickHouseTarget } from "../live/bind";
import { ACCESS_ENTITY_TYPES, ACCESS_UNMANAGED_DETAIL, accessOf, readLiveAccess, readLiveSchema, SYSTEM_DATABASES, type LiveObject } from "../live/catalog";
import { clickhouseQuery } from "../http";
import { sqlString } from "../apply/statements";
import { stripMarkerFromStatement } from "../ownership";
import { database, dictionary, func, policy, role, table, user, view, CLICKHOUSE_ENTITY_TYPES, type ColumnDef } from "../entities";
import { canonicalObject, objectKey, type CanonicalColumn, type CanonicalObject } from "./normalize";
import { renderFor } from "../topology";

type Props = Record<string, unknown>;

// `concurrently` is how a Postgres index is created, not a property of it.
const PRUNED = new Set(["ddl", "source", "lineage", "reads", "to", "orReplace", "ifNotExists", "concurrently"]);

export const sqlDeepNormalizationHooks: DeepNormalizationHooks = {
  prune: (node) => PRUNED.has(node.pattern.split(/[.[]/)[0]!),
};

function liveProps(o: LiveObject): Props {
  const tag =
    o.type === CLICKHOUSE_ENTITY_TYPES.database
      ? database
      : o.type === CLICKHOUSE_ENTITY_TYPES.table
        ? table
        : o.type === CLICKHOUSE_ENTITY_TYPES.dictionary
          ? dictionary
          : o.type === CLICKHOUSE_ENTITY_TYPES.function
            ? func
            : o.type === CLICKHOUSE_ENTITY_TYPES.user
              ? user
              : o.type === CLICKHOUSE_ENTITY_TYPES.role
                ? role
                : o.type === CLICKHOUSE_ENTITY_TYPES.rowPolicy
                  ? policy
                  : view;
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
  for (const k of ["orderBy", "primaryKey", "partitionBy", "sampleBy", "ttl", "comment", "select", "refresh", "dataSource", "layout", "lifetime", "range"] as const) adopt(k, same(k));
  adopt("settings", same("settings"));
  // A user's, role's or row policy's fields, compared as `../access.ts` reads them.
  if (d.kind === "user" || d.kind === "role" || d.kind === "rowPolicy") {
    for (const k of ["identified", "host", "validUntil", "defaultRole", "defaultDatabase", "grantees", "settings", "as", "for", "using", "to"]) {
      adopt(k, d.access?.[k] === l.access?.[k]);
    }
    adopt("table", d.table === l.table);
    // A user's authentication is the environment's unless the declaration says it.
    if (d.kind === "user" && declared.identified === undefined) delete out.identified;
  }
  // A function's parameters and expression are one lambda: the same lambda is the declaration's words.
  adopt("params", d.kind === "function" && same("lambda"));
  adopt("body", d.kind === "function" && same("lambda"));
  adopt("indexes", same("indexes"));
  adopt("projections", same("projections"));
  adopt("constraints", same("constraints"));

  const declaredColumns = (declared.columns as ColumnDef[] | undefined) ?? [];
  if (d.kind === "view" || d.kind === "materializedView") {
    // The server infers a view's columns; a declaration that lists none is not drift.
    if (declaredColumns.length === 0) out.columns = [];
  } else if (d.kind === "table" || d.kind === "dictionary") {
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

/** The entity types that belong to no database. */
const GLOBAL_TYPES: ReadonlySet<string> = new Set([CLICKHOUSE_ENTITY_TYPES.database, CLICKHOUSE_ENTITY_TYPES.function, CLICKHOUSE_ENTITY_TYPES.user, CLICKHOUSE_ENTITY_TYPES.role]);

/** Whether the server's formatter prints two expressions the same. A formatter that cannot parse them says no. */
async function sameExpression(target: ClickHouseTarget, a: string, b: string): Promise<boolean> {
  try {
    const [row] = await clickhouseQuery<{ a: string; b: string }>(
      target.endpoint,
      `SELECT formatQuerySingleLine(${sqlString(`SELECT ${a}`)}) AS a, formatQuerySingleLine(${sqlString(`SELECT ${b}`)}) AS b`,
    );
    return row !== undefined && row.a === row.b;
  } catch {
    return false;
  }
}

/** Every server's copy of each table and view on a cluster (#3664), as `<database>.<name>` → host → statement. */
interface ClusterCopies {
  /** The host the profile names, whose copy the rest are compared with. */
  self: string;
  byKey: Map<string, Map<string, string>>;
}

/**
 * On a `cluster:<name>` topology, read `system.tables` on every replica of
 * every shard through the profile's server (`clusterAllReplicas`). A change
 * made on one server without `ON CLUSTER` (a TTL altered on shard 2 alone)
 * is then seen, which the profile's server alone would not show. Undefined
 * for any other topology: there is one copy.
 */
async function clusterCopies(target: ClickHouseTarget): Promise<ClusterCopies | undefined> {
  if (target.topology?.kind !== "cluster") return undefined;
  const scope = target.databases
    ? `IN (${target.databases.map(sqlString).join(", ")})`
    : `NOT IN (${[...SYSTEM_DATABASES].map(sqlString).join(", ")})`;
  const [self] = await clickhouseQuery<{ host: string }>(target.endpoint, "SELECT hostName() AS host");
  const rows = await clickhouseQuery<{ host: string; database: string; name: string; statement: string }>(
    target.endpoint,
    `SELECT hostName() AS host, database, name, create_table_query AS statement ` +
      `FROM clusterAllReplicas(${sqlString(target.topology.cluster)}, system.tables) ` +
      `WHERE database ${scope} AND NOT is_temporary AND name NOT LIKE '.inner%' AND engine != 'Dictionary' ORDER BY host, database, name`,
  );
  const byKey = new Map<string, Map<string, string>>();
  for (const r of rows) {
    const key = `${r.database}.${r.name}`;
    if (!byKey.has(key)) byKey.set(key, new Map());
    byKey.get(key)!.set(r.host, stripMarkerFromStatement(r.statement));
  }
  return { self: self?.host ?? "", byKey };
}

/**
 * When the servers' copies of `key` do not all read the same, the copy to
 * report and its server: whichever departs furthest from the declaration
 * `d`, the profile server's own winning a tie. A copy that differs from the
 * declaration on any server is then the one the diff sees. Undefined when
 * every copy reads the same.
 */
function copyToReport(copies: ClusterCopies, key: string, d: CanonicalObject, defaultDatabase: string): { host: string; statement: string } | undefined {
  const byHost = copies.byKey.get(key);
  const mine = byHost?.get(copies.self);
  if (!byHost || mine === undefined) return undefined;
  const shape = (c: CanonicalObject) => {
    const { columns, ...rest } = c;
    return JSON.stringify({ ...rest, columns: columns.map(({ text: _t, position: _p, ...col }) => col) });
  };
  const reference = shape(canonicalObject(mine, defaultDatabase));
  const declared = JSON.parse(shape(d)) as Record<string, unknown>;
  /** How many of the declaration's fields this copy holds differently. */
  const departures = (statement: string) => {
    const live = JSON.parse(shape(canonicalObject(statement, defaultDatabase))) as Record<string, unknown>;
    return Object.keys({ ...declared, ...live }).filter((k) => k !== "name" && k !== "database" && JSON.stringify(declared[k]) !== JSON.stringify(live[k])).length;
  };
  let pick: { host: string; statement: string; score: number } | undefined;
  for (const [host, statement] of byHost) {
    if (host === copies.self || shape(canonicalObject(statement, defaultDatabase)) === reference) continue;
    const score = departures(statement);
    if (!pick || score > pick.score) pick = { host, statement, score };
  }
  if (!pick) return undefined;
  return pick.score > departures(mine) ? { host: pick.host, statement: pick.statement } : { host: copies.self, statement: mine };
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
    live = [...(await readLiveSchema(target)), ...(target.access === true ? await readLiveAccess(target, accessOf(options.entities, target.defaultDatabase)) : [])];
  } catch (err) {
    const why = classifyClickHouseFailure(err);
    for (const name of options.entityNames) {
      unobserved[name] = { type: options.entities.get(name)?.entityType ?? "", reason: why.reason, detail: why.detail };
    }
    return deepObservation({}, unobserved);
  }
  const byKey = new Map(live.map((o) => [objectKey(o), o]));
  let copies: ClusterCopies | undefined;
  try {
    copies = await clusterCopies(target);
  } catch (err) {
    // A cluster whose servers cannot all be read is not reported as matching.
    const why = classifyClickHouseFailure(err);
    for (const name of options.entityNames) {
      unobserved[name] = { type: options.entities.get(name)?.entityType ?? "", reason: why.reason, detail: `reading every server of the cluster: ${why.detail}` };
    }
    return deepObservation({}, unobserved);
  }
  for (const name of options.entityNames) {
    const entity = options.entities.get(name);
    if (!entity || !entity.entityType.startsWith("ClickHouse::")) {
      unobserved[name] = { type: entity?.entityType ?? "", reason: "unsupported-kind" };
      continue;
    }
    if (target.access !== true && ACCESS_ENTITY_TYPES.has(entity.entityType)) {
      unobserved[name] = { type: entity.entityType, reason: "filtered", detail: ACCESS_UNMANAGED_DETAIL };
      continue;
    }
    if (entity.entityType === CLICKHOUSE_ENTITY_TYPES.grant) {
      unobserved[name] = {
        type: entity.entityType,
        reason: "unsupported-kind",
        detail: "a grant is compared as part of its grantees' grants, which chant sql plan reports (SQLCH273, SQLCH274)",
      };
      continue;
    }
    const props = entity.props;
    const isDb = GLOBAL_TYPES.has(entity.entityType);
    const db = isDb ? undefined : typeof props.database === "string" ? props.database : target.defaultDatabase;
    const o = byKey.get(
      objectKey({ type: entity.entityType, ...(db !== undefined ? { database: db } : {}), name: String(props.name), ...(typeof props.table === "string" ? { table: props.table } : {}) }),
    );
    if (!o) continue;
    try {
      const d = canonicalObject(renderFor(String(props.ddl), target.topology), target.defaultDatabase);
      const physicalId = o.uuid ?? `${db ? `${db}.` : ""}${o.name}`;
      const other = copies && !isDb ? copyToReport(copies, `${db ?? ""}.${o.name}`, d, target.defaultDatabase) : undefined;
      if (other) {
        // The servers disagree: report the copy that departs from the declaration, and where it was seen.
        const copy: LiveObject = { ...o, statement: other.host === copies!.self ? o.statement : other.statement };
        resources[name] = {
          type: o.type,
          physicalId,
          properties: inDeclaredVocabulary(props, liveProps(copy), d, canonicalObject(copy.statement, target.defaultDatabase)),
          observedOn: other.host,
        };
        continue;
      }
      let l = canonicalObject(o.statement, target.defaultDatabase);
      // The server prints a function's expression its own way (`k*x + b` as `((k * x) + b)`): its formatter says whether the two are one.
      if (d.kind === "function" && d.lambda !== l.lambda && (await sameExpression(target, d.lambda ?? "", l.lambda ?? ""))) l = { ...l, lambda: d.lambda! };
      // A row policy's condition, the same way.
      const using = d.access?.using;
      if (d.kind === "rowPolicy" && using !== undefined && using !== l.access?.using && (await sameExpression(target, using, l.access?.using ?? ""))) {
        l = { ...l, access: { ...l.access, using } };
      }
      resources[name] = {
        type: o.type,
        physicalId,
        properties: inDeclaredVocabulary(props, liveProps(o), d, l),
      };
    } catch (err) {
      unobserved[name] = { type: entity.entityType, reason: "read-failed", detail: `the server's definition does not parse: ${(err as Error).message}` };
    }
  }
  return deepObservation(resources, unobserved);
}
