import type { Serializer, SerializerResult, Declarable } from "@intentius/chant";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { propsOf } from "./entity-props";

/**
 * Fountain serializer — emits fountain's native manifest format
 * (`apiVersion: fountain.dev/v1`), one YAML document per resource, as a
 * single multi-document stream. The output stays `fountain apply -f`
 * compatible, so anyone can eject from chant and keep the artifacts.
 *
 * Cross-resource references (e.g. `agent.environment`) serialize to the
 * referenced entity's name — fountain's CLI resolves names to ids at apply.
 */

const API_VERSION = "fountain.dev/v1";

/** Fountain::V1::Agent → Agent */
function kindOf(entityType: string): string {
  const parts = entityType.split("::");
  return parts[parts.length - 1];
}

export const fountainSerializer: Serializer = {
  name: "fountain",
  rulePrefix: "FTN",

  serialize(entities: Map<string, Declarable>): string | SerializerResult {
    // Reverse map for reference resolution: Declarable instance → name.
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
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
    const plan: Record<string, { kind: string; spec: Record<string, unknown> }> = {};
    for (const [name, entity] of entities) {
      const spec: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(propsOf(entity))) {
        if (val === undefined) continue;
        spec[key] = walkValue(val, entityNames, visitor);
      }

      const manifest = {
        apiVersion: API_VERSION,
        kind: kindOf(entity.entityType),
        metadata: { name },
        spec,
      };
      docs.push(toYaml(manifest));
      plan[name] = { kind: manifest.kind, spec };
    }

    const yaml = docs.join("---\n");
    if (docs.length === 0) return yaml;

    // Primary output is the ejectable `fountain apply -f` YAML; the JSON
    // sidecar is the fountainApply op's input (same data, no YAML parser
    // needed on the apply side — the fly plan.json pattern).
    return { primary: yaml, files: { "fountain-plan.json": JSON.stringify(plan, null, 2) } };
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
        const body = toYaml(item, indent + 1);
        out += `${pad}-\n${body}`;
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
