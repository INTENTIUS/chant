/**
 * Postgres objects into the import IR: one resource per object, the
 * statements that create it as the server prints them (`../live/catalog.ts`),
 * and an export name.
 */

import type { ResourceIR, TemplateIR } from "@intentius/chant/import/parser";
import { POSTGRES_ENTITY_TYPES, type PostgresEntityType } from "../entity-types";

export interface ImportedPgObject {
  type: PostgresEntityType;
  schema?: string;
  name: string;
  /** The CREATE, then any COMMENT ON statements, separated by `;`. */
  ddl: string;
}

const JS_RESERVED = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(
    " ",
  ),
);

function camel(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "object";
  const s = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join("");
  return /^[0-9]/.test(s) ? `o${s}` : s;
}

/**
 * Export names: an object's name in camel case, prefixed with its schema when
 * two schemas hold the same name; a schema's name with `Schema` after it and
 * an extension's with `Extension`, so `app` the schema and `app` a table do
 * not collide.
 */
export function exportNames(objects: readonly ImportedPgObject[]): string[] {
  const count = new Map<string, number>();
  for (const o of objects) if (o.schema) count.set(o.name, (count.get(o.name) ?? 0) + 1);
  const used = new Set<string>();
  return objects.map((o) => {
    let base =
      o.type === POSTGRES_ENTITY_TYPES.schema
        ? `${camel(o.name)}Schema`
        : o.type === POSTGRES_ENTITY_TYPES.extension
          ? `${camel(o.name)}Extension`
          : (count.get(o.name) ?? 0) > 1 && o.schema
            ? camel(`${o.schema}_${o.name}`)
            : camel(o.name);
    if (JS_RESERVED.has(base)) base = `${base}Object`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  });
}

/** The IR for a set of objects. */
export function objectsToIR(objects: readonly ImportedPgObject[], warnings: string[] = []): TemplateIR {
  const names = exportNames(objects);
  const resources: ResourceIR[] = objects.map((o, i) => ({
    logicalId: names[i]!,
    type: o.type,
    properties: { ...(o.schema ? { schema: o.schema } : {}), name: o.name, ddl: o.ddl },
  }));
  return { resources, parameters: [], ...(warnings.length ? { warnings } : {}) };
}
