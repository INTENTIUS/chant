/**
 * The pull-request loop's commit status (#3183): its description and its
 * state, from the report `chant components pr-plan` and `pr-apply` write.
 *
 * They lived in `./pr-loop.ts` until #4966 moved them here, so the bundle
 * a product builds from `pr-loop.ts` and `pr-forge.ts` (the report, the note
 * and the forge clients, `pr-loop-bundle.test.ts`) keeps room under its
 * ceiling. chant's own handlers post the status; no product reads these.
 */

import { activeProductWords, type CiProductWords } from "./ci-product-words";
import { memberHoleReasons, type PrReport } from "./pr-loop";

/** A commit status's description, at most 140 characters (GitHub's limit). */
export function prStatusDescription(report: PrReport, words: CiProductWords = activeProductWords()): string {
  const n = report.members.length;
  const many = (k: number): string => `${k} ${words.noun[k === 1 ? 0 : 1]}`;
  const sum = report.members.reduce(
    (acc, m) => ({ change: acc.change + m.counts.create + m.counts.update + m.counts.replace, destroy: acc.destroy + m.counts.delete + m.counts.replace }),
    { change: 0, destroy: 0 },
  );
  const digest = report.digest ? `; plan ${report.digest.replace(/^(?:jcs1-)?sha256:/, "").slice(0, 12)}` : "";
  let text: string;
  switch (report.status) {
    case "nothing":
      text = "nothing to plan";
      break;
    case "planned": {
      const unknown = report.members.filter((m) => memberHoleReasons(report, m.member).length > 0).length;
      // #4626: a narrowed plan says so in its status.
      const narrowed = Object.values(report.narrowed ?? {}).filter((a) => a.length > 0).length;
      text = `${many(n)}${narrowed > 0 ? ` (${narrowed} narrowed with --target)` : ""}: ${sum.change} to change, ${sum.destroy} to destroy or replace${unknown > 0 ? `, ${unknown} with holes` : ""}${digest}`;
      break;
    }
    case "plan-failed":
      text = `a ${words.noun[0]} failed to ${words.verbs.plan[0]}${digest}`;
      break;
    case "recorded":
      text = `recorded ${many(n)}: ${report.approval.status === "approved" ? "the approved plan" : report.approval.status === "changed" ? "the plan differs from the approved one" : "no approval for this plan"}${digest}`;
      break;
    case "applied":
      text = `${words.verbs.apply[1]} ${many(n)}${digest}`;
      break;
    case "wave-applied": {
      const last = (report.waves ?? []).filter((w) => w.status === "applied").at(-1);
      text = `applied wave ${last?.wave ?? "?"} of ${report.selection.waves.length}${last ? ` under ${last.approval === "pull-request" ? "the pull request's approval" : `${last.gate}`}` : ""}`;
      break;
    }
    case "failed":
      text = `apply failed for ${report.members.filter((m) => m.status === "failed").map((m) => m.member).join(", ")}`;
      break;
    case "waiting":
      text = `waiting: ${report.members.filter((m) => m.status === "waiting").map((m) => m.member).join(", ")} planned again after an upstream applied, not approved yet`;
      break;
    case "refused": {
      const waiting = report.waves?.find((w) => w.status === "waiting");
      if (waiting && (report.refusal === "wave-not-approved" || report.refusal === "wave-plan-changed")) {
        text = `wave ${waiting.wave} waits at ${waiting.gate}: ${report.refusal === "wave-plan-changed" ? "its plan changed after its approval" : "its plan moved, approve it"}`;
        break;
      }
      if (report.refusal === "earlier-wave") {
        text = "refused: an earlier wave has not applied";
        break;
      }
      if (report.refusal === "requires-unmet" || report.refusal === "before-merge-off") {
        const unmet = (report.beforeMerge?.requires ?? []).filter((r) => !r.passed).map((r) => r.name);
        text = report.refusal === "before-merge-off" ? "refused: this workspace does not apply before merge" : `refused: ${unmet.join(", ") || "a require"} unmet for an apply before merge`;
        break;
      }
      if (report.refusal === "policy-denied" || report.refusal === "policy-error") {
        text = report.refusal === "policy-denied" ? `refused: the policy denied the plan (${(report.policy?.rules ?? []).join(", ")})` : "refused: the policy could not be checked";
        break;
      }
      text = `refused: ${report.refusal === "plan-changed" ? "the plan changed after review" : report.refusal === "not-a-reviewer" ? "the approver has not approved the pull request" : report.refusal === "author-approved" ? "the approver wrote the change" : report.refusal === "no-pull-request" ? "no pull request merged this commit" : report.refusal === "locked" ? "another pull request holds a target lock" : "the plan is not approved"}`;
      break;
    }
  }
  return text.length > 140 ? text.slice(0, 137) + "..." : text;
}

/** The commit status state for a report: success, failure, or pending while it waits on approval. */
export function prStatusState(report: PrReport): "success" | "failure" | "pending" {
  // #4168 decision 1: a merge whose plan differs from the approved one is recorded, and its status fails.
  if (report.status === "recorded") return report.approval.status === "changed" ? "failure" : "success";
  // #4294: a plan the policy denied, with no override, or one it could not check, fails at the plan stage as it would at the apply.
  if (report.status === "planned" && report.policy && (report.policy.result === "error" || (report.policy.result === "denied" && !report.policy.override))) return "failure";
  if (report.status === "planned" || report.status === "applied" || report.status === "wave-applied" || report.status === "nothing") return "success";
  if (report.status === "refused" && (report.refusal === "not-approved" || report.refusal === "wave-not-approved")) return "pending";
  if (report.status === "waiting") return "pending";
  return "failure";
}
