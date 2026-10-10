/**
 * `describeResources()` for the ClickHouse dialect: which declared databases,
 * tables and views exist on the environment's server.
 *
 * One read of `system.databases`, `system.tables` and `system.functions` per
 * run, then a lookup per declared entity, so N entities are three queries,
 * not N. An object the
 * catalog does not list is absent, and the `queried` address says which
 * server and name were asked. A server that cannot be reached, or refuses the
 * credentials, leaves every entity unobserved with that reason: never absent.
 *
 * Ownership is read from chant's marker, the trailer the applier appends to
 * the object's comment (`../ownership.ts`): `owned` when the comment carries
 * it, `foreign` when it does not. With `owned: true` a foreign object is
 * withheld as `filtered`, which says it exists and is not chant's, never that
 * it is absent.
 */

import {
  observeEntities,
  type DeclaredEntity,
  type DescribeResourcesResult,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import { bindClickHouse, classifyClickHouseFailure, type BindOptions, type ClickHouseTarget } from "./bind";
import { ACCESS_ENTITY_TYPES, ACCESS_UNMANAGED_DETAIL, accessOf, readLiveAccess, readLiveSchema, type DeclaredAccess, type LiveObject } from "./catalog";
import { CLICKHOUSE_ENTITY_TYPES } from "../entities";
import { objectKey } from "../plan/normalize";
import { isChantManaged, readMarker, stripMarker } from "../ownership";

interface Bound {
  target: ClickHouseTarget;
  byKey: Map<string, LiveObject>;
}


/** The database and name a declared entity is created as. */
export function declaredAddress(entity: DeclaredEntity, defaultDatabase: string): { database?: string; name: string } {
  const name = String(entity.props.name ?? "");
  if (
    entity.type === CLICKHOUSE_ENTITY_TYPES.database ||
    entity.type === CLICKHOUSE_ENTITY_TYPES.function ||
    entity.type === CLICKHOUSE_ENTITY_TYPES.user ||
    entity.type === CLICKHOUSE_ENTITY_TYPES.role
  ) {
    return { name };
  }
  return { database: typeof entity.props.database === "string" ? entity.props.database : defaultDatabase, name };
}

function adapter(options: BindOptions & { owned?: boolean; access?: (defaultDatabase: string) => DeclaredAccess[] }): ObserverAdapter<Bound> {
  return {
    async bind() {
      const target = await bindClickHouse(options);
      const byKey = new Map<string, LiveObject>();
      const access = target.access === true ? await readLiveAccess(target, options.access?.(target.defaultDatabase) ?? [], { withStatements: false }) : [];
      for (const o of [...(await readLiveSchema(target, { withStatements: false })), ...access]) {
        byKey.set(objectKey(o), o);
      }
      return { target, byKey };
    },
    classifyBindFailure: (err) => classifyClickHouseFailure(err),
    async read({ target, byKey }, entity): Promise<EntityObservation> {
      if (!entity.type.startsWith("ClickHouse::")) {
        return { unobserved: { reason: "unsupported-kind", detail: entity.type } };
      }
      if (target.access !== true && ACCESS_ENTITY_TYPES.has(entity.type)) {
        return { unobserved: { reason: "filtered", detail: ACCESS_UNMANAGED_DETAIL } };
      }
      if (entity.type === CLICKHOUSE_ENTITY_TYPES.grant) {
        return { unobserved: { reason: "unsupported-kind", detail: "a grant is compared as part of its grantees' grants, which chant sql plan reports" } };
      }
      const { database, name } = declaredAddress(entity, target.defaultDatabase);
      const queried = `${target.endpoint.url} ${database ? `${database}.` : ""}${name}`;
      const table = typeof entity.props.table === "string" ? entity.props.table : undefined;
      const live = byKey.get(objectKey({ type: entity.type, ...(database !== undefined ? { database } : {}), name, ...(table !== undefined ? { table } : {}) }));
      if (!live) return { absent: true, queried };
      const owned = isChantManaged(live.comment);
      if (options.owned && !owned) {
        return { unobserved: { reason: "filtered", detail: "the object's comment carries no chant ownership marker and owned was requested" }, queried };
      }
      const marker = readMarker(live.comment);
      const comment = live.comment ? stripMarker(live.comment) : "";
      return {
        present: {
          type: live.type,
          physicalId: live.uuid ?? (database ? `${database}.${name}` : name),
          status: live.engine,
          attributes: { engine: live.engine, ...(live.uuid ? { uuid: live.uuid } : {}), ...(comment ? { comment } : {}) },
          ownership: owned ? "owned" : "foreign",
          ...(owned && marker?.stack ? { marker: { stack: marker.stack, ...(marker.env ? { env: marker.env } : {}) } } : {}),
        },
        queried,
      };
    },
  };
}

export async function describeResources(
  options: {
    environment: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    /** Withhold objects that do not carry chant's ownership marker. */
    owned?: boolean;
  } & Omit<BindOptions, "environment">,
): Promise<DescribeResourcesResult> {
  const declared: DeclaredEntity[] = options.entityNames.map((name) => {
    const entity = options.entities.get(name);
    return { name, type: entity?.entityType ?? "", props: entity?.props ?? {} };
  });
  return observeEntities(declared, adapter({ ...options, access: (db) => accessOf(options.entities, db) }));
}
