/**
 * GitLab CI YAML parser for `chant import`.
 *
 * Parses an existing .gitlab-ci.yml file into the core TemplateIR format,
 * mapping GitLab CI constructs to resources and property types.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import { parseYAML } from "@intentius/chant/yaml";

/**
 * Reserved top-level keys in .gitlab-ci.yml that are NOT job definitions.
 */
/**
 * Convert snake_case to camelCase — used only for TS variable names (logicalId),
 * NOT for spec property names.
 */
function snakeToCamelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const RESERVED_KEYS = new Set([
  "stages",
  "variables",
  "default",
  "workflow",
  "include",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "pages",
]);


/**
 * GitLab CI YAML parser implementation.
 */
export class GitLabParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const doc = parseYAML(content);
    const resources: ResourceIR[] = [];

    // Extract default
    if (doc.default && typeof doc.default === "object") {
      resources.push({
        logicalId: "defaults",
        type: "GitLab::CI::Default",
        properties: doc.default as Record<string, unknown>,
      });
    }

    // Extract workflow
    if (doc.workflow && typeof doc.workflow === "object") {
      resources.push({
        logicalId: "workflow",
        type: "GitLab::CI::Workflow",
        properties: doc.workflow as Record<string, unknown>,
      });
    }

    // Extract jobs — any top-level key not in RESERVED_KEYS
    for (const [key, value] of Object.entries(doc)) {
      if (RESERVED_KEYS.has(key)) continue;
      if (typeof value !== "object" || value === null) continue;

      // Check if it looks like a job (has script, stage, trigger, extends, etc.)
      const obj = value as Record<string, unknown>;
      if (
        obj.script !== undefined ||
        obj.stage !== undefined ||
        obj.trigger !== undefined ||
        obj.extends !== undefined ||
        obj.rules !== undefined ||
        obj.needs !== undefined
      ) {
        resources.push({
          logicalId: snakeToCamelCase(key.replace(/-/g, "_")),
          type: "GitLab::CI::Job",
          properties: obj as Record<string, unknown>,
          metadata: {
            originalName: key,
            stage: typeof obj.stage === "string" ? obj.stage : undefined,
          },
        });
      }
    }

    // Record include references as metadata
    const metadata: Record<string, unknown> = {};
    if (doc.stages) metadata.stages = doc.stages;
    if (doc.include) metadata.include = doc.include;
    if (doc.variables) metadata.variables = doc.variables;

    return {
      resources,
      parameters: [], // GitLab CI doesn't have parameters like CFN
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
  }
}
