/**
 * The sql serializer.
 *
 * Output is one JSON document per build: the declared schema objects, each
 * filed under its export name (the object's identity in chant) with its entity
 * type and its walked props. The entity model (chant #3197) gives each
 * dialect's objects their shape and adds the dependency order and the DDL; this
 * is the envelope they are written into.
 *
 * Rule ids: `SQL` for rules that hold in every dialect, `SQLCH` for the
 * ClickHouse dialect's (a later dialect takes its own, e.g. `SQLPG`). Both fall
 * under `rulePrefix`, so one prefix covers the whole lexicon when it loads
 * beside others, and the dialect stays visible in the id.
 */

import type { Declarable, Serializer } from "@intentius/chant";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";

const visitor: SerializerVisitor = {
  attrRef: (logicalName, attribute) => ({ ref: logicalName, attribute }),
  resourceRef: (logicalName) => ({ ref: logicalName }),
  propertyDeclarable(entity, walk) {
    if (!isResourceDeclarable(entity) || typeof entity.props !== "object" || entity.props === null) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entity.props as Record<string, unknown>)) {
      if (v !== undefined) out[k] = walk(v);
    }
    return out;
  },
};

export const sqlSerializer: Serializer = {
  name: "sql",
  rulePrefix: "SQL",

  serialize(entities: Map<string, Declarable>): string {
    if (entities.size === 0) return "";

    const names = new Map<Declarable, string>();
    for (const [name, entity] of entities) names.set(entity, name);

    const objects: Array<Record<string, unknown>> = [];
    for (const name of [...entities.keys()].sort()) {
      const entity = entities.get(name)!;
      if (entity.kind === "property") continue;
      const props = isResourceDeclarable(entity) ? walkValue(entity.props, names, visitor) : {};
      objects.push({ export: name, type: entity.entityType, props });
    }
    return `${JSON.stringify({ objects }, null, 2)}\n`;
  },
};
