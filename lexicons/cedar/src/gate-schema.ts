/**
 * The Cedar schema of a gate's `PassGate` request (chant#3182).
 *
 * {@link GATE_CEDAR_SCHEMA} declares the `Chant` namespace `evaluateGatePolicy`
 * builds requests in (`./gate-policy.ts`), with the plan summary core puts in
 * `context.plan` (`@intentius/chant/op`'s `GatePlanSummary`) as the common type
 * `Chant::PlanSummary`. Two uses:
 *
 * - {@link validateGatePolicy} checks a gate policy set against it, so a rule
 *   that reads `context.plan.deleteCount` (a field that does not exist) fails
 *   where it is written rather than erroring on every request.
 * - A project that writes gate policies with typed `Policy` scopes puts this
 *   text in its own `.cedarschema` (or hands {@link gateCedarSchema}'s output
 *   to `new Schema({ text })`), and the generated scope types then name
 *   `Chant::Agent` and `Chant::Action::"PassGate"` without a cast.
 *
 * A gate's own `approval.context` keys differ per gate, so the schema declares
 * only `planDigest` and `plan` unless {@link gateCedarSchema} is told the rest.
 * Every context attribute is optional: a gate with no plan, or a plan step
 * that returned no change set, has neither.
 */

import type { GatePlanSummary, GatePolicyRef } from "@intentius/chant/op";
import { loadWasm, validatePolicySet, wasmLoadError, type ValidationFinding } from "./lint/post-synth/wasm-helpers";
import { keyedById } from "./gate-policy";

/**
 * Each `GatePlanSummary` field as a Cedar type. Typed as a record over the
 * summary's keys, so a field added to the summary in core fails to compile
 * here until the schema says what it is.
 */
export const GATE_PLAN_SUMMARY_CEDAR_TYPES: { readonly [K in keyof GatePlanSummary]: string } = {
  members: "Set<String>",
  membersChanged: "Set<String>",
  failedMembers: "Set<String>",
  failed: "Long",
  holes: "Long",
  entries: "Long",
  changes: "Long",
  creates: "Long",
  updates: "Long",
  replaces: "Long",
  deletes: "Long",
  reads: "Long",
  noOps: "Long",
  forgets: "Long",
  types: "Set<String>",
  createdTypes: "Set<String>",
  updatedTypes: "Set<String>",
  replacedTypes: "Set<String>",
  deletedTypes: "Set<String>",
  deleted: "Set<String>",
  replaced: "Set<String>",
  regions: "Set<String>",
  scopes: "Set<String>",
  lexicons: "Set<String>",
  taggedCreates: "Long",
  untaggedCreates: "Long",
  createTagKeys: "Set<String>",
  tagOnly: "Bool",
  truncated: "Bool",
};

export interface GateCedarSchemaOptions {
  /**
   * The gate's own `approval.context` attributes, as Cedar types
   * (`{ risk: "String", paths: "Set<String>" }`). Each is declared optional,
   * since a step-output reference that resolves to nothing is left out.
   */
  context?: Readonly<Record<string, string>>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The schema text, with the gate's own context attributes when given. */
export function gateCedarSchema(options: GateCedarSchemaOptions = {}): string {
  const extra = Object.entries(options.context ?? {});
  for (const [key, type] of extra) {
    if (!IDENT.test(key)) throw new Error(`gateCedarSchema: context attribute "${key}" is not a Cedar identifier`);
    if (key === "plan" || key === "planDigest") throw new Error(`gateCedarSchema: context attribute "${key}" is chant's own`);
    if (type.trim() === "") throw new Error(`gateCedarSchema: context attribute "${key}" has no type`);
  }
  const summary = Object.entries(GATE_PLAN_SUMMARY_CEDAR_TYPES)
    .map(([k, t]) => `    "${k}": ${t},`)
    .join("\n");
  const context = [
    `      "planDigest"?: String,`,
    `      "plan"?: PlanSummary,`,
    ...extra.map(([k, t]) => `      "${k}"?: ${t},`),
  ].join("\n");
  return `// The request chant builds for a gate approval (chant#2508, #3182).
namespace Chant {
  // context.plan: the plan's change-set summary (GatePlanSummary).
  type PlanSummary = {
${summary}
  };

  // A role a human or agent claimed when approving.
  entity Role;
  entity Human in [Role];
  entity Agent in [Role];
  // "<op>/<gate>".
  entity Gate = {
    "op": String,
    "gate": String,
  };

  action PassGate appliesTo {
    principal: [Human, Agent],
    resource: [Gate],
    context: {
${context}
    }
  };
}
`;
}

/** The schema with no gate-specific context: `planDigest` and `plan` only. */
export const GATE_CEDAR_SCHEMA = gateCedarSchema();

export interface GatePolicyValidation {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
}

/**
 * Validate a gate policy set against the gate schema. Throws when the wasm
 * cannot be loaded or validation cannot run at all (a schema that does not
 * parse); findings come back sorted.
 */
export function validateGatePolicy(policy: GatePolicyRef, options: GateCedarSchemaOptions = {}): GatePolicyValidation {
  const wasm = loadWasm();
  if (!wasm) throw new Error(`@cedar-policy/cedar-wasm could not be loaded: ${wasmLoadError()}`);
  const outcome = validatePolicySet(wasm, { staticPolicies: keyedById(wasm, policy) }, gateCedarSchema(options));
  if (outcome.failure) throw new Error(`policy "${policy.name}" could not be validated: ${outcome.failure}`);
  return { errors: outcome.errors, warnings: outcome.warnings };
}
