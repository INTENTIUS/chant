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
 * every planned member (`changeSetDocumentDigest`, #3181): the set digest a
 * gated wave binds over its members (#3049), and the document's entries, holes
 * and side effects with it (#3555). A reviewer approves it with `chant
 * approve pr-<number> pr-apply --plan <digest>`. The op carries the number so
 * that one pull request's approval never answers another's, and the gate name
 * stays fixed so a workspace can require signed approvals for it under
 * `identity.gates` (#3163).
 *
 * On merge the apply plans the same members again, before anything applies,
 * and decides the gate against the new digest. The same plan applies; a moved
 * plan stops with both digests named and nothing applied.
 *
 * ## A gate per wave on merge
 *
 * With `--wave-gate <gate>` (#4003) the apply runs a wave at a time, and
 * plans each wave after the one before it applied. Wave 1 applies under the
 * pull request's approval. A later wave whose new plan the approved change
 * set covers (`planCoveredBy`) applies under that approval too; one whose
 * plan moved waits at `<gate>-wave-<k>`, under the same op, for an approval
 * of its new plan. The report's `waves` says which wave applied under which
 * approval.
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

/** The first chant whose report can carry `deployedOutputs` (#4104). */
export const PR_REPORT_DEPLOYED_OUTPUTS_FLOOR = "0.124.30";

/** The first chant whose report can carry `waveGate` and `waves` (#4003). */
export const PR_REPORT_WAVES_FLOOR = "0.124.32";
/**
 * The first chant whose report can carry `plannedOutputs`, `rounds`, a
 * member's `unknownInputs`, `buildInputs`, `round` and `held`, and the `waiting` statuses
 * (#3999).
 */
export const PR_REPORT_PLANNED_OUTPUTS_FLOOR = "0.124.32";

/** The gate a pull request's apply waits on, unless the pipeline names another. */
export const PR_APPLY_GATE = "pr-apply";

/**
 * The op a pull request's gate is recorded under: `pr-<number>`, or
 * `pr-<number>-<member>` for a workspace member's pipeline (#3465).
 */
export function prOp(pr: number, member?: string): string {
  return member ? `pr-${pr}-${member}` : `pr-${pr}`;
}

/**
 * The gate a round of an apply waits on (#3999): the pull request's own
 * gate for the first, and `<gate>-round-<n>` for each one planned after an
 * upstream applied. A workspace's `identity.gates` entry for `gate` covers
 * every round.
 */
export function prRoundGate(gate: string, round: number): string {
  return round <= 1 ? gate : `${gate}-round-${round}`;
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
  | "blocked"
  /**
   * Apply stage (#3999): held back because its plan read an upstream output
   * that applied as another value, or was known only after apply. It waits
   * on an approval of the plan the apply made for it afterwards (`rounds`).
   */
  | "waiting";

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
   * run plans it again. Not written since #3999, which holds such a member
   * back and plans it again in the same apply (`held`, `round`).
   */
  inputsMoved?: string[];
  /**
   * The upstream outputs its plan read that the change's plans could not
   * say (#3999), as `<component>.<output>`, sorted: known only after that
   * upstream applies. The approval does not cover what this member does
   * with them; the apply plans it again once they are known.
   */
  unknownInputs?: string[];
  /**
   * The published artifact identities its plan read from a build in the
   * same change (#3999), as `<component>.publish.<field>`, sorted: an image
   * digest, say. Known only after the build runs, but never approved again:
   * the build's provenance and attestation bind the digest, so the member
   * applies without a later round.
   */
  buildInputs?: string[];
  /** Apply stage (#3999): the round whose plan it applied or waits on, when not the first. */
  round?: number;
  /** Apply stage (#3999): why the first round's plan did not apply. */
  held?: string;
}

/** A round of plans an apply made after an upstream applied (#3999), the report's `rounds`. */
export interface PrRound {
  /** 2 for the first plan made after an upstream applied, and on. */
  round: number;
  /** The gate it waits on: {@link prRoundGate}. */
  gate: string;
  /** The change-set digest of what the round planned. What its gate binds. */
  digest: string;
  /** The components planned again, in apply order. */
  components: string[];
  approval: PrApproval;
  /** `waiting`: no approval stands for `digest`. `plan-failed`: a member failed to plan, so the round did not apply. */
  status: "applied" | "failed" | "waiting" | "plan-failed";
  /** With `waiting`: why an approval that stands does not count (`--require-review`). */
  message?: string;
  /** The change-set document the round planned. */
  changeSet: ChangeSetDocument;
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
  /**
   * Apply stage with `--wave-gate` and `--wave` (#4003): this wave applied,
   * and a later wave of the change is still to run.
   */
  | "wave-applied"
  /** Apply stage: nothing applied, see `refusal`. */
  | "refused"
  /**
   * Apply stage (#3999): the approved plans applied, except members held
   * back after an upstream applied. They wait on the approval of the plan
   * the last of `rounds` made.
   */
  | "waiting";

/** Why an apply refused. */
export type PrRefusal =
  /** No approval stands for any plan of this pull request. */
  | "not-approved"
  /** The approval stands for another digest: the plan changed after review. */
  | "plan-changed"
  /** The approval names someone who has not approved the pull request on the forge. */
  | "not-a-reviewer"
  /** The approval names the pull request's author, or an author or committer of one of its commits (#4000). */
  | "author-approved"
  /** No pull request merged this commit, so there is no approval to read. */
  | "no-pull-request"
  /** `--wave-gate` (#4003): the wave's new plan is not one the pull request approved, and no approval stands for it. */
  | "wave-not-approved"
  /** `--wave-gate`: an approval of the wave's gate stands for another digest, so its plan moved since. */
  | "wave-plan-changed"
  /** `--wave-gate` with `--wave <k>`: an earlier wave has work left, or no record says it applied. */
  | "earlier-wave";

/**
 * One wave of an apply with `--wave-gate` (#4003): what it planned, where it
 * got to, and which approval it applied or waits under.
 */
export interface PrWave {
  /** 1-based, from the derivation (`selection.waves`). */
  wave: number;
  /** The components planned in it on the run that reached it. */
  components: string[];
  /** `applied`; `failed` or `plan-failed`; or `waiting` at its gate. */
  status: "applied" | "failed" | "plan-failed" | "waiting";
  /**
   * `pull-request`: the approved change set covers the wave's plan, so it
   * applies under the pull request's approval. `wave`: its plan moved, so it
   * needs an approval of its own gate.
   */
  approval: "pull-request" | "wave";
  /** The gate it applied or waits under: the pull request's, or `<wave gate>-wave-<k>`. */
  gate: string;
  /** The digest that gate binds: the pull request's change set, or the wave's new plan. */
  digest: string;
  /** Who approved that digest. */
  approvedBy?: string[];
  /** Waiting: an approval of the wave's gate stands for this other digest. */
  approved?: string;
  /** Why the approved change set does not cover the wave's plan, one line per member. */
  moved?: string[];
}

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
  /**
   * Apply stage, `--resume` (#3464): an earlier attempt at the approved set
   * failed partway, and these components applied in it. This run applied
   * the rest under the same approval and did not run them again.
   */
  resumed?: { applied: string[] };
  /**
   * Per dependency a member was planned against, the names of the outputs
   * read from the deployed estate (#4104), sorted. A dependency outside the
   * change is here too. Seeded outputs (`--seed-outputs`, a resume record)
   * are not. Absent when nothing was read. Added within contract 1 by chant
   * {@link PR_REPORT_DEPLOYED_OUTPUTS_FLOOR}.
   */
  deployedOutputs?: Record<string, string[]>;
  /**
   * Per dependency in the change that a member was planned against (#3999),
   * the names of the outputs its plan knows, sorted. An output it reads that
   * is not here is known only after apply (a member's `unknownInputs`).
   * Absent when no member read one. Added within contract 1 by chant
   * {@link PR_REPORT_PLANNED_OUTPUTS_FLOOR}.
   */
  plannedOutputs?: Record<string, string[]>;
  /**
   * Apply stage (#3999): the rounds planned after an upstream applied, in
   * order, each with its own gate and digest. Absent when nothing was held.
   */
  rounds?: PrRound[];
  approval: PrApproval;
  /**
   * The wave gate's base name with `--wave-gate` (#4003): wave k waits on
   * `<waveGate>-wave-<k>` when its plan moved. Added within contract 1 by
   * chant {@link PR_REPORT_WAVES_FLOOR}.
   */
  waveGate?: string;
  /** With `waveGate`: each wave reached so far, in order. */
  waves?: PrWave[];
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

/**
 * Why a member's plan cannot say everything it will change: its holes'
 * reasons, each once, in order (#4084). A `cfn-deploy` member whose inputs
 * come from a stack the same run applies first says `inputs from <stack>;
 * re-checked on apply`.
 */
export function memberHoleReasons(report: Pick<PrReport, "changeSet">, member: string): string[] {
  const m = report.changeSet.members.find((x) => x.member === member);
  return [...new Set((m?.holes ?? []).map((h) => h.reason))];
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
  waiting: "waiting on its new plan",
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
    case "wave-applied": {
      const applied = (report.waves ?? []).filter((w) => w.status === "applied").map((w) => w.wave);
      const total = report.selection.waves.length;
      return `Applied wave ${applied.at(-1) ?? "?"} of ${total}. The next wave runs in its own job.`;
    }
    case "refused": {
      const waiting = report.waves?.find((w) => w.status === "waiting");
      return waiting ? `Wave ${waiting.wave} waits at its gate ${code(waiting.gate)}; nothing in it applied.` : "The apply refused.";
    }
    case "waiting":
      return `Applied ${report.members.filter((m) => m.status === "applied").length} of ${members}; ${report.members.filter((m) => m.status === "waiting").length} wait on an approval of the plan made after their upstream applied.`;
  }
}

/** Who a wave applied or waits under, as a table cell. */
function waveApproval(w: PrWave): string {
  const whose = w.approval === "pull-request" ? "the pull request's" : "its own";
  const by = w.approvedBy?.length ? ` by ${w.approvedBy.map(code).join(", ")}` : w.status === "waiting" ? ", not approved yet" : "";
  return `${whose} ${code(w.gate)}${by}`;
}

/**
 * The waves of an apply with `--wave-gate` (#4003): a row per wave reached,
 * saying which approval it applied under, then for a wave that waits the
 * reason its plan moved and the approve command for its new plan.
 */
function waveLines(report: PrReport, approver: string): string[] {
  const waves = report.waves ?? [];
  if (waves.length === 0) return [];
  const out = ["", "| Wave | Components | Status | Approval |", "|---:|---|---|---|"];
  for (const w of waves) out.push(`| ${w.wave} | ${w.components.map(code).join(", ")} | ${w.status} | ${waveApproval(w)} |`);
  for (const w of waves.filter((x) => x.status === "waiting")) {
    out.push("", `Wave ${w.wave} was planned after the waves before it applied, and the approved plan does not cover it:`, "");
    for (const why of w.moved ?? []) out.push(`- ${why}`);
    if (w.approved) out.push("", `An approval of ${code(w.gate)} stands for ${code(w.approved)}, not for the plan now.`);
    out.push(
      "",
      `Read wave ${w.wave}'s plan, ${code(w.digest)}, and approve it with:`,
      "",
      "```",
      prApproveCommand({ op: report.op, gate: w.gate, digest: w.digest }, approver),
      "```",
      "",
      "Then run the wave's apply job again.",
    );
  }
  return out;
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
  if (report.resumed && report.resumed.applied.length > 0) {
    out.push("", `Resumed under the same approval: ${report.resumed.applied.map(code).join(", ")} applied in an earlier attempt and did not run again.`);
  }
  if (report.members.length > 0) {
    out.push("", "| Member | Component | Status | Create | Update | Replace | Delete |", "|---|---|---|---:|---:|---:|---:|");
    for (const m of report.members) {
      const holes = memberHoleReasons(report, m.member);
      const status =
        STATUS_WORDS[m.status] +
        (m.inputsMoved?.length ? `, inputs from ${m.inputsMoved.join(", ")} moved` : "") +
        (holes.length > 0 ? `; ${holes.length > 2 ? `${holes[0]}; and ${holes.length - 1} more, listed under Holes` : holes.join("; ")}` : "");
      // A member whose plan has holes and no entries says nothing about what
      // it changes, so its counts are unknown, not zero (#4084).
      const unknown = holes.length > 0 && !report.changeSet.entries.some((e) => e.member === m.member);
      const n = (k: keyof PrMemberCounts): string => (unknown ? "?" : String(m.counts[k]));
      out.push(`| ${code(m.member)} | ${m.component} | ${status} | ${n("create")} | ${n("update")} | ${n("replace")} | ${n("delete")} |`);
    }
    if (report.members.some((m) => m.inputsMoved?.length)) {
      out.push("", "A member whose inputs moved applied the plan it was approved with. The next run plans it against the new values.");
    }
  }
  out.push(...waveLines(report, options.approver ?? "<you>"));
  if (report.selection.unclaimed.length > 0) {
    out.push("", `Changed, and deployed by no component: ${report.selection.unclaimed.map(code).join(", ")}.`);
  }
  const deployed = Object.entries(report.deployedOutputs ?? {});
  if (deployed.length > 0) {
    const each = deployed.map(([dep, names]) => `${code(dep)} (${names.length > 0 ? names.map(code).join(", ") : "none yet"})`);
    out.push("", `Planned against outputs read from the deployed estate: ${each.join("; ")}.`);
  }
  const planned = Object.entries(report.plannedOutputs ?? {});
  if (planned.length > 0) {
    const each = planned.map(([dep, names]) => `${code(dep)} (${names.length > 0 ? names.map(code).join(", ") : "none known"})`);
    out.push("", `Planned against the outputs this change's plans say its upstreams will have: ${each.join("; ")}.`);
  }
  const unknown = [...new Set(report.members.flatMap((m) => (m.unknownInputs ?? []).map((ref) => `${code(m.component)} reads ${code(ref)}`)))];
  if (unknown.length > 0) {
    out.push(
      "",
      `Known only after apply: ${unknown.join("; ")}. This approval does not cover what those members do with them. ` +
        "The apply plans them again once their upstream applied and asks for an approval of that plan.",
    );
  }
  const fromBuild = [...new Set(report.members.flatMap((m) => (m.buildInputs ?? []).map((ref) => `${code(m.component)} reads ${code(ref)}`)))];
  if (fromBuild.length > 0) {
    out.push(
      "",
      `From this pull request's build: ${fromBuild.join("; ")}. The image digest comes from this pull request's build, whose provenance binds it, ` +
        "so those members apply with it once the build ran, without a second approval.",
    );
  }
  for (const r of report.rounds ?? []) {
    const what = `Round ${r.round} planned ${r.components.map(code).join(", ")} again after their upstream applied, digest ${code(r.digest)}`;
    if (r.status === "waiting") {
      if (r.message) out.push("", `> ${r.message}`);
      out.push("", `${what}. Not approved yet. Approve it, then run the apply again with the same \`--resume\` record:`, "", "```", prApproveCommand({ op: report.op, gate: r.gate, digest: r.digest }, options.approver ?? "<you>"), "```");
    } else {
      out.push("", `${what}: ${r.status === "applied" ? `applied, approved by ${(r.approval.approvedBy ?? []).map(code).join(", ")}` : r.status === "plan-failed" ? "a member failed to plan" : "the apply failed"}.`);
    }
  }
  if (report.status !== "nothing") {
    out.push("", `Plan digest: ${code(report.digest)}`, "", ...approvalLines(report, options.approver ?? "<you>"));
  }
  // #4003: with a gate per wave, a later wave's plan on merge may differ from this one.
  if (report.stage === "plan" && report.status === "planned" && report.waveGate) {
    out.push("", `On merge each wave after the first is planned again once the waves before it apply, and a wave whose plan moved stops at its own gate, ${code(`${report.waveGate}-wave-<k>`)}, for approval.`);
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
    case "planned": {
      const unknown = report.members.filter((m) => memberHoleReasons(report, m.member).length > 0).length;
      text = `${n} member${n === 1 ? "" : "s"}: ${sum.change} to change, ${sum.destroy} to destroy or replace${unknown > 0 ? `, ${unknown} with holes` : ""}${digest}`;
      break;
    }
    case "plan-failed":
      text = `a member failed to plan${digest}`;
      break;
    case "applied":
      text = `applied ${n} member${n === 1 ? "" : "s"}${digest}`;
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
      text = `refused: ${report.refusal === "plan-changed" ? "the plan changed after review" : report.refusal === "not-a-reviewer" ? "the approver has not approved the pull request" : report.refusal === "author-approved" ? "the approver wrote the change" : report.refusal === "no-pull-request" ? "no pull request merged this commit" : "the plan is not approved"}`;
      break;
    }
  }
  return text.length > 140 ? text.slice(0, 137) + "..." : text;
}

/** The commit status state for a report: success, failure, or pending while it waits on approval. */
export function prStatusState(report: PrReport): "success" | "failure" | "pending" {
  if (report.status === "planned" || report.status === "applied" || report.status === "wave-applied" || report.status === "nothing") return "success";
  if (report.status === "refused" && (report.refusal === "not-approved" || report.refusal === "wave-not-approved")) return "pending";
  if (report.status === "waiting") return "pending";
  return "failure";
}
