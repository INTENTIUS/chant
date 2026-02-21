/**
 * EXT001: Extension Constraint Violation
 *
 * Validates CloudFormation resource properties against cross-property
 * constraints from cfn-lint extension schemas.
 *
 * Constraint types:
 * - if_then: if condition properties match, then requirement must hold
 * - dependent_excluded: if property A exists, property B must not
 * - required_or: at least one of the listed properties must exist
 * - required_xor: exactly one of the listed properties must exist
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseCFTemplate, type CFResource } from "./cf-refs";

interface ExtensionConstraint {
  name: string;
  type: "if_then" | "dependent_excluded" | "required_or" | "required_xor";
  condition?: unknown;
  requirement?: unknown;
}

interface LexiconEntry {
  kind: string;
  cfn?: string;
  constraints?: ExtensionConstraint[];
  [key: string]: unknown;
}

/**
 * Load lexicon JSON to get constraints per resource type.
 */
function loadLexiconConstraints(): Map<string, ExtensionConstraint[]> {
  const map = new Map<string, ExtensionConstraint[]>();
  try {
    // Navigate from src/lint/post-synth/ up to the package root
    const pkgDir = join(__dirname, "..", "..", "..");
    const lexiconPath = join(pkgDir, "src", "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.kind === "resource" && entry.cfn && entry.constraints && entry.constraints.length > 0) {
        map.set(entry.cfn, entry.constraints);
      }
    }
  } catch {
    // Lexicon not available — skip constraint checking
  }
  return map;
}

/**
 * Check if a JSON schema "if" condition matches resource properties.
 */
function matchesCondition(condition: unknown, properties: Record<string, unknown>): boolean {
  if (!condition || typeof condition !== "object") return false;
  const cond = condition as Record<string, unknown>;

  // { properties: { PropName: { const: value } } }
  if (cond.properties && typeof cond.properties === "object") {
    const condProps = cond.properties as Record<string, unknown>;
    for (const [propName, schema] of Object.entries(condProps)) {
      if (!schema || typeof schema !== "object") continue;
      const s = schema as Record<string, unknown>;

      if ("const" in s) {
        if (properties[propName] !== s.const) return false;
      }
      if ("enum" in s && Array.isArray(s.enum)) {
        if (!s.enum.includes(properties[propName])) return false;
      }
    }
  }

  // { required: ["PropName"] } — check the properties exist
  if (Array.isArray(cond.required)) {
    for (const req of cond.required) {
      if (!(req in properties)) return false;
    }
  }

  return true;
}

/**
 * Check if a JSON schema "then" requirement holds for resource properties.
 */
function checkRequirement(requirement: unknown, properties: Record<string, unknown>): string | null {
  if (!requirement || typeof requirement !== "object") return null;
  const req = requirement as Record<string, unknown>;

  // { required: ["PropName"] }
  if (Array.isArray(req.required)) {
    const missing = req.required.filter((r: string) => !(r in properties));
    if (missing.length > 0) {
      return `missing required properties: ${missing.join(", ")}`;
    }
  }

  return null;
}

function validateResource(
  logicalId: string,
  resource: CFResource,
  constraints: ExtensionConstraint[],
): PostSynthDiagnostic[] {
  const diagnostics: PostSynthDiagnostic[] = [];
  const props = resource.Properties ?? {};

  for (const constraint of constraints) {
    switch (constraint.type) {
      case "if_then": {
        if (matchesCondition(constraint.condition, props)) {
          const error = checkRequirement(constraint.requirement, props);
          if (error) {
            diagnostics.push({
              checkId: "EXT001",
              severity: "error",
              message: `Resource "${logicalId}" (${resource.Type}): constraint "${constraint.name}" violated — ${error}`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
        break;
      }

      case "dependent_excluded": {
        // { PropA: ["PropB", "PropC"] } — if PropA exists, PropB and PropC must not
        const req = constraint.requirement as Record<string, string[]> | undefined;
        if (req) {
          for (const [propName, excluded] of Object.entries(req)) {
            if (propName in props) {
              const present = excluded.filter((e) => e in props);
              if (present.length > 0) {
                diagnostics.push({
                  checkId: "EXT001",
                  severity: "error",
                  message: `Resource "${logicalId}" (${resource.Type}): "${propName}" excludes [${present.join(", ")}] but both are present`,
                  entity: logicalId,
                  lexicon: "aws",
                });
              }
            }
          }
        }
        break;
      }

      case "required_or": {
        // ["PropA", "PropB"] — at least one must exist
        const required = constraint.requirement as string[] | undefined;
        if (required && Array.isArray(required)) {
          const present = required.filter((r) => r in props);
          if (present.length === 0) {
            diagnostics.push({
              checkId: "EXT001",
              severity: "error",
              message: `Resource "${logicalId}" (${resource.Type}): at least one of [${required.join(", ")}] must be specified`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
        break;
      }

      case "required_xor": {
        // ["PropA", "PropB"] — exactly one must exist
        const required = constraint.requirement as string[] | undefined;
        if (required && Array.isArray(required)) {
          const present = required.filter((r) => r in props);
          if (present.length !== 1) {
            diagnostics.push({
              checkId: "EXT001",
              severity: "error",
              message: `Resource "${logicalId}" (${resource.Type}): exactly one of [${required.join(", ")}] must be specified (found ${present.length})`,
              entity: logicalId,
              lexicon: "aws",
            });
          }
        }
        break;
      }
    }
  }

  return diagnostics;
}

export const ext001: PostSynthCheck = {
  id: "EXT001",
  description: "Extension constraint violation — cross-property validation from cfn-lint extension schemas",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const lexiconConstraints = loadLexiconConstraints();
    if (lexiconConstraints.size === 0) return [];

    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseCFTemplate(output);
      if (!template?.Resources) continue;

      for (const [logicalId, resource] of Object.entries(template.Resources)) {
        const constraints = lexiconConstraints.get(resource.Type);
        if (!constraints) continue;

        diagnostics.push(...validateResource(logicalId, resource, constraints));
      }
    }

    return diagnostics;
  },
};
