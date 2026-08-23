import type { Serializer, Declarable } from "@intentius/chant";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { propsOf } from "./entity-props";

/**
 * Fountain serializer — emits fountain's native manifest format
 * (`apiVersion: fountain.dev/v1`), one YAML document per resource, as a
 * single multi-document stream. The output stays `fountain apply -f`
 * compatible, so anyone can eject from chant and keep the artifacts.
 *
 * This is also `fountainApply`'s own input now: since fountain's bulk
 * `POST /api/apply` (BinaryBourbon/fountain#151) resolves name references
 * server-side, there's no separate sidecar to keep in sync — the manifest
 * YAML is the only artifact.
 *
 * Cross-resource references (e.g. `agent.environment`) serialize to the
 * referenced entity's name — fountain resolves names to ids at apply.
 *
 * The `name` prop becomes `metadata.name` and is not repeated under `spec`,
 * matching fountain's own manifest examples.
 */

const API_VERSION = "fountain.dev/v1";

/**
 * The name fountain reconciles by.
 *
 * The declared `name` when there is one, the chant export name otherwise. This
 * matters more than it looks: fountain upserts by name, so keying on the export
 * name would mean renaming a TypeScript variable creates a second resource and
 * orphans the first, and a declared `name` would be silently demoted to an
 * ordinary attribute. Same rule the k8s serializer follows for `metadata.name`.
 */
function fountainName(exportName: string, entity: Declarable): string {
  const declared = propsOf(entity).name;
  return typeof declared === "string" && declared.length > 0 ? declared : exportName;
}

/** Fountain::V1::Agent → Agent */
function kindOf(entityType: string): string {
  const parts = entityType.split("::");
  return parts[parts.length - 1];
}

export const fountainSerializer: Serializer = {
  name: "fountain",
  rulePrefix: "FTN",

  serialize(entities: Map<string, Declarable>): string {
    // Reverse map for reference resolution: Declarable instance → fountain name.
    // Keyed on the fountain name rather than the export name so an agent's
    // `environment` reference resolves to the same identity the environment's
    // own manifest carries.
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, fountainName(name, entity));
    }

    const visitor: SerializerVisitor = {
      // A reference to another fountain resource serializes to its name.
      attrRef(logicalName, _attribute) {
        return logicalName;
      },
      resourceRef(logicalName) {
        return logicalName;
      },
      propertyDeclarable(entity, walk) {
        const props: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(propsOf(entity))) {
          if (val === undefined) continue;
          props[key] = walk(val);
        }
        return props;
      },
    };

    const docs: string[] = [];
    for (const [name, entity] of entities) {
      // `name` lives in `metadata` only. fountain's manifest format carries
      // the upsert key there and nowhere else; a second copy under `spec`
      // is at best redundant and at worst a conflicting value (#1606).
      const spec: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(propsOf(entity))) {
        if (val === undefined || key === "name") continue;
        spec[key] = walkValue(val, entityNames, visitor);
      }

      const manifest = {
        apiVersion: API_VERSION,
        kind: kindOf(entity.entityType),
        metadata: { name: fountainName(name, entity) },
        spec,
      };
      docs.push(toYaml(manifest));
    }

    return docs.join("---\n");
  },
};

// ── Minimal YAML emitter ───────────────────────────────────────────
// The manifest shape is plain JSON-compatible data (maps, arrays, scalars),
// so a small emitter keeps the lexicon dependency-free. Strings are quoted
// whenever they could be misread as another YAML type.

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = "";
    for (const item of value) {
      if (isScalar(item)) {
        out += `${pad}- ${scalar(item)}\n`;
      } else {
        // Fold the item's first line onto the dash (`- key: value`) rather
        // than emitting the dash on its own line: `- ` is exactly as wide
        // as one indent level, so continuation lines already align, and
        // parseYAML can't read the dash-alone form (#1286).
        const body = toYaml(item, indent + 1);
        out += `${pad}- ${body.slice(pad.length + 2)}`;
      }
    }
    return out;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}\n`;
    let out = "";
    for (const [k, v] of entries) {
      if (isScalar(v)) {
        out += `${pad}${key(k)}: ${scalar(v)}\n`;
      } else if (Array.isArray(v) && v.length === 0) {
        out += `${pad}${key(k)}: []\n`;
      } else if (v !== null && typeof v === "object" && Object.keys(v as object).length === 0) {
        out += `${pad}${key(k)}: {}\n`;
      } else {
        out += `${pad}${key(k)}:\n${toYaml(v, indent + 1)}`;
      }
    }
    return out;
  }

  return `${pad}${scalar(value)}\n`;
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

const PLAIN_STRING = /^[A-Za-z0-9._/-][A-Za-z0-9._/ -]*$/;
const YAML_AMBIGUOUS = /^(true|false|null|yes|no|on|off|~|[+-]?[0-9.]+([eE][+-]?[0-9]+)?)$/i;

function scalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s === "" || !PLAIN_STRING.test(s) || YAML_AMBIGUOUS.test(s) || s.includes("\n")) {
    return JSON.stringify(s);
  }
  return s;
}

function key(k: string): string {
  return PLAIN_STRING.test(k) && !YAML_AMBIGUOUS.test(k) ? k : JSON.stringify(k);
}
