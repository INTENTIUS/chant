/**
 * GitLab CI YAML serializer.
 *
 * Converts Chant declarables to .gitlab-ci.yml YAML output.
 * Uses snake_case keys (GitLab CI convention) and produces
 * valid YAML without a library dependency — the CI schema is
 * simple enough for a direct emitter.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isPropertyDeclarable } from "@intentius/chant/declarable";
import type { Serializer } from "@intentius/chant/serializer";
import type { LexiconOutput } from "@intentius/chant/lexicon-output";
import { walkValue, type SerializerVisitor } from "@intentius/chant/serializer-walker";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

/**
 * Convert camelCase or PascalCase to snake_case.
 */
function toSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * GitLab CI visitor for the generic serializer walker.
 */
function gitlabVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, _attr) => name,
    resourceRef: (name) => name,
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          result[toSnakeCase(key)] = walk(value);
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
    transformKey: toSnakeCase,
  };
}

/**
 * Convert a value to YAML-compatible form using the walker.
 */
function toYAMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  return walkValue(value, entityNames, gitlabVisitor(entityNames));
}

/**
 * Emit a YAML value with proper indentation.
 */
function emitYAML(value: unknown, indent: number): string {
  const prefix = "  ".repeat(indent);

  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    // Quote strings that could be misinterpreted
    if (
      value === "" ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      value === "yes" ||
      value === "no" ||
      value.includes(": ") ||
      value.includes("#") ||
      value.startsWith("*") ||
      value.startsWith("&") ||
      value.startsWith("!") ||
      value.startsWith("{") ||
      value.startsWith("[") ||
      value.startsWith("'") ||
      value.startsWith('"') ||
      value.startsWith("$") ||
      /^\d/.test(value)
    ) {
      // Use single quotes, escaping internal single quotes
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Object items in arrays
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          lines.push(`${prefix}- ${firstKey}: ${emitYAML(firstVal, indent + 2).trimStart()}`);
          for (let i = 1; i < entries.length; i++) {
            const [key, val] = entries[i];
            lines.push(`${prefix}  ${key}: ${emitYAML(val, indent + 2).trimStart()}`);
          }
        }
      } else {
        lines.push(`${prefix}- ${emitYAML(item, indent + 1).trimStart()}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [key, val] of entries) {
      const emitted = emitYAML(val, indent + 1);
      if (emitted.startsWith("\n")) {
        lines.push(`${prefix}${key}:${emitted}`);
      } else {
        lines.push(`${prefix}${key}: ${emitted}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  return String(value);
}

/**
 * GitLab CI YAML serializer implementation.
 */
export const gitlabSerializer: Serializer = {
  name: "gitlab",
  rulePrefix: "WGL",

  serialize(entities: Map<string, Declarable>, _outputs?: LexiconOutput[]): string {
    // Build reverse map: entity → name
    const entityNames = new Map<Declarable, string>();
    for (const [name, entity] of entities) {
      entityNames.set(entity, name);
    }

    const sections: string[] = [];

    // Separate entities by type
    const jobs: Array<[string, Declarable]> = [];
    const defaults: Array<[string, Declarable]> = [];
    const workflows: Array<[string, Declarable]> = [];
    const others: Array<[string, Declarable]> = [];

    for (const [name, entity] of entities) {
      if (isPropertyDeclarable(entity)) continue; // Skip property-only entities

      const entityType = (entity as Record<string, unknown>).entityType as string;
      if (entityType === "GitLab::CI::Job") {
        jobs.push([name, entity]);
      } else if (entityType === "GitLab::CI::Default") {
        defaults.push([name, entity]);
      } else if (entityType === "GitLab::CI::Workflow") {
        workflows.push([name, entity]);
      } else {
        others.push([name, entity]);
      }
    }

    // Emit stages (collect from jobs)
    const stages = new Set<string>();
    for (const [, entity] of jobs) {
      const props = (entity as Record<string, unknown>).props as Record<string, unknown> | undefined;
      if (props?.stage && typeof props.stage === "string") {
        stages.add(props.stage);
      }
    }
    if (stages.size > 0) {
      sections.push("stages:" + emitYAML([...stages], 1));
    }

    // Emit defaults
    for (const [, entity] of defaults) {
      const converted = toYAMLValue(
        (entity as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (converted) {
        sections.push("default:" + emitYAML(converted, 1));
      }
    }

    // Emit workflow
    for (const [, entity] of workflows) {
      const converted = toYAMLValue(
        (entity as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (converted) {
        sections.push("workflow:" + emitYAML(converted, 1));
      }
    }

    // Emit jobs
    for (const [name, entity] of jobs) {
      const converted = toYAMLValue(
        (entity as Record<string, unknown>).props,
        entityNames,
      ) as Record<string, unknown> | undefined;
      if (converted) {
        // Convert job name from camelCase to kebab-case for YAML
        const yamlName = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
        sections.push(`${yamlName}:` + emitYAML(converted, 1));
      }
    }

    return sections.join("\n\n") + "\n";
  },
};
