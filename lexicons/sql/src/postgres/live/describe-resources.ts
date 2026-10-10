/**
 * `describeResources()` for the Postgres dialect: which declared objects exist
 * on the environment's server.
 *
 * One catalog read per run (`./catalog.ts`), then a lookup per declared
 * entity, so N entities are a fixed handful of queries. An object the catalog
 * does not list is absent, and the `queried` address names the server and the
 * object asked for. A server that cannot be reached, or refuses the
 * credentials, leaves every entity unobserved with that reason: never absent.
 *
 * Ownership is chant's marker, the trailer on the object's comment
 * (`../../core/ownership.ts`): `owned` when the comment carries it, `foreign`
 * when it does not. With `owned: true` a foreign object is withheld as
 * `filtered`. An object another tool keeps (an ORM's revision table) is
 * foreign whatever its comment says.
 */

import {
  observeEntities,
  type DeclaredEntity,
  type DescribeResourcesResult,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import { bindPostgres, classifyPostgresFailure, redactUrl, type BindOptions, type PostgresTarget } from "./bind";
import { liveKey, markProviderOwned, readLiveSchema, type LivePgObject } from "./catalog";
import { POSTGRES_ENTITY_TYPES } from "../entity-types";
import { isChantManaged, readMarker, stripMarker } from "../../core/ownership";
import { identValue } from "../parser";
import { canonicalPgObject } from "../plan/normalize";

interface Bound {
  target: PostgresTarget;
  byKey: Map<string, LivePgObject>;
}

/**
 * The schema and name a declared entity is created as; a bare name is in the
 * default schema. A routine's parameter types and a trigger's table tell it
 * from another of the same name (`signature`).
 */
export function declaredAddress(entity: { type: string; props: Record<string, unknown> }, defaultSchema: string): { schema?: string; name: string; signature?: string } {
  const name = String(entity.props.name ?? "");
  if (entity.type === POSTGRES_ENTITY_TYPES.schema || entity.type === POSTGRES_ENTITY_TYPES.extension) return { name };
  const schema = typeof entity.props.schema === "string" ? entity.props.schema : identValue(defaultSchema);
  if (entity.type === POSTGRES_ENTITY_TYPES.function || entity.type === POSTGRES_ENTITY_TYPES.procedure || entity.type === POSTGRES_ENTITY_TYPES.trigger) {
    const signature = canonicalPgObject(entity.type, entity.props, defaultSchema).signature;
    return { schema, name, ...(signature !== undefined ? { signature } : {}) };
  }
  return { schema, name };
}

/** A schema scope for the catalog read: the profile's schemas, else every schema the declarations name and the default one. */
export function scopeFor(target: PostgresTarget, entities: ReadonlyArray<{ type: string; props: Record<string, unknown> }>): string[] | undefined {
  if (target.schemas) return target.schemas;
  if (entities.length === 0) return undefined;
  const out = new Set<string>([target.defaultSchema]);
  for (const e of entities) {
    const a = declaredAddress(e, target.defaultSchema);
    if (e.type === POSTGRES_ENTITY_TYPES.schema) out.add(a.name);
    else if (a.schema) out.add(a.schema);
  }
  return [...out].sort();
}

function adapter(options: BindOptions & { owned?: boolean; declared: DeclaredEntity[] }): ObserverAdapter<Bound> {
  return {
    async bind() {
      const { target, client } = await bindPostgres(options);
      try {
        const live = markProviderOwned(await readLiveSchema(client, { schemas: scopeFor(target, options.declared.filter((d) => d.type.startsWith("Postgres::"))) }), target.provider);
        return { target, byKey: new Map(live.map((o) => [liveKey(o.type, o.schema, o.name, o.signature), o])) };
      } finally {
        await client.end();
      }
    },
    classifyBindFailure: (err) => classifyPostgresFailure(err),
    async read({ target, byKey }, entity): Promise<EntityObservation> {
      if (!entity.type.startsWith("Postgres::")) return { unobserved: { reason: "unsupported-kind", detail: entity.type } };
      const { schema, name, signature } = declaredAddress(entity, target.defaultSchema);
      const queried = `${redactUrl(target.endpoint.url)} ${schema ? `${schema}.` : ""}${name}${signature ?? ""}`;
      const live = byKey.get(liveKey(entity.type, schema, name, signature));
      if (!live) return { absent: true, queried };
      const owned = !live.foreign && isChantManaged(live.comment);
      if (options.owned && !owned) {
        return {
          unobserved: { reason: "filtered", detail: live.foreign ? `${live.foreign} keeps this object` : "the object's comment carries no chant ownership marker and owned was requested" },
          queried,
        };
      }
      const marker = readMarker(live.comment);
      const comment = live.comment ? stripMarker(live.comment) : "";
      return {
        present: {
          type: live.type,
          physicalId: live.oid,
          status: "PRESENT",
          attributes: { oid: live.oid, ...(comment ? { comment } : {}), ...(live.foreign ? { keptBy: live.foreign } : {}) },
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
    owned?: boolean;
  } & Omit<BindOptions, "environment">,
): Promise<DescribeResourcesResult> {
  const declared: DeclaredEntity[] = options.entityNames.map((name) => {
    const entity = options.entities.get(name);
    return { name, type: entity?.entityType ?? "", props: entity?.props ?? {} };
  });
  return observeEntities(declared, adapter({ ...options, declared }));
}
