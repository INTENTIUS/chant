/**
 * Cedar as a gate's approval policy (chant#2508).
 *
 * Two halves, one per side of the build:
 *
 * - {@link gatePolicy} renders a set of cedar `Policy` declarables to Cedar
 *   text at authoring time and returns core's `GatePolicyRef`, plain data that
 *   lands in the Op's build output. A gate names it as `approval.policy`.
 * - {@link evaluateGatePolicy} is what core's `loadGatePolicyEvaluator("cedar")`
 *   imports from `@intentius/chant-lexicon-cedar/gate-policy`. `chant approve`
 *   calls it once per approval with a `PassGate` request, through the same
 *   `cedar-wasm` the post-synth checks load (`./lint/post-synth/wasm-helpers.ts`).
 *
 * The request uses these entity types, so a policy is written against them:
 *
 * | Position  | Entity                                   | Attributes / parents |
 * |-----------|------------------------------------------|----------------------|
 * | principal | `Chant::Human::"<name>"` or `Chant::Agent::"<name>"` | parents: one `Chant::Role::"<role>"` per claimed role |
 * | action    | `Chant::Action::"PassGate"`              | |
 * | resource  | `Chant::Gate::"<op>/<gate>"`             | `op`, `gate` |
 * | context   | `planDigest` when the gate binds a plan, plus the gate's `approval.context` | |
 *
 * So `principal is Chant::Agent` picks out an agent, `principal in
 * Chant::Role::"maintainer"` a role, and `context.risk == "low"` a declared
 * plan attribute.
 */

import type { Declarable } from "@intentius/chant/declarable";
import {
  gatePolicyVersion,
  type GatePolicyAnswer,
  type GatePolicyRef,
  type GatePolicyRequest,
} from "@intentius/chant/op";
import { getProps, resolvePolicyId } from "./policy-text";
import { CEDAR_POLICY_TYPE, renderPolicyText } from "./serializer";
import { describeError, loadWasm, wasmLoadError } from "./lint/post-synth/wasm-helpers";

export const GATE_HUMAN_TYPE = "Chant::Human";
export const GATE_AGENT_TYPE = "Chant::Agent";
export const GATE_ROLE_TYPE = "Chant::Role";
export const GATE_RESOURCE_TYPE = "Chant::Gate";
/** `action == Chant::Action::"PassGate"`, ready for a `Policy`'s `action` scope. */
export const PASS_GATE_ACTION = 'Chant::Action::"PassGate"';

/** The policies a gate policy set is made of: one, a list, or a record whose keys become their logical names. */
export type GatePolicies = Declarable | readonly Declarable[] | Readonly<Record<string, Declarable>>;

function entries(name: string, policies: GatePolicies): Array<[string, Declarable]> {
  if (Array.isArray(policies)) {
    return (policies as readonly Declarable[]).map((p, i) => [`${name}-${i}`, p]);
  }
  if (isDeclarable(policies)) return [[name, policies]];
  return Object.entries(policies as Record<string, Declarable>);
}

function isDeclarable(value: unknown): value is Declarable {
  return typeof value === "object" && value !== null && "entityType" in value;
}

/**
 * A gate policy set from cedar `Policy` declarables. `name` is recorded with
 * every decision; ids come from each policy's `annotations.id`, else its
 * record key, else `<name>-<index>`.
 *
 * Throws when a member is not a cedar policy, or when the rendered set does
 * not parse, so a broken policy fails where it is written and not at the
 * first `chant approve`.
 *
 * @example
 * ```ts
 * export const shipPolicy = gatePolicy("ship", {
 *   agentLowRisk: new Policy({
 *     effect: "permit",
 *     principal: { is: GATE_AGENT_TYPE },
 *     action: { eq: PASS_GATE_ACTION },
 *     when: ['context.risk == "low"'],
 *   }),
 * });
 * ```
 */
export function gatePolicy(name: string, policies: GatePolicies): GatePolicyRef {
  const members = entries(name, policies);
  if (members.length === 0) throw new Error(`gatePolicy("${name}"): the policy set is empty`);

  const texts = members.map(([logical, entity]) => {
    if (entity.entityType !== CEDAR_POLICY_TYPE) {
      throw new Error(
        `gatePolicy("${name}"): "${logical}" is a ${entity.entityType}, not a ${CEDAR_POLICY_TYPE}`,
      );
    }
    const props = getProps(entity);
    return renderPolicyText(resolvePolicyId(logical, props), props);
  });
  const text = texts.join("\n\n") + "\n";

  const wasm = loadWasm();
  if (wasm) {
    const parsed = wasm.checkParsePolicySet({ staticPolicies: text });
    if (parsed.type === "failure") {
      throw new Error(
        `gatePolicy("${name}"): the policy set does not parse: ${parsed.errors.map(describeError).join("; ")}`,
      );
    }
  }

  return { kind: "gate-policy", lexicon: "cedar", name, version: gatePolicyVersion(text), text };
}

type CedarValue = string | number | boolean | CedarValue[] | { [key: string]: CedarValue };

/** A context value as Cedar JSON. Cedar has no floats or null, so those become strings or are dropped. */
function cedarValue(value: unknown): CedarValue | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isInteger(value) ? value : String(value);
  if (Array.isArray(value)) {
    return value.map(cedarValue).filter((v): v is CedarValue => v !== undefined);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, CedarValue> = {};
    for (const [k, v] of Object.entries(value)) {
      const converted = cedarValue(v);
      if (converted !== undefined) out[k] = converted;
    }
    return out;
  }
  return undefined;
}

/**
 * The set as a record keyed by each policy's `@id`. Handed the text whole,
 * cedar-wasm names policies by position (`policy0`), and a recorded decision
 * would then name a rule nobody wrote. A policy with no `@id` keeps its
 * positional name.
 */
function keyedById(wasm: NonNullable<ReturnType<typeof loadWasm>>, policy: GatePolicyRef): Record<string, string> {
  const parts = wasm.policySetTextToParts(policy.text);
  if (parts.type === "failure") {
    throw new Error(`policy "${policy.name}" does not parse: ${parts.errors.map(describeError).join("; ")}`);
  }
  const keyed: Record<string, string> = {};
  parts.policies.forEach((text, index) => {
    const id = /@id\(\s*"((?:[^"\\]|\\.)*)"\s*\)/.exec(text)?.[1] ?? `policy${index}`;
    if (id in keyed) throw new Error(`policy "${policy.name}" has two policies with id "${id}"`);
    keyed[id] = text;
  });
  return keyed;
}

/**
 * Evaluate one `PassGate` request. Called by core through
 * `loadGatePolicyEvaluator("cedar")`; see the module doc for the entity model.
 *
 * Throws when the wasm cannot be loaded or the request cannot be evaluated at
 * all, so `chant approve` refuses rather than recording a decision nobody
 * made. A policy that errors on this request is reported in `errors` and does
 * not apply, which is Cedar's own rule.
 */
export function evaluateGatePolicy(policy: GatePolicyRef, request: GatePolicyRequest): GatePolicyAnswer {
  const wasm = loadWasm();
  if (!wasm) throw new Error(`@cedar-policy/cedar-wasm could not be loaded: ${wasmLoadError()}`);

  const principalType = request.principal.kind === "agent" ? GATE_AGENT_TYPE : GATE_HUMAN_TYPE;
  const roles = [...new Set(request.principal.roles)];
  const principal = { type: principalType, id: request.principal.name };
  const resource = { type: GATE_RESOURCE_TYPE, id: `${request.resource.op}/${request.resource.gate}` };

  const answer = wasm.isAuthorized({
    principal,
    action: { type: "Chant::Action", id: request.action },
    resource,
    context: (cedarValue(request.context) ?? {}) as Record<string, never>,
    policies: { staticPolicies: keyedById(wasm, policy) },
    entities: [
      { uid: principal, attrs: {}, parents: roles.map((id) => ({ type: GATE_ROLE_TYPE, id })) },
      ...roles.map((id) => ({ uid: { type: GATE_ROLE_TYPE, id }, attrs: {}, parents: [] })),
      { uid: resource, attrs: { op: request.resource.op, gate: request.resource.gate }, parents: [] },
    ],
  });

  if (answer.type === "failure") {
    throw new Error(`policy "${policy.name}" could not be evaluated: ${answer.errors.map(describeError).join("; ")}`);
  }
  const { decision, diagnostics } = answer.response;
  return {
    decision,
    determining: [...diagnostics.reason].sort(),
    errors: diagnostics.errors.map((e) => `${e.policyId}: ${describeError(e.error)}`),
  };
}
