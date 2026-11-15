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
import { moduleSourceDir } from "@intentius/chant/module-source";
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { isIntrinsic, parseCFTemplate, type CFResource } from "./cf-refs";

export interface ExtensionConstraint {
  name: string;
  type: "if_then" | "dependent_excluded" | "required_or" | "required_xor";
  condition?: unknown;
  requirement?: unknown;
}

interface LexiconEntry {
  kind: string;
  resourceType: string;
  constraints?: ExtensionConstraint[];
  [key: string]: unknown;
}

/**
 * Load lexicon JSON to get constraints per resource type.
 */
function loadLexiconConstraints(): Map<string, ExtensionConstraint[]> {
  const map = new Map<string, ExtensionConstraint[]>();
  try {
    // From src/lint/post-synth/ (or its compiled twin under dist/) to src/generated/
    const lexiconPath = join(moduleSourceDir(import.meta.url), "..", "..", "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.kind === "resource" && entry.resourceType && entry.constraints && entry.constraints.length > 0) {
        map.set(entry.resourceType, entry.constraints);
      }
    }
  } catch {
    // Lexicon not available — skip constraint checking
  }
  return map;
}

/**
 * Three-valued result of evaluating a JSON schema against a value: true (the
 * schema holds), false (it does not), undefined (it cannot be decided from the
 * template alone). A condition fires a finding only on `true`, so an
 * undecidable one stays silent. A wrong finding costs more than a missed one
 * here, and an error-severity rule stops the build.
 */
type Verdict = boolean | undefined;

/** Keywords that describe a schema and never change what it accepts. */
const ANNOTATION_KEYWORDS = new Set([
  "title", "description", "$comment", "$schema", "$id", "examples", "default", "deprecated",
]);

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Combine the verdicts of keywords that must all hold. */
function all(verdicts: Verdict[]): Verdict {
  if (verdicts.includes(false)) return false;
  if (verdicts.includes(undefined)) return undefined;
  return true;
}

function matchesType(type: string, value: unknown): Verdict {
  switch (type) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "number": return typeof value === "number" ? true : typeof value === "string" ? undefined : false;
    case "integer":
      if (typeof value === "number") return Number.isInteger(value);
      return typeof value === "string" ? undefined : false;
    default: return undefined;
  }
}

/**
 * Evaluate a JSON schema against a present value. Supports the keywords the
 * generated extension constraints use. Any other keyword makes the answer
 * undecidable, and so does a value that is a CloudFormation intrinsic
 * (Ref, Fn::*) where the keyword needs the concrete value.
 *
 * `topLevel` is set for the resource's own Properties object. There a property
 * named by a schema but absent from the resource does not satisfy it, which is
 * how this check has always read conditions (cfn-lint pairs them with
 * `required`); a `false` schema is the one exception and means "absent".
 */
function evalSchema(schema: unknown, value: unknown, topLevel = false): Verdict {
  if (schema === true) return true;
  if (schema === false) return false;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const s = schema as Record<string, unknown>;
  const concrete = !isIntrinsic(value);
  const verdicts: Verdict[] = [];

  for (const [keyword, arg] of Object.entries(s)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue;
    switch (keyword) {
      case "const":
        verdicts.push(concrete ? sameJson(value, arg) : undefined);
        break;
      case "enum":
        verdicts.push(!Array.isArray(arg) ? undefined : concrete ? arg.some((e) => sameJson(value, e)) : undefined);
        break;
      case "pattern": {
        if (typeof arg !== "string" || !concrete || typeof value !== "string") {
          verdicts.push(undefined);
          break;
        }
        try {
          verdicts.push(new RegExp(arg).test(value));
        } catch {
          verdicts.push(undefined); // not a JavaScript regular expression
        }
        break;
      }
      case "type": {
        if (!concrete) {
          verdicts.push(undefined);
          break;
        }
        const types = Array.isArray(arg) ? arg : [arg];
        const results = types.map((t) => (typeof t === "string" ? matchesType(t, value) : undefined));
        verdicts.push(results.includes(true) ? true : results.includes(undefined) ? undefined : false);
        break;
      }
      case "not": {
        const v = evalSchema(arg, value);
        verdicts.push(v === undefined ? undefined : !v);
        break;
      }
      case "allOf":
        verdicts.push(Array.isArray(arg) ? all(arg.map((a) => evalSchema(a, value))) : undefined);
        break;
      case "anyOf": {
        if (!Array.isArray(arg)) {
          verdicts.push(undefined);
          break;
        }
        const results = arg.map((a) => evalSchema(a, value));
        verdicts.push(results.includes(true) ? true : results.includes(undefined) ? undefined : false);
        break;
      }
      case "oneOf": {
        if (!Array.isArray(arg)) {
          verdicts.push(undefined);
          break;
        }
        const results = arg.map((a) => evalSchema(a, value));
        const yes = results.filter((r) => r === true).length;
        const unknown = results.filter((r) => r === undefined).length;
        verdicts.push(yes > 1 ? false : unknown === 0 ? yes === 1 : undefined);
        break;
      }
      case "required": {
        if (!Array.isArray(arg)) {
          verdicts.push(undefined);
          break;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          verdicts.push(concrete ? true : undefined);
          break;
        }
        verdicts.push(arg.every((r) => r in (value as Record<string, unknown>)));
        break;
      }
      case "properties": {
        if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
          verdicts.push(undefined);
          break;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          verdicts.push(concrete ? true : undefined);
          break;
        }
        const obj = value as Record<string, unknown>;
        for (const [name, sub] of Object.entries(arg as Record<string, unknown>)) {
          const present = name in obj;
          if (sub === false) verdicts.push(!present);
          else if (!present) verdicts.push(topLevel ? false : true);
          else verdicts.push(evalSchema(sub, obj[name]));
        }
        break;
      }
      case "minItems":
      case "maxItems": {
        if (typeof arg !== "number" || !concrete) {
          verdicts.push(undefined);
          break;
        }
        if (!Array.isArray(value)) {
          verdicts.push(true);
          break;
        }
        verdicts.push(keyword === "minItems" ? value.length >= arg : value.length <= arg);
        break;
      }
      case "contains": {
        if (!concrete) {
          verdicts.push(undefined);
          break;
        }
        if (!Array.isArray(value)) {
          verdicts.push(true);
          break;
        }
        const results = value.map((item) => evalSchema(arg, item));
        verdicts.push(results.includes(true) ? true : results.includes(undefined) ? undefined : false);
        break;
      }
      case "additionalProperties":
        verdicts.push(arg === true ? true : undefined);
        break;
      default:
        verdicts.push(undefined); // a keyword this check does not evaluate
    }
  }
  return all(verdicts);
}

/**
 * Check if a JSON schema "if" condition matches resource properties. A
 * condition that cannot be decided does not match.
 */
function matchesCondition(condition: unknown, properties: Record<string, unknown>): boolean {
  return evalSchema(condition, properties, true) === true;
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

/**
 * Core detection logic — exported for direct testing with synthetic data.
 */
export function checkExtensionConstraints(
  ctx: PostSynthContext,
  constraintMap: Map<string, ExtensionConstraint[]>,
): PostSynthDiagnostic[] {
  if (constraintMap.size === 0) return [];

  const diagnostics: PostSynthDiagnostic[] = [];

  for (const [_lexicon, output] of ctx.outputs) {
    const template = parseCFTemplate(output);
    if (!template?.Resources) continue;

    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const constraints = constraintMap.get(resource.Type);
      if (!constraints) continue;

      diagnostics.push(...validateResource(logicalId, resource, constraints));
    }
  }

  return diagnostics;
}

export const ext001: PostSynthCheck = {
  id: "EXT001",
  description: "Extension constraint violation — cross-property validation from cfn-lint extension schemas",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    return checkExtensionConstraints(ctx, loadLexiconConstraints());
  },
};
