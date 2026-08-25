/**
 * The unobserved gate predicate (#1568): a plan containing unobserved
 * entities must not pass as clean.
 *
 * `buildChangeSet` (./change-set.ts) already refuses to guess when a lexicon
 * could not look (#1089) — entries land as `action: "unobserved"`, carrying a
 * total `unobservedReason` (`read-failed`, `no-credentials`, `no-binding`,
 * `unsupported-kind`, `filtered`; see ../observation.ts). But nothing
 * downstream is *required* to look: a gate that checks lint-clean,
 * owned-only, and a blast-radius budget can walk right past a change set
 * whose live read partially failed and call it clean, because none of those
 * checks reads `unobserved` at all. A gate over an incomplete read is a gate
 * over a guess.
 *
 * This is a reusable predicate, not a runtime — evaluate a `ChangeSet`
 * against a policy and get back a verdict; the caller (a `lint.policies`
 * check routed through `policyGate`, an Op step, #1487's gate-as-fact once it
 * lands) decides what to do with a refusal (throw, diagnostic, a durable
 * gated-run fact). Same instinct #1484 already adopts for `unknown` in the
 * operating loop ("`unknown` never remediates"), surfaced here as something
 * any gate can declare rather than a property of one runtime.
 */
import type { ChangeSet } from "./change-set";
import { unobservedReasonText, type UnobservedReason } from "../observation";

/**
 * How the gate treats the change set's unobserved set.
 *
 * - `"refuse"` (the default) — any unobserved entry not covered by `allow`
 *   fails the gate outright. Fail-closed, the right default for a policy set
 *   aimed at agent-proposed change sets: a hole must never launder into a
 *   clean verdict just because nobody configured otherwise.
 * - `"escalate"` — the gate does not fail here; instead the verdict reports
 *   `escalate: true` so a caller can route the plan to a stricter gate class
 *   rather than the ordinary path (the same shape of routing decision #1569
 *   makes for pipeline changes).
 * - `{ allow: [...] }` — the listed reasons are tolerated (e.g. `"filtered"`,
 *   intentional in a scoped run) and never fail or escalate the gate; any
 *   reason NOT in the list still refuses. `no-credentials` — a hole that must
 *   never launder into a clean verdict — should never appear in an `allow`
 *   list for a policy aimed at agent-proposed change sets.
 */
export type UnobservedGatePolicy = "refuse" | "escalate" | { allow: UnobservedReason[] };

/** One unobserved hole the gate found, carried into the refusal. */
export interface UnobservedGateFinding {
  name: string;
  type?: string;
  reason: UnobservedReason;
  detail?: string;
}

export interface UnobservedGateVerdict {
  /** False when the policy is `"refuse"` (default) and an unallowed unobserved entry exists. */
  pass: boolean;
  /** True when the policy is `"escalate"` and an unallowed unobserved entry exists — route to a stricter gate instead of failing here. */
  escalate: boolean;
  /** Every unobserved entry the policy did not allow. Empty when `pass` is true and `escalate` is false. */
  findings: UnobservedGateFinding[];
  /** Human-readable summary carrying the reasons into a refusal — the message a caller can surface as-is. Undefined when `findings` is empty. */
  detail?: string;
}

/**
 * Evaluate a `ChangeSet`'s unobserved set against `policy`. Pure — reads only
 * `cs.entries`, no I/O. Defaults to `"refuse"`.
 */
export function evaluateUnobservedGate(
  cs: ChangeSet,
  policy: UnobservedGatePolicy = "refuse",
): UnobservedGateVerdict {
  const allowed = typeof policy === "object" ? new Set(policy.allow) : undefined;

  const findings: UnobservedGateFinding[] = [];
  for (const e of cs.entries) {
    if (e.action !== "unobserved" || e.unobservedReason === undefined) continue;
    if (allowed?.has(e.unobservedReason)) continue;
    findings.push({
      name: e.name,
      ...(e.type ? { type: e.type } : {}),
      reason: e.unobservedReason,
      ...(e.unobservedDetail ? { detail: e.unobservedDetail } : {}),
    });
  }

  if (findings.length === 0) {
    return { pass: true, escalate: false, findings: [] };
  }

  const detail =
    `plan contains ${findings.length} unobserved ${findings.length === 1 ? "entity" : "entities"} — ` +
    findings
      .map((f) => `${f.name}${f.type ? ` (${f.type})` : ""}: ${unobservedReasonText(f.reason)}${f.detail ? ` (${f.detail})` : ""}`)
      .join(", ");

  if (policy === "escalate") {
    return { pass: true, escalate: true, findings, detail };
  }

  // "refuse" (default) and `{ allow }` both fail closed on anything not allowed.
  return { pass: false, escalate: false, findings, detail };
}
