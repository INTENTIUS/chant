/**
 * `describeResources()` for MySQL (#5449): which declared databases, tables
 * and views exist on the environment's server. One read of
 * `information_schema` per run, then a lookup per declared entity. An object
 * the catalog does not list is absent; a server that cannot be reached, or
 * refuses the credentials, leaves every entity unobserved with that reason.
 *
 * Ownership is read from chant's marker on a table's comment: `owned` when
 * it carries one, `foreign` when it does not. A view or a database has no
 * comment, so it is always `foreign`. With `owned: true`, an object without
 * the marker is withheld as `filtered`.
 */

import { observeEntities, type DeclaredEntity, type DescribeResourcesResult, type EntityObservation, type ObserverAdapter } from "@intentius/chant/observation";
import { bindMysql, classifyMysqlFailure, type MysqlBindOptions, type MysqlTarget } from "./bind";
import { checkServer, readLiveSchema, type LiveMysqlObject } from "./catalog";
import type { MysqlClient } from "./client";
import { MYSQL_ENTITY_TYPES } from "../entities";
import { isChantManaged, readMarker, stripMarker } from "../../core/ownership";

interface Bound {
  target: MysqlTarget;
  byKey: Map<string, LiveMysqlObject>;
}

const keyOf = (type: string, database: string | undefined, name: string) => `${type} ${database !== undefined ? `${database}.` : ""}${name}`;

/** The database and name a declared entity is created as. */
export function declaredAddress(entity: DeclaredEntity, defaultDatabase: string | undefined): { database?: string; name: string } {
  const name = String(entity.props.name ?? "");
  if (entity.type === MYSQL_ENTITY_TYPES.database) return { name };
  const database = typeof entity.props.database === "string" ? entity.props.database : defaultDatabase;
  return { ...(database !== undefined ? { database } : {}), name };
}

function adapter(options: MysqlBindOptions & { owned?: boolean; readLive?: typeof readLiveSchema }): ObserverAdapter<Bound> {
  return {
    async bind() {
      const { target, client } = await bindMysql(options);
      try {
        await checkServer(client);
        const byKey = new Map<string, LiveMysqlObject>();
        for (const o of await (options.readLive ?? readLiveSchema)(client as MysqlClient, { ...(target.databases ? { databases: target.databases } : {}), withStatements: false })) {
          byKey.set(keyOf(o.type, o.database, o.name), o);
        }
        return { target, byKey };
      } finally {
        await client.end();
      }
    },
    classifyBindFailure: (err) => classifyMysqlFailure(err),
    async read({ target, byKey }, entity): Promise<EntityObservation> {
      if (!entity.type.startsWith("MySQL::")) return { unobserved: { reason: "unsupported-kind", detail: entity.type } };
      const { database, name } = declaredAddress(entity, target.defaultDatabase);
      const queried = `${target.source} ${database !== undefined ? `${database}.` : ""}${name}`;
      const live = byKey.get(keyOf(entity.type, database, name));
      if (!live) return { absent: true, queried };
      const owned = isChantManaged(live.comment);
      if (options.owned && !owned) return { unobserved: { reason: "filtered", detail: "the object carries no chant ownership marker and owned was requested" }, queried };
      const marker = readMarker(live.comment);
      const comment = live.comment ? stripMarker(live.comment) : "";
      return {
        present: {
          type: live.type,
          physicalId: database !== undefined ? `${database}.${name}` : name,
          status: "",
          ...(comment ? { attributes: { comment } } : {}),
          ownership: owned ? "owned" : "foreign",
          ...(owned && marker?.stack ? { marker: { stack: marker.stack, ...(marker.env ? { env: marker.env } : {}) } } : {}),
        },
        queried,
      };
    },
  };
}

export async function describeMysqlResources(
  options: {
    environment: string;
    entityNames: string[];
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    owned?: boolean;
    readLive?: typeof readLiveSchema;
  } & Omit<MysqlBindOptions, "environment">,
): Promise<DescribeResourcesResult> {
  const declared: DeclaredEntity[] = options.entityNames.map((name) => {
    const entity = options.entities.get(name);
    return { name, type: entity?.entityType ?? "", props: entity?.props ?? {} };
  });
  return observeEntities(declared, adapter(options));
}
