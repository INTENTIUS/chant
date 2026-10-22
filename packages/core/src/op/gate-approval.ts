/**
 * Gate approval policy as data (#2508).
 *
 * A gate used to pass on one recorded approval. This module lets a gate say
 * more than that, as data that survives into the build output:
 *
 * - `quorum`: how many distinct human approvers the gate needs, and
 *   optionally which roles count toward it. Since #4290 it may be a list of
 *   rules, each scoped by `targets` globs over the run's environment
 *   (`./gate-quorum.ts`).
 * - `policy`: a policy set a lexicon rendered (the cedar lexicon's
 *   `gatePolicy()`), evaluated for each approval as a `PassGate` request.
 * - `mode`: `"log-only"` records the policy's decision next to the approval
 *   and lets only the quorum bind. `"enforce"` lets a permit pass the gate on
 *   its own, which is how an agent principal passes a low-risk plan.
 * - `context`: plan attributes handed to the policy (risk labels, changed
 *   paths), resolved at run time like a gate's `plan`. A gate whose `plan`
 *   names a step that returned a change set also gets `context.plan`, that
 *   change set's summary (#3182, `./gate-plan-context.ts`).
 *
 * Core does not know Cedar. A {@link GatePolicyRef} names the lexicon that
 * made it, and {@link loadGatePolicyEvaluator} imports that lexicon's
 * `gate-policy` module by the same `@intentius/chant-lexicon-<name>/...`
 * convention the activity registry uses (`./activity-registry.ts`).
 *
 * The policy is evaluated when an approval is recorded (`chant approve`),
 * because that is the moment the approver is known. The decision is written
 * on the resolution with the policy's version, and a run counts a recorded
 * permit only while the gate still declares that same version. Editing the
 * policy invalidates every permit recorded under the old one, the way a new
 * plan invalidates every approval recorded for the old plan (#2300). The
 * decision also records the digest of the context it was asked about, and a
 * permit counts only while the run resolves that same context (#3774).
 *
 * A resolution is a local fact, not a signed one (`../lifecycle/gate-ledger.ts`).
 * Roles on it are what the approver claimed, and since #4290 the quorum
 * never reads them: a role counts only when `.chant/trust.json` at base
 * grants it and a seal proves the approver (`./gate-quorum.ts`). A policy
 * still sees the claimed roles in its request.
 */

import { createHash } from "node:crypto";
import { lexiconModulePath, importLexiconPackage } from "../lexicon-module";
import { isStepOutputRef, type StepOutputRef } from "./step-output-ref";
import { GATE_PLAN_CONTEXT_KEY } from "./gate-plan-context";
import { quorumProblems, type GateQuorumRule, type GateQuorumSpec } from "./gate-quorum";

export type { GateQuorumRule, GateQuorumSpec } from "./gate-quorum";

/** What a policy's decision does to the gate. */
export type GateApprovalMode = "log-only" | "enforce";

export const GATE_APPROVAL_MODES: readonly GateApprovalMode[] = ["log-only", "enforce"];

/**
 * A policy set a lexicon rendered for a gate — plain data, so it lands in the
 * Op's build output unchanged. Build one with the owning lexicon's helper
 * (the cedar lexicon's `gatePolicy()`) rather than by hand.
 */
export interface GatePolicyRef {
  kind: "gate-policy";
  /** The lexicon whose `gate-policy` module evaluates {@link GatePolicyRef.text}. */
  lexicon: string;
  /** A name for the policy set, carried into every recorded decision. */
  name: string;
  /** Content digest of {@link GatePolicyRef.text}. A recorded permit counts only under the version it was evaluated against. */
  version: string;
  /** The policy set, in the lexicon's own language. */
  text: string;
}

/**
 * How many distinct human approvers a gate needs, and which roles count: one
 * approval rule (#4290, `./gate-quorum.ts`). A role counts only when
 * `.chant/trust.json` at base grants it to a proven approver.
 */
export type GateQuorum = GateQuorumRule;

/** A value a gate hands its policy as context. */
export type GateContextValue = string | number | boolean | string[] | StepOutputRef;

/** The `approval` block on a `gate` step. */
export interface GateApproval {
  /** One rule, or a list of rules scoped by `targets` over the run's environment (#4290). */
  quorum?: GateQuorumSpec;
  policy?: GatePolicyRef;
  /** Default `"log-only"`, so a new policy is observed against real gate traffic before it binds. */
  mode?: GateApprovalMode;
  /**
   * Plan attributes handed to the policy as Cedar `context`. A {@link StepOutputRef} is resolved at run time.
   *
   * `plan` is reserved (#3182): when the gate's `plan` names a step that
   * returned a change set (`terraformPlan`, `composeChangeSet`, ...), the run
   * puts that change set's `GatePlanSummary` there on its own.
   */
  context?: Record<string, GateContextValue>;
}

/**
 * {@link GateApproval} as a run resolved it: context references replaced with
 * the values they pointed at, mode defaulted. This is what a pending fact
 * carries, so `chant approve` evaluates the policy against the plan the run
 * actually produced.
 */
export interface ResolvedGateApproval {
  /** The rules this run's gate takes (#4290): a list, or one rule on a fact written before. */
  quorum?: GateQuorumSpec;
  policy?: GatePolicyRef;
  mode: GateApprovalMode;
  context?: Record<string, unknown>;
}

/** Who recorded an approval. Absent on every resolution written before #2508, which reads as a human with no roles. */
export interface GateApprover {
  kind: "human" | "agent";
  roles?: string[];
}

/** One `PassGate` question put to a policy. */
export interface GatePolicyRequest {
  principal: { kind: GateApprover["kind"]; name: string; roles: string[] };
  action: "PassGate";
  resource: { op: string; gate: string };
  /** The plan digest, when the gate binds one, plus the gate's declared context. */
  context: Record<string, unknown>;
}

/** What a lexicon's evaluator answers. */
export interface GatePolicyAnswer {
  decision: "allow" | "deny";
  /** Ids of the policies that determined the decision. */
  determining: string[];
  /** Per-policy evaluation errors. A policy that errors does not apply. */
  errors: string[];
}

/** A policy's decision, as recorded on a resolution. */
export interface GatePolicyDecision extends GatePolicyAnswer {
  policy: string;
  version: string;
  /**
   * The gate's mode when the decision was recorded. A permit passes a gate
   * only when both this and the gate's current mode are `enforce` (#2512), so
   * an allow recorded under `log-only` never binds after a switch.
   */
  mode: GateApprovalMode;
  /**
   * {@link gateContextDigest} of the resolved context the policy was asked
   * about (#3774). A permit passes a gate only while the run's resolved
   * context has this same digest, so a permit given for `risk: "low"` does
   * not pass a run that now resolves `risk: "high"`. A decision recorded
   * before #3774 has none and does not pass an enforced gate.
   */
  contextDigest?: string;
}

/** What a lexicon's `gate-policy` module exports. */
export interface GatePolicyEvaluator {
  evaluateGatePolicy(policy: GatePolicyRef, request: GatePolicyRequest): Promise<GatePolicyAnswer> | GatePolicyAnswer;
}

/** The version of a gate policy: `sha256:` and the hex digest of its text. A lexicon's helper stamps it, and OPS015 checks it still matches. */
export function gatePolicyVersion(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * The digest of a gate's resolved approval context (#3774): `sha256:` and the
 * hex digest of its JSON with keys sorted at every level. No context and an
 * empty one digest the same.
 */
export function gateContextDigest(context: Record<string, unknown> | undefined): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(context ?? {}, sortedKeys)).digest("hex")}`;
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return value;
}

export function isGatePolicyRef(value: unknown): value is GatePolicyRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "gate-policy" &&
    typeof v.lexicon === "string" && v.lexicon !== "" &&
    typeof v.name === "string" && v.name !== "" &&
    typeof v.version === "string" && v.version !== "" &&
    typeof v.text === "string" && v.text.trim() !== ""
  );
}

/**
 * Everything wrong with an `approval` block, one line each. The `gate()`
 * builder throws on the first; OPS015 reports all of them over the build
 * output, where a block could have been written without the builder.
 */
export function gateApprovalProblems(approval: unknown): string[] {
  if (typeof approval !== "object" || approval === null || Array.isArray(approval)) {
    return ["`approval` must be an object"];
  }
  const a = approval as Record<string, unknown>;
  const problems: string[] = [];

  if (a.quorum !== undefined) {
    if (typeof a.quorum !== "object" || a.quorum === null) problems.push("`approval.quorum` must be an object or a list of rules");
    else problems.push(...quorumProblems(a.quorum, "approval.quorum", { notAuthor: false }));
  }

  if (a.policy !== undefined) {
    if (!isGatePolicyRef(a.policy)) {
      problems.push(
        "`approval.policy` does not resolve to a gate policy set. Build it with the lexicon's helper, " +
          "for example `gatePolicy(\"ship\", policies)` from @intentius/chant-lexicon-cedar",
      );
    } else if (a.policy.version !== gatePolicyVersion(a.policy.text)) {
      problems.push(
        `\`approval.policy\` "${a.policy.name}" has a version that is not the digest of its text, ` +
          "so a recorded decision could not be traced to the rule that made it",
      );
    }
  }

  if (a.mode !== undefined && !GATE_APPROVAL_MODES.includes(a.mode as GateApprovalMode)) {
    problems.push(`\`approval.mode\` must be one of ${GATE_APPROVAL_MODES.map((m) => `"${m}"`).join(", ")}`);
  }
  if (a.mode === "enforce" && a.policy === undefined) {
    problems.push("`approval.mode: \"enforce\"` needs an `approval.policy` to enforce");
  }

  if (a.context !== undefined) {
    if (typeof a.context !== "object" || a.context === null || Array.isArray(a.context)) {
      problems.push("`approval.context` must be an object of plan attributes");
    } else if (a.policy === undefined) {
      problems.push("`approval.context` is only read by a policy, and this gate declares none");
    } else {
      for (const [key, value] of Object.entries(a.context)) {
        if (key === GATE_PLAN_CONTEXT_KEY) {
          problems.push(
            `\`approval.context.${key}\` is reserved: the run fills it with the plan's change-set summary (#3182) ` +
              "when the gate's `plan` names the step that planned it",
          );
          continue;
        }
        if (!isContextValue(value)) {
          problems.push(
            `\`approval.context.${key}\` must be a string, number, boolean, list of strings, or a step output reference`,
          );
        }
      }
    }
  }

  return problems;
}

function isContextValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => typeof v === "string");
  return isStepOutputRef(value);
}

/** Import `lexicon`'s evaluator. Throws a message that names the package when it is not installed or exports none. */
export async function loadGatePolicyEvaluator(lexicon: string): Promise<GatePolicyEvaluator> {
  // chant #2520 — a lexicon declared by module path exports its evaluator from that module.
  const spec = lexiconModulePath(lexicon) ?? `@intentius/chant-lexicon-${lexicon}/gate-policy`;
  let mod: Partial<GatePolicyEvaluator>;
  try {
    mod = (await importLexiconPackage(spec)) as Partial<GatePolicyEvaluator>;
  } catch (err) {
    throw new Error(
      `the gate's policy is evaluated by ${spec}, which could not be loaded: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (typeof mod.evaluateGatePolicy !== "function") {
    throw new Error(`${spec} exports no evaluateGatePolicy function`);
  }
  return mod as GatePolicyEvaluator;
}

/** The request a policy is asked about one approval. */
export function gatePolicyRequest(input: {
  op: string;
  gate: string;
  resolvedBy: string;
  approver: GateApprover;
  planDigest?: string;
  context?: Record<string, unknown>;
}): GatePolicyRequest {
  return {
    principal: { kind: input.approver.kind, name: input.resolvedBy, roles: input.approver.roles ?? [] },
    action: "PassGate",
    resource: { op: input.op, gate: input.gate },
    context: {
      ...(input.context ?? {}),
      ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
    },
  };
}
