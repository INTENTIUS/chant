/**
 * The pull-request loop (#3183): plan the members a change reaches, show the
 * plan on the pull request, and apply it on merge only when the plan is the
 * one a reviewer approved.
 *
 * `chant components pr-plan` and `chant components pr-apply` run it, and the
 * generated CI for GitHub, GitLab and Forgejo calls them
 * (`components/pr-pipeline.ts`). This module holds the parts that need no
 * runner: the gate's names, the report both commands write, the pull-request
 * note rendered from it and the status line. terragucci reads the report and
 * renders the note from one bundled file with no TypeScript toolchain
 * (#3421), so this imports `./change-set` and `./plan-summary` and nothing
 * else; `pr-loop-bundle.test.ts` holds that.
 *
 * ## What the gate binds
 *
 * One gate per pull request: op `pr-<number>`, gate `pr-apply` unless the
 * pipeline names another. It binds the digest of the change-set document over
 * every planned member (`changeSetDigest`, #3181), the same digest a gated
 * wave binds over its members (#3049). A reviewer approves it with `chant
 * approve pr-<number> pr-apply --plan <digest>`. The op carries the number so
 * that one pull request's approval never answers another's, and the gate name
 * stays fixed so a workspace can require signed approvals for it under
 * `identity.gates` (#3163).
 *
 * On merge the apply plans the same members again, before anything applies,
 * and decides the gate against the new digest. The same plan applies; a moved
 * plan stops with both digests named and nothing applied.
 *
 * ## Inside a workspace member
 *
 * Each workspace member that generates the pipeline (#3465) runs its own
 * plan and apply on the same pull request, so each keeps its own gate, note
 * and statuses: op `pr-<number>-<member>`, the note marker and the status
 * contexts carry the member's name. The gate name stays the same, so one
 * `identity.gates` entry covers every member.
 */

import type { ChangeSetAction, ChangeSetDocument } from "./change-set";
import { GITHUB_COMMENT_LIMIT, groupChangeSet, renderPlanSummaryMarkdown } from "./plan-summary";

/** The schema a pull-request report names in `$schema`. */
export const PR_REPORT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/pr-report/v1/pr-report.schema.json";

/** The read-contract version the report follows. */
export const PR_REPORT_CONTRACT = 1;

/** The gate a pull request's apply waits on, unless the pipeline names another. */
export const PR_APPLY_GATE = "pr-apply";

/**
 * The op a pull request's gate is recorded under: `pr-<number>`, or
 * `pr-<number>-<member>` for a workspace member's pipeline (#3465).
 */
export function prOp(pr: number, member?: string): string {
  return member ? `pr-${pr}-${member}` : `pr-${pr}`;
}

/** Whether `op` is a pull request's gate op, with or without a member. Member names follow the declaration's name pattern. */
export const PR_GATE_OP = /^pr-\d+(?:-[a-z0-9][a-z0-9-]*)?$/;

/** The hidden line that marks the pull request's note, one per environment and, in a workspace, per member. */
export function prNoteMarker(env: string, member?: string): string {
  return member ? `<!-- chant-pr:${env}:${member} -->` : `<!-- chant-pr:${env} -->`;
}

/** The status contexts the two stages set on the commit. */
export const PR_STATUS_CONTEXTS = { plan: "chant/plan", apply: "chant/apply" } as const;

/** A stage's status context: `chant/plan`, or `chant/plan/<member>` for a workspace member's pipeline. */
export function prStatusContext(stage: "plan" | "apply", member?: string): string {
  return member ? `${PR_STATUS_CONTEXTS[stage]}/${member}` : PR_STATUS_CONTEXTS[stage];
}

/** Changes a member's plan proposes, by the actions a reviewer reads. */
export interface PrMemberCounts {
  create: number;
  update: number;
  replace: number;
  delete: number;
}

/** Where one member got to. */
export type PrMemberStatus =
  /** Planned, nothing applied (the plan stage, or an apply that stopped). */
  | "planned"
  /** The plan failed. */
  | "plan-failed"
  /** Applied the approved plan. */
  | "applied"
  /** The apply failed. */
  | "failed"
  /** Not applied because a member it depends on failed. */
  | "blocked";

export interface PrMember {
  /** The member's name in the change set: a root, for a terraform-family step. */
  member: string;
  /** The component whose step planned it. */
  component: string;
  /** What a gate on this member alone binds. `null` when it failed to plan. */
  planDigest: string | null;
  status: PrMemberStatus;
  counts: PrMemberCounts;
  error?: string;
  /**
   * Components this one depends on whose outputs changed when they applied
   * (apply stage). Its applied plan read the values from before, so the next
   * run plans it again.
   */
  inputsMoved?: string[];
}

/** Where the approval stands for the planned digest. */
export interface PrApproval {
  /**
   * `approved`: an approval stands for this digest. `changed`: one stands for
   * another digest, so the plan moved since someone approved it. `pending`:
   * none stands.
   */
  status: "approved" | "changed" | "pending";
  /** Who approved this digest. */
  approvedBy?: string[];
  /** With `changed`: the digest that was approved. */
  approved?: string;
}

/** How a stage ended. */
export type PrStatus =
  /** Plan stage: every member planned. */
  | "planned"
  /** Plan stage: a member failed to plan. Apply stage: the same, so nothing applied. */
  | "plan-failed"
  /** Nothing the change touches is deployed by a component. */
  | "nothing"
  /** Apply stage: every member applied. */
  | "applied"
  /** Apply stage: a member failed to apply. Its dependents did not run. */
  | "failed"
  /** Apply stage: nothing applied, see `refusal`. */
  | "refused";

/** Why an apply refused. */
export type PrRefusal =
  /** No approval stands for any plan of this pull request. */
  | "not-approved"
  /** The approval stands for another digest: the plan changed after review. */
  | "plan-changed"
  /** The approval names someone who has not approved the pull request on the forge. */
  | "not-a-reviewer"
  /** No pull request merged this commit, so there is no approval to read. */
  | "no-pull-request";

/**
 * The document `pr-plan` and `pr-apply` write (`pr-report.schema.json`).
 * The terragucci plan report (#3349) reads it; fields are only ever added.
 */
export interface PrReport {
  $schema: typeof PR_REPORT_SCHEMA_ID;
  contract: typeof PR_REPORT_CONTRACT;
  stage: "plan" | "apply";
  /** The pull or merge request number, when known. */
  pr: number | null;
  env: string;
  /** The workspace member whose pipeline ran the stage (#3465). Absent outside a workspace member. */
  member?: string;
  /** The commit the change is measured from: the merge base of the given base and `head`. */
  base: string;
  head: string;
  /** The gate's ledger entry: `_gates/<op>.jsonl` on `chant/lifecycle`. */
  op: string;
  gate: string;
  /** The change-set digest of what this stage planned. What the gate binds. */
  digest: string;
  status: PrStatus;
  refusal?: PrRefusal;
  /** The refusal or failure, as printed. */
  message?: string;
  approval: PrApproval;
  /** Component names: which changed, which run because they depend on one, and what the change touched that no component deploys. */
  selection: {
    changed: string[];
    dependents: string[];
    unclaimed: string[];
    indeterminate: string[];
    /** The components in dependency order, a wave per entry. */
    waves: string[][];
  };
  members: PrMember[];
  changeSet: ChangeSetDocument;
}

/** The counts a member's entries add up to. */
export function memberCounts(doc: Pick<ChangeSetDocument, "summary">, member: string): PrMemberCounts {
  const by = doc.summary.byMember[member] ?? {};
  const n = (a: ChangeSetAction) => by[a] ?? 0;
  return { create: n("create"), update: n("update"), replace: n("replace"), delete: n("delete") };
}

/** The approve command a reviewer runs for this report's digest. */
export function prApproveCommand(report: Pick<PrReport, "op" | "gate" | "digest">, approver = "<you>"): string {
  return `chant approve ${report.op} ${report.gate} --plan ${report.digest} --approver ${approver} --sign`;
}

/**
 * The refusal when the approved digest is not the planned one: both digests,
 * that nothing applied, and how to close it.
 */
export function describePlanChanged(report: Pick<PrReport, "op" | "gate" | "digest" | "approval">): string {
  return (
    `The plan changed after review, so nothing was applied. ` +
    `approved: ${report.approval.approved ?? "(none)"}; planned now: ${report.digest}. ` +
    `Read the new plan, and if it is right, approve it: ${prApproveCommand(report)}; then run the apply again.`
  );
}

const short = (sha: string): string => sha.slice(0, 12);
const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

const STATUS_WORDS: Record<PrMemberStatus, string> = {
  planned: "planned",
  "plan-failed": "plan failed",
  applied: "applied",
  failed: "apply failed",
  blocked: "blocked",
};

function headline(report: PrReport): string {
  const n = report.members.length;
  const members = `${n} member${n === 1 ? "" : "s"}`;
  switch (report.status) {
    case "nothing":
      return "Nothing to plan: no component deploys what this change touches.";
    case "planned":
      return `Planned ${members}.`;
    case "plan-failed":
      return `Planning failed for ${report.members.filter((m) => m.status === "plan-failed").length} of ${members}, so nothing can apply.`;
    case "applied":
      return `Applied ${members}.`;
    case "failed":
      return `The apply failed: ${report.members.filter((m) => m.status === "failed").length} failed, ${report.members.filter((m) => m.status === "applied").length} applied.`;
    case "refused":
      return "The apply refused.";
  }
}

function approvalLines(report: PrReport, approver: string): string[] {
  const a = report.approval;
  if (report.status === "nothing") return [];
  if (a.status === "approved") return [`Approved by ${(a.approvedBy ?? []).map(code).join(", ")} for this digest.`];
  const lines =
    a.status === "changed"
      ? [`An approval stands for ${code(a.approved ?? "(none)")}, not for this digest: the plan changed since it was approved.`]
      : ["Not approved yet."];
  if (report.stage === "plan" && report.status === "planned") {
    lines.push(
      "",
      "A reviewer who approved this pull request approves the plan with:",
      "",
      "```",
      prApproveCommand(report, approver),
      "```",
      "",
      "It applies on merge if the plan is still this one. If it moved, the apply refuses and names both digests.",
    );
  }
  return lines;
}

/**
 * The pull-request note: the stage's headline, a row per member, the digest
 * and the approval, then the grouped plan summary (#3188) in whatever room
 * `limit` leaves. The note starts with {@link prNoteMarker}, so the same
 * comment is updated by every push and by the apply.
 */
export function renderPrNote(report: PrReport, options: { limit?: number; approver?: string } = {}): string {
  const limit = options.limit ?? GITHUB_COMMENT_LIMIT;
  const out: string[] = [
    prNoteMarker(report.env, report.member),
    `### chant ${report.stage === "plan" ? "plan" : "apply"} for ${code(report.env)}${report.member ? ` in member ${code(report.member)}` : ""}`,
    "",
    `${headline(report)} Head ${code(short(report.head))}, measured from ${code(short(report.base))}.`,
  ];
  if (report.message) out.push("", `> ${report.message.split("\n").join("\n> ")}`);
  if (report.members.length > 0) {
    out.push("", "| Member | Component | Status | Create | Update | Replace | Delete |", "|---|---|---|---:|---:|---:|---:|");
    for (const m of report.members) {
      const status = STATUS_WORDS[m.status] + (m.inputsMoved?.length ? `, inputs from ${m.inputsMoved.join(", ")} moved` : "");
      out.push(`| ${code(m.member)} | ${m.component} | ${status} | ${m.counts.create} | ${m.counts.update} | ${m.counts.replace} | ${m.counts.delete} |`);
    }
    if (report.members.some((m) => m.inputsMoved?.length)) {
      out.push("", "A member whose inputs moved applied the plan it was approved with. The next run plans it against the new values.");
    }
  }
  if (report.selection.unclaimed.length > 0) {
    out.push("", `Changed, and deployed by no component: ${report.selection.unclaimed.map(code).join(", ")}.`);
  }
  if (report.status !== "nothing") {
    out.push("", `Plan digest: ${code(report.digest)}`, "", ...approvalLines(report, options.approver ?? "<you>"));
  }
  const head = out.join("\n") + "\n";
  if (report.status === "nothing" || report.changeSet.members.length === 0) return head;
  const room = limit - [...head].length - 1;
  if (room < 400) return head;
  return head + "\n" + renderPlanSummaryMarkdown(groupChangeSet(report.changeSet), { limit: room, command: "chant change-set summary .chant/pr/change-set.json" });
}

/** A commit status's description, at most 140 characters (GitHub's limit). */
export function prStatusDescription(report: PrReport): string {
  const n = report.members.length;
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
    case "planned":
      text = `${n} member${n === 1 ? "" : "s"}: ${sum.change} to change, ${sum.destroy} to destroy or replace${digest}`;
      break;
    case "plan-failed":
      text = `a member failed to plan${digest}`;
      break;
    case "applied":
      text = `applied ${n} member${n === 1 ? "" : "s"}${digest}`;
      break;
    case "failed":
      text = `apply failed for ${report.members.filter((m) => m.status === "failed").map((m) => m.member).join(", ")}`;
      break;
    case "refused":
      text = `refused: ${report.refusal === "plan-changed" ? "the plan changed after review" : report.refusal === "not-a-reviewer" ? "the approver has not approved the pull request" : report.refusal === "no-pull-request" ? "no pull request merged this commit" : "the plan is not approved"}`;
      break;
  }
  return text.length > 140 ? text.slice(0, 137) + "..." : text;
}

/** The commit status state for a report: success, failure, or pending while it waits on approval. */
export function prStatusState(report: PrReport): "success" | "failure" | "pending" {
  if (report.status === "planned" || report.status === "applied" || report.status === "nothing") return "success";
  if (report.status === "refused" && report.refusal === "not-approved") return "pending";
  return "failure";
}
