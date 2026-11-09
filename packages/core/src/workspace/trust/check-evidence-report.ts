/**
 * Which of the plan job's two named checks, `plan` and `policy`, passed
 * (#4870), read from what the plan job hands its note job, and the line the
 * plan note gets saying which were signed.
 *
 * The policy (Rego, CrossGuard, a product's rules) is evaluated inside the
 * plan, so one job stands for both checks:
 *
 * - `plan` passed when the plan job succeeded and left a report.
 * - `policy` passed when a policy ran and denied nothing that stands: a
 *   `pr-plan.json` whose `policy.result` is `passed` or `held`, or `denied`
 *   with an override; a plan note hand-off whose waves carry the policy's
 *   word and whose every denial has its override. A plan that ran no policy
 *   signs no `policy`.
 *
 * Kept apart from ./check-evidence.ts so `pr-post` reads the note file
 * without loading the ledger.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The variable a generated job hands the runner key in, as PEM (the same one the tick and `chant ci run` read). */
export const CHECK_EVIDENCE_KEY_ENV = "CHANT_RUNNER_KEY";

/** The file the signing step writes beside the plan report, which `pr-post` reads. */
export const CHECK_EVIDENCE_FILE = "evidence.json";

/** What the signing step did, for the note and the log. */
export interface CheckEvidenceNote {
  signed: Array<{ check: string; runner: string; commit: string; tree: string }>;
  skipped: Array<{ check: string; reason: string }>;
}

const REPORT_FILE = "pr-plan.json";
const HANDOFF_FILE = "pr-plan-note.json";

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The policy's verdict in a report: passed, denied, or none ran. */
function policyOf(dir: string): { passed: boolean; reason: string } | null {
  const report = existsSync(join(dir, REPORT_FILE)) ? readJson(join(dir, REPORT_FILE)) : undefined;
  if (report) {
    const p = report.policy as { result?: string; override?: unknown } | undefined;
    if (!p || typeof p.result !== "string") return null;
    if (p.result === "passed" || p.result === "held") return { passed: true, reason: `the policy ${p.result === "held" ? "held the plan for an approval and denied nothing" : "passed"}` };
    if (p.result === "denied" && p.override) return { passed: true, reason: "the policy denied the plan and an override stands" };
    return { passed: false, reason: p.result === "error" ? "the policy did not run or gave no readable answer" : "the policy denied the plan" };
  }
  const handoff = existsSync(join(dir, HANDOFF_FILE)) ? readJson(join(dir, HANDOFF_FILE)) : undefined;
  const note = handoff?.note as { waves?: Array<{ policy?: unknown }>; overrides?: Array<{ override?: unknown }> } | undefined;
  if (!note) return null;
  const overrides = note.overrides ?? [];
  const ran = overrides.length > 0 || (note.waves ?? []).some((w) => w.policy !== undefined);
  if (!ran) return null;
  const standing = overrides.filter((o) => !o.override).length;
  return standing === 0 ? { passed: true, reason: "the policy denied nothing that stands" } : { passed: false, reason: `the policy denied ${standing} unit${standing === 1 ? "" : "s"} with no override` };
}

/** The checks to sign from the plan job's hand-off directory and result, and those left unsigned with why. */
export function planReportChecks(dir: string, result: string | undefined): { sign: Array<{ check: string; claim?: Buffer }>; skipped: CheckEvidenceNote["skipped"] } {
  const file = [REPORT_FILE, HANDOFF_FILE].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (result !== "success") {
    const why = `the plan job's result is ${result ?? "not given"}`;
    return { sign: [], skipped: [{ check: "plan", reason: why }, { check: "policy", reason: why }] };
  }
  if (!file) {
    const why = `the plan job left no ${REPORT_FILE} or ${HANDOFF_FILE}`;
    return { sign: [], skipped: [{ check: "plan", reason: why }, { check: "policy", reason: why }] };
  }
  const claim = readFileSync(file);
  const sign: Array<{ check: string; claim?: Buffer }> = [{ check: "plan", claim }];
  const skipped: CheckEvidenceNote["skipped"] = [];
  const policy = policyOf(dir);
  if (policy === null) skipped.push({ check: "policy", reason: "the plan ran no policy" });
  else if (policy.passed) sign.push({ check: "policy", claim });
  else skipped.push({ check: "policy", reason: policy.reason });
  return { sign, skipped };
}

/**
 * The line the plan note ends with when the signing step wrote
 * {@link CHECK_EVIDENCE_FILE} in `dir`, or undefined when it did not.
 */
export function checkEvidenceNoteLine(dir: string): string | undefined {
  const doc = readJson(join(dir, CHECK_EVIDENCE_FILE)) as Partial<CheckEvidenceNote> | undefined;
  if (!doc || !Array.isArray(doc.signed) || !Array.isArray(doc.skipped)) return undefined;
  const signed = doc.signed.map((s) => `\`${s.check}\``);
  const skipped = doc.skipped.map((s) => `\`${s.check}\` (${s.reason})`);
  if (signed.length === 0 && skipped.length === 0) return undefined;
  const parts = [
    ...(signed.length > 0 ? [`signed evidence for ${signed.join(", ")} as ${doc.signed[0]!.runner}`] : []),
    ...(skipped.length > 0 ? [`not signed: ${skipped.join(", ")}`] : []),
  ];
  return `Checks: ${parts.join("; ")}.`;
}
