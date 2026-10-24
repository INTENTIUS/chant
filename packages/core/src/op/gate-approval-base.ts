/**
 * The parts of an Op gate's approval that an `identity.gates.<gate>` entry
 * also carries (#4404): the modes, the policy check and the entry check. Its
 * only runtime import is `node:crypto`, so `gate-decision.ts` (which checks an
 * entry) bundles without the Op runtime or zod (gate-decision-bundle.test.ts).
 * `gate-approval.ts` re-exports everything here.
 */

import { createHash } from "node:crypto";
import { GATE_PLAN_CONTEXT_KEY } from "./gate-plan-context";
import type { GateApprovalMode, GatePolicyRef } from "./gate-approval";

export const GATE_APPROVAL_MODES: readonly GateApprovalMode[] = ["log-only", "enforce"];

// The brand `stepOutput()` stamps (`step-output-ref.ts`), as a global symbol so
// this module need not import that file and its zod schemas; the same copy
// `activity-contract.ts` keeps for the same reason.
const STEP_OUTPUT_REF_BRAND = Symbol.for("chant.op.stepOutputRef");
function isStepOutputRef(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[STEP_OUTPUT_REF_BRAND] === true;
}

/** The version of a gate policy: `sha256:` and the hex digest of its text. A lexicon's helper stamps it, and OPS015 checks it still matches. */
export function gatePolicyVersion(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
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
 * What is wrong with the `policy`, `mode` and `context` of an
 * `identity.gates.<gate>` entry (#4404), one line each, named by `at`. Each
 * field stands alone: base `mode: "enforce"` with no base `policy` is fine, as
 * the Op's own policy then applies. `chant workspace check` (WSP153) says so.
 */
export function gateBaseApprovalProblems(entry: { policy?: unknown; mode?: unknown; context?: unknown }, at: string): string[] {
  const problems: string[] = [];
  if (entry.policy !== undefined) {
    if (!isGatePolicyRef(entry.policy)) problems.push(`\`${at}.policy\` does not resolve to a gate policy set: it needs kind "gate-policy", lexicon, name, version and text`);
    else if (entry.policy.version !== gatePolicyVersion(entry.policy.text)) problems.push(`\`${at}.policy\` "${entry.policy.name}" has a version that is not the digest of its text`);
  }
  if (entry.mode !== undefined && !GATE_APPROVAL_MODES.includes(entry.mode as GateApprovalMode)) {
    problems.push(`\`${at}.mode\` must be one of ${GATE_APPROVAL_MODES.map((m) => `"${m}"`).join(", ")}`);
  }
  if (entry.context !== undefined) {
    if (typeof entry.context !== "object" || entry.context === null || Array.isArray(entry.context)) problems.push(`\`${at}.context\` must be an object of plan attributes`);
    else {
      for (const [key, value] of Object.entries(entry.context)) {
        if (key === GATE_PLAN_CONTEXT_KEY) problems.push(`\`${at}.context.${key}\` is reserved: the run fills it with the plan's change-set summary (#3182)`);
        else if (isStepOutputRef(value) || !isContextValue(value)) problems.push(`\`${at}.context.${key}\` must be a string, number, boolean or list of strings`);
      }
    }
  }
  return problems;
}

export function isContextValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => typeof v === "string");
  return isStepOutputRef(value);
}
