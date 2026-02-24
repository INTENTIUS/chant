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
import { emitYAML } from "@intentius/chant/yaml";

/**
 * GitLab CI visitor for the generic serializer walker.
 */
function gitlabVisitor(entityNames: Map<Declarable, string>): SerializerVisitor {
  return {
    attrRef: (name, _attr) => name,
    resourceRef: (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
    propertyDeclarable: (entity, walk) => {
      if (!("props" in entity) || typeof entity.props !== "object" || entity.props === null) {
        return undefined;
      }
      const props = entity.props as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined) {
          result[key] = walk(value);
        }
      }
      return Object.keys(result).length > 0 ? result : undefined;
    },
  };
}

/**
 * Pre-process values to convert intrinsics to their YAML representation
 * before the walker (which would call toJSON instead of toYAML).
 *
 * IMPORTANT: Must not touch Declarable objects — their identity markers
 * (DECLARABLE_MARKER, entityType, kind, props) are non-enumerable and
 * would be stripped by Object.entries(), producing empty `{}` output.
 */
function preprocessIntrinsics(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "object" && INTRINSIC_MARKER in value) {
    if ("toYAML" in value && typeof value.toYAML === "function") {
      return (value as { toYAML(): unknown }).toYAML();
    }
  }

  // Leave Declarables untouched — the walker handles them
  if (typeof value === "object" && value !== null && "entityType" in value) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(preprocessIntrinsics);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = preprocessIntrinsics(v);
    }
    return result;
  }

  return value;
}

/**
 * Convert a value to YAML-compatible form using the walker.
 */
function toYAMLValue(value: unknown, entityNames: Map<Declarable, string>): unknown {
  const preprocessed = preprocessIntrinsics(value);
  return walkValue(preprocessed, entityNames, gitlabVisitor(entityNames));
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
