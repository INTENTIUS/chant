/**
 * `observeResourcesDeep()` for the Postgres dialect: each declared object's
 * live definition as a property tree in the declaration's own shape, so
 * `chant lifecycle diff --live` reports property drift with no false drift.
 *
 * The reader parses what the catalog prints for the object (`../live/catalog.ts`)
 * with the same tag the declaration used, which gives the same props shape.
 * A field whose canonical form (`./normalize.ts`) equals the declaration's is
 * written with the declaration's own value, so `timestamptz` and
 * `timestamp with time zone`, or a constraint the declaration left unnamed and
 * the name Postgres gave it, do not read as drift; a field that differs keeps
 * the server's value. `deepNormalizationHooks` prunes what is not a property
 * of the object (the DDL text, the template source, lineage, reads).
 */

import { deepObservation, type DeepObservationResult, type DeepPendingChange, type DeepResourceObservation } from "@intentius/chant/deep-observation";
import type { UnobservedEntity } from "@intentius/chant/lexicon";
import { bindPostgres, classifyPostgresFailure, type BindOptions } from "../live/bind";
import { liveKey, readLiveSchema, type LivePgObject } from "../live/catalog";
import { accessUnobserved, declaredAddress, scopeFor } from "../live/describe-resources";
import * as tags from "../entities";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import { canonicalPgObject, columnShape, sameConstraint, type CanonicalPgObject } from "./normalize";
import { serverNormalized } from "./server-normalize";
import type { PostgresClient } from "../live/client";
import { accessChangesAgainst } from "../access/changes";
import { POSTGRES_LATEST_MAJOR } from "../../spec/postgres-pin";

type Props = Record<string, unknown>;

const TAG: Record<string, (s: TemplateStringsArray) => { props: object }> = {
  [POSTGRES_ENTITY_TYPES.schema]: tags.schema,
  [POSTGRES_ENTITY_TYPES.table]: tags.table,
  [POSTGRES_ENTITY_TYPES.index]: tags.index,
  [POSTGRES_ENTITY_TYPES.view]: tags.view,
  [POSTGRES_ENTITY_TYPES.materializedView]: tags.view,
  [POSTGRES_ENTITY_TYPES.sequence]: tags.sequence,
  [POSTGRES_ENTITY_TYPES.enum]: tags.type,
  [POSTGRES_ENTITY_TYPES.domain]: tags.domain,
  [POSTGRES_ENTITY_TYPES.extension]: tags.extension,
  [POSTGRES_ENTITY_TYPES.function]: tags.func,
  [POSTGRES_ENTITY_TYPES.procedure]: tags.procedure,
  [POSTGRES_ENTITY_TYPES.trigger]: tags.trigger,
  [POSTGRES_ENTITY_TYPES.policy]: tags.policy,
  [POSTGRES_ENTITY_TYPES.role]: tags.role,
  [POSTGRES_ENTITY_TYPES.grant]: tags.grant,
  [POSTGRES_ENTITY_TYPES.defaultPrivileges]: tags.grant,
};

/** The props of what the server printed, parsed with the declaration's tag. */
export function liveProps(o: LivePgObject): Props {
  const strings = Object.assign([o.statement], { raw: [o.statement] }) as unknown as TemplateStringsArray;
  return { ...(TAG[o.type]!(strings).props as Props) };
}

const PROP_OF_FIELD: Record<string, string[]> = {
  comment: ["comment"],
  authorization: ["authorization"],
  schema: ["schema"],
  version: ["version"],
  labels: ["labels"],
  dataType: ["dataType"],
  collate: ["collate"],
  default: ["default"],
  notNull: ["notNull"],
  options: ["dataType", "increment", "minValue", "maxValue", "start", "cache", "cycle"],
  unlogged: ["persistence"],
  ownedBy: ["ownedBy"],
  table: ["table", "tableName"],
  unique: ["unique"],
  method: ["method"],
  elements: ["elements"],
  include: ["include"],
  nullsNotDistinct: ["nullsNotDistinct"],
  with: ["with"],
  where: ["where"],
  tablespace: ["tablespace"],
  query: ["query"],
  columns: ["columns"],
  checkOption: ["checkOption"],
  withData: ["withData"],
  columnComments: ["columnComments"],
  partitionBy: ["partitionBy"],
  partitionOf: ["partitionOf"],
  partitionBound: ["partitionBound"],
  inherits: ["inherits"],
  using: ["using"],
  args: ["args"],
  returns: ["returns", "returnsTable"],
  language: ["language"],
  body: ["body"],
  link: ["link"],
  securityDefiner: ["securityDefiner"],
  set: ["set"],
  transform: ["transform"],
  volatility: ["volatility"],
  strict: ["strict"],
  leakproof: ["leakproof"],
  parallel: ["parallel"],
  cost: ["cost"],
  rows: ["rows"],
  support: ["support"],
  window: ["window"],
  constraint: ["constraint"],
  timing: ["timing"],
  events: ["events"],
  forEach: ["forEach"],
  when: ["when"],
  function: ["function", "functionName"],
  from: ["from"],
  deferrable: ["deferrable"],
  initiallyDeferred: ["initiallyDeferred"],
  referencing: ["referencing"],
  restrictive: ["permissive"],
  command: ["command"],
  roles: ["roles"],
  check: ["check"],
  attributes: ["options"],
  connectionLimit: ["connectionLimit"],
  rowSecurity: ["rowSecurity"],
  forceRowSecurity: ["forceRowSecurity"],
};

/** Props keys that hold constraints, by constraint kind. */
const CONSTRAINT_PROPS: Record<string, string> = {
  "PRIMARY KEY": "primaryKey",
  UNIQUE: "uniques",
  CHECK: "checks",
  "FOREIGN KEY": "foreignKeys",
  EXCLUDE: "exclusions",
};

/** The live props, with each field the declaration means the same as written the declaration's way. */
export function inDeclaredVocabulary(declared: Props, live: Props, d: CanonicalPgObject, l: CanonicalPgObject): Props {
  const out: Props = { ...live };
  const adopt = (key: string) => {
    if (declared[key] === undefined) delete out[key];
    else out[key] = declared[key];
  };
  if (d.name === l.name) adopt("name");
  if (d.schema === l.schema) adopt("schema");
  const fieldKeys = new Set([...Object.keys(d.fields), ...Object.keys(l.fields)]);
  for (const f of fieldKeys) {
    if (f === "schema" && d.kind !== "extension") continue;
    if (JSON.stringify(d.fields[f]) !== JSON.stringify(l.fields[f])) continue;
    for (const key of PROP_OF_FIELD[f] ?? []) adopt(key);
  }
  // Fields neither side's canonical form carries (left at their default) are the declaration's too.
  for (const [f, keys] of Object.entries(PROP_OF_FIELD)) {
    if (!fieldKeys.has(f)) for (const key of keys) if (f !== "schema" || d.kind === "extension") adopt(key);
  }

  if (d.kind === "table") {
    const declaredColumns = (declared.columns as unknown[] | undefined) ?? [];
    const liveColumns = (live.columns as unknown[] | undefined) ?? [];
    // Columns are matched by name and listed in the declaration's order, the
    // live columns the declaration does not name after them. Postgres keeps a
    // table's columns in the order they were added, and no ALTER moves one: a
    // column renamed by expand and contract is last on the server and where
    // the old one was in the declaration (INTENTIUS/sql-yodeler#47). The plan
    // compares columns by name too, so an order the server cannot be brought
    // to is not drift.
    const read = liveColumns.map((c, i) => {
      const lc = l.columns[i];
      const dc = lc ? d.columns.find((x) => x.name === lc.name) : undefined;
      return { at: dc?.position, value: lc && dc && columnShape(lc) === columnShape(dc) ? declaredColumns[dc.position] : c };
    });
    out.columns = [
      ...read.filter((c) => c.at !== undefined).sort((a, b) => a.at! - b.at!),
      ...read.filter((c) => c.at === undefined),
    ].map((c) => c.value);
  }
  if (d.kind === "table" || d.kind === "domain") {
    // A constraint the declaration says the same as the server is the declaration's (its name included or left out).
    const kinds = d.kind === "domain" ? ["CHECK"] : Object.keys(CONSTRAINT_PROPS);
    for (const kind of kinds) {
      const key = CONSTRAINT_PROPS[kind]!;
      const dl = d.constraints.filter((c) => c.kind === kind);
      const ll = l.constraints.filter((c) => c.kind === kind);
      const all = dl.length === ll.length && dl.every((c) => ll.some((x) => sameConstraint(c, x) && c.notValid === x.notValid && c.comment === x.comment));
      if (all) adopt(key);
    }
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
  let live: LivePgObject[];
  let client: PostgresClient;
  const declared = options.entityNames.map((name) => ({ name, entity: options.entities.get(name) }));
  try {
    const bound = await bindPostgres(options);
    target = bound.target;
    client = bound.client;
    try {
      live = await readLiveSchema(bound.client, {
        schemas: scopeFor(target, declared.filter((x) => x.entity?.entityType.startsWith("Postgres::")).map((x) => ({ type: x.entity!.entityType, props: x.entity!.props }))),
        access: target.access === true,
        roles: declared.filter((x) => x.entity?.entityType === POSTGRES_ENTITY_TYPES.role).map((x) => String(x.entity!.props.name)),
      });
    } catch (err) {
      await bound.client.end();
      throw err;
    }
  } catch (err) {
    const why = classifyPostgresFailure(err);
    for (const { name, entity } of declared) unobserved[name] = { type: entity?.entityType ?? "", reason: why.reason, detail: why.detail };
    return deepObservation({}, unobserved);
  }
  const pending: DeepPendingChange[] = [];
  try {
    if (target.access === true) {
      // #3706: the privilege changes an apply would make, which no one
      // declaration's properties show, so the plan digest moves with them.
      try {
        pending.push(...(await pendingAccess(client, target.defaultSchema, declared, scopeFor(target, declared.filter((x) => x.entity?.entityType.startsWith("Postgres::")).map((x) => ({ type: x.entity!.entityType, props: x.entity!.props }))))));
      } catch (err) {
        for (const { name, entity } of declared) {
          if (entity?.entityType === POSTGRES_ENTITY_TYPES.grant || entity?.entityType === POSTGRES_ENTITY_TYPES.defaultPrivileges) {
            unobserved[name] = { type: entity.entityType, reason: "read-failed", detail: `the server's privileges could not be compared: ${(err as Error).message}` };
          }
        }
      }
    }
    const byKey = new Map(live.map((o) => [liveKey(o.type, o.schema, o.name, o.signature), o]));
    for (const { name, entity } of declared) {
      if (!entity || !entity.entityType.startsWith("Postgres::")) {
        unobserved[name] = { type: entity?.entityType ?? "", reason: "unsupported-kind" };
        continue;
      }
      const why = accessUnobserved(entity.entityType, target.access === true);
      if (why) {
        if (unobserved[name]) continue;
        unobserved[name] = { type: entity.entityType, ...why };
        continue;
      }
      const { schema, name: objectName, signature } = declaredAddress({ type: entity.entityType, props: entity.props }, target.defaultSchema);
      const o = byKey.get(liveKey(entity.entityType, schema, objectName, signature));
      if (!o) continue;
      try {
        const lp = liveProps(o);
        let d = canonicalPgObject(entity.entityType, entity.props, target.defaultSchema);
        const l = canonicalPgObject(o.type, lp, target.defaultSchema);
        // A trigger's WHEN and a policy's expressions as the server would print them, when the rules leave them different.
        if ((d.kind === "trigger" && d.fields.when !== l.fields.when) || (d.kind === "policy" && (d.fields.using !== l.fields.using || d.fields.check !== l.fields.check))) {
          d = await serverNormalized(client, d, target.defaultSchema);
        }
        resources[name] = { type: o.type, physicalId: o.oid, properties: inDeclaredVocabulary(entity.props, lp, d, l) };
      } catch (err) {
        unobserved[name] = { type: entity.entityType, reason: "read-failed", detail: `the server's definition does not parse: ${(err as Error).message}` };
      }
    }
  } finally {
    await client.end();
  }
  return deepObservation(resources, unobserved, pending);
}

/**
 * The privilege changes an apply would make (#3706), as `chant sql plan`
 * computes them, one per object and grantee: the statements, and the
 * declarations behind them.
 */
async function pendingAccess(
  client: PostgresClient,
  defaultSchema: string,
  declared: ReadonlyArray<{ name: string; entity?: { entityType: string; props: Record<string, unknown> } }>,
  scope: string[] | undefined,
): Promise<DeepPendingChange[]> {
  const objects = declared
    .filter((x) => x.entity?.entityType.startsWith("Postgres::"))
    .map((x) => ({ key: x.name, canonical: canonicalPgObject(x.entity!.entityType, x.entity!.props, defaultSchema) }));
  const [row] = await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  const n = Number(row?.v);
  const major = Number.isFinite(n) && n > 0 ? Math.floor(n / 10000) : POSTGRES_LATEST_MAJOR;
  const changes = await accessChangesAgainst(client, objects, { major, ...(scope ? { scope } : {}) });
  return changes.map((c) => ({
    subject: c.change.object.startsWith("acl ") ? c.change.object.slice(4) : c.change.object,
    change: c.sql.join("; "),
    ...(c.exports.length > 0 ? { entities: [...c.exports].sort() } : {}),
  }));
}
