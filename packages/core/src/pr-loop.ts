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

import { NEXT_RELEASE } from "./release-floors";
import type { ChangeSetAction, ChangeSetDocument, ChangeSetEntry } from "./change-set";
import { parsePulumiUrn, pulumiMayAppearParent } from "./pulumi-urn";
import type { PrRequireOutcome } from "./pr-requires";
import { renderMigrationLines, type PrMigrationFile } from "./pr-migrations";
import { GITHUB_COMMENT_LIMIT, groupChangeSet, renderPlanSummaryMarkdown } from "./plan-summary";
import { activeProductWords, approveLine, commentLine, isChantWords, overrideLine, productStatusContext, type CiProductWords } from "./ci-product-words";
import type { CrossStackEdge } from "./control/edges";

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

/** The chant that writes the `record` stage and the `recorded` status (#4168 step 1). */
export const PR_REPORT_RECORD_FLOOR = "0.124.33";

/** The first chant whose report can carry `hooks` (#4288). */
export const PR_REPORT_HOOKS_FLOOR = "0.124.41";

/** The first chant whose plan report can carry `overdue` (#4289). */
export const PR_REPORT_OVERDUE_FLOOR = "0.124.41";

/** The first chant whose report can carry `policy` and the `policy-denied` and `policy-error` refusals (#4294). */
export const PR_REPORT_POLICY_FLOOR = "0.124.41";

/** The first chant whose apply report can carry `beforeMerge` and the `requires-unmet` and `before-merge-off` refusals (#4301, ws-106). */
export const PR_REPORT_BEFORE_MERGE_FLOOR = "0.124.42";

/** The first chant whose plan report can carry `migrations` (#4407). */
export const PR_REPORT_MIGRATIONS_FLOOR = "0.124.49";

/** The first chant whose report can carry a member's `reads`, known at plan or not. */
export const PR_REPORT_READS_FLOOR = "0.124.52";

/** The first chant whose report can carry the `not-started` member status (ws-107, #4440). */
export const PR_REPORT_NOT_STARTED_FLOOR = "0.124.54";

/** The first chant whose report can carry `groups`, `fallbacks`, and a member's `group` and `groupOutcome` (ws-107, #4446). */
export const PR_REPORT_GROUPS_FLOOR = "0.124.54";

/** The first chant whose report can carry `lockTargets` (#4552). */
export const PR_REPORT_LOCK_TARGETS_FLOOR = NEXT_RELEASE;

/** The first chant whose report carries {@link PrReport.narrowed} (#4626). */
export const PR_REPORT_NARROWED_FLOOR = NEXT_RELEASE;

/** The first chant whose report carries {@link PrReport.crossStackEdges} (#4617). */
export const PR_REPORT_CROSS_STACK_FLOOR = NEXT_RELEASE;

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

/** The status contexts the stages set on the commit. */
export const PR_STATUS_CONTEXTS = { plan: "chant/plan", apply: "chant/apply", record: "chant/record" } as const;

/** A pull-request loop stage: plan on the pull request, then record (#4168) or, opted in, apply on merge. */
export type PrStage = keyof typeof PR_STATUS_CONTEXTS;

/**
 * A stage's status context: `chant/plan`, or `chant/plan/<member>` for a
 * workspace member's pipeline. Under a product's words (#4550) the prefix and
 * the stage word are the product's: `plywood/preview/shop-dev`.
 */
export function prStatusContext(stage: PrStage, member?: string, words: CiProductWords = activeProductWords()): string {
  if (!isChantWords(words)) return productStatusContext(words, stage, member);
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
  | "waiting"
  /**
   * Apply stage (ws-107, #4440): a member of a group whose apply stopped
   * before its part began. Written by chant {@link PR_REPORT_NOT_STARTED_FLOOR}
   * and newer.
   */
  | "not-started";

/** One upstream a member reads outputs of (`PrMember.reads`). */
export interface PrMemberRead {
  /** The component (or stack) whose outputs it reads. */
  upstream: string;
  /** The output names it reads, sorted. `publish.<field>` for a published artifact. */
  outputs: string[];
  /** The ones its plan had no value for, sorted: known only after the upstream applies. Absent when every one was known. */
  unknown?: string[];
}

/** How a member's part of a group apply ended, as its capability said (ws-107): `PrMember.groupOutcome`. */
export type PrGroupOutcome = "applied" | "partial" | "failed" | "not-started" | "no-changes";

/** Components one capability planned and applied as one (ws-107, #4446): the report's `groups`. */
export interface PrGroup {
  /** The kind of the capability every member's one step names. */
  capability: string;
  /** The members, by component, in apply order: upstreams first. */
  components: string[];
  /** The 1-based wave of `selection.waves` it ran in. */
  wave: number;
  /** The group digest folded into each member's `planDigest`. `null` when the group failed to plan. */
  digest: string | null;
  /** Why the group failed to plan. Every member is then `plan-failed`. */
  error?: string;
  /** Each read of another member its plan did not know, which the group's apply computes, sorted. Absent when none. */
  reads?: Array<{ component: string; ref: string }>;
}

/**
 * A component that could have joined a group and did not (ws-107, ruling 1,
 * #4446): the report's `fallbacks`. `kind` is core's `steps`, `split` or
 * `cycle`, or the capability's own; `off` means the capability's setting
 * turns grouping off, and the note does not print it.
 */
export interface PrGroupFallback {
  component: string;
  capability: string;
  kind: string;
  reason: string;
}

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
   * upstream applies. The apply plans the member again once they are known;
   * the first approval covers that round when it does only what the preview
   * showed with only these inputs filled in, and anything else waits for an
   * approval of its own (`PrRound.covered`, `PrRound.notCovered`).
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
  /**
   * Every other component's output its steps read, one entry per upstream,
   * by upstream: the output names, sorted, and under `unknown` the ones its
   * plan had no value for. A read whose value the plan knew is here too, so
   * a reader of the report sees each read between components from the plan
   * on, not only the ones `unknownInputs` names. Added within contract 1 by
   * chant {@link PR_REPORT_READS_FLOOR}.
   */
  reads?: PrMemberRead[];
  /** Apply stage (#3999): the round whose plan it applied or waits on, when not the first. */
  round?: number;
  /** Apply stage (#3999): why the first round's plan did not apply. */
  held?: string;
  /** A blocked member's (#4291): the component whose failure held it, past any component blocked in between. */
  blockedBy?: string;
  /** The index in the report's `groups` of the group it planned and applied with (#4446). Added within contract 1 by chant {@link PR_REPORT_GROUPS_FLOOR}. */
  group?: number;
  /** Apply stage (#4446): how its part of the group's apply ended. Absent when the group did not run. */
  groupOutcome?: PrGroupOutcome;
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
  /**
   * `waiting`: no approval stands for `digest`. `plan-failed`: a member failed
   * to plan, so the round did not apply. `held`: another run holds a row the
   * round changes (#4594), so it did not apply; `message` names that run.
   */
  status: "applied" | "failed" | "waiting" | "plan-failed" | "held";
  /** With `waiting`: why an approval that stands does not count (`--require-review`). With `held`: the run holding the rows. */
  message?: string;
  /**
   * The first approval covered this round's plan (#4419): no gate of its own was
   * decided. `digest` is the first approval's, which the coverage is bound
   * to; `filledInputs` are the inputs it previewed as unknown and this plan
   * had a value for, as `<component>.<output>`.
   */
  covered?: { digest: string; filledInputs: string[] };
  /** Why the first approval did not cover this round, so it asked for its own (#4419). */
  notCovered?: string;
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
  /**
   * Record stage (#4168): every member planned on the merged commit and the
   * plan is kept with the merge record. Nothing applied; `approval` says
   * whether the plan is the one approved.
   */
  | "recorded"
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
  | "earlier-wave"
  /** Under `ci.locks` (#4293): another open pull request holds a lock on a target this apply reaches. */
  | "locked"
  /** `ci.policy` at base denied the plan (#4294), and no override of it counts. */
  | "policy-denied"
  /** `ci.policy` at base could not be run, or gave no answer chant can read (#4294). */
  | "policy-error"
  /** `pr-apply --before-merge` (#4301): the pull request is not approved, mergeable, undiverged or green; `beforeMerge` says which. */
  | "requires-unmet"
  /** `pr-apply --before-merge`: the declaration at base does not set `ci.workflow` to `apply-before-merge` for the member. */
  | "before-merge-off";

/** An apply before merge (#4301, ws-106): the requires checks the forge answered, in order. */
export interface PrBeforeMerge {
  requires: PrRequireOutcome[];
}

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

/** A scheduled watch or reconcile Op that stopped running (#4289, `op/schedule-overdue.ts`). */
export interface PrOverdue {
  op: string;
  cron: string;
  /** The job's last run, or the pipeline file's first commit when `neverRan` (ISO 8601). */
  since: string;
  neverRan?: boolean;
  message: string;
}

/**
 * What `ci.policy` at base said about the change set (#4294). Rule ids are
 * `<package>.<rule>`.
 */
export interface PrPolicyReport {
  /** `denied` wins over `held`. `error`: the policy did not run or gave no readable answer. */
  result: "passed" | "denied" | "held" | "error";
  /** The result shape read: `conftest` or `opa`. */
  engine: "conftest" | "opa";
  /** The commit the settings and the policy were read at. */
  base: string;
  denials: Array<{ rule: string; message: string }>;
  /** The ids of the rules that denied, sorted: what an override names. */
  rules?: string[];
  holds: Array<{ rule: string; message: string }>;
  warnings: string[];
  error?: string;
  /** The override that lets the denied plan through. */
  override?: { by: string; at: string; reason: string; digest: string };
  /** While denied: the command that overrides the denial. */
  overrideCommand?: string;
  /** `ci.policy.source` as fetched (#4613): the shared repository, its ref, the commit read and the Rego directory. */
  source?: { repo: string; ref: string; commit: string; path: string };
}

/**
 * One stage hook a pull-request job ran (#4288), from `ci.hooks` in the
 * workspace declaration at base. The shape of an Op waves hook outcome.
 */
export interface PrHookOutcome {
  /** `before-observe`, `before-plan`, `after-plan`, `before-apply` or `after-apply`. */
  moment: string;
  name: string;
  /** The component, for a `perRun` hook. */
  target?: string;
  exit: number;
  /** `held`: an `onFailure: approve` hook failed, which the pull request's gate answers. */
  outcome: "passed" | "failed" | "held";
}

/**
 * The document `pr-plan` and `pr-apply` write (`pr-report.schema.json`).
 * The terragucci plan report (#3349) reads it; fields are only ever added.
 */
export interface PrReport {
  $schema: typeof PR_REPORT_SCHEMA_ID;
  contract: typeof PR_REPORT_CONTRACT;
  stage: PrStage;
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
  /**
   * Plan stage (#4289): the scheduled watch and reconcile Ops whose cron has
   * fired at least twice since their job last ran, or since their pipeline
   * file was added when no run is on record. Absent when none is overdue or
   * the forge was not asked. Added within contract 1 by chant
   * {@link PR_REPORT_OVERDUE_FLOOR}.
   */
  overdue?: PrOverdue[];
  /**
   * Plan stage (#4407): the migration files the pull request adds in a
   * migration-directory workspace member, each statement classified offline.
   * Absent when it adds none. Added within contract 1 by chant
   * {@link PR_REPORT_MIGRATIONS_FLOOR}.
   */
  migrations?: PrMigrationFile[];
  /**
   * The groups a capability planned and applied as one (ws-107, #4446), in
   * plan order of their first member. On a resume, what is left of a group,
   * grouped again. Absent when none formed. Added within contract 1 by chant
   * {@link PR_REPORT_GROUPS_FLOOR}.
   */
  groups?: PrGroup[];
  /** The components that could have grouped and did not, with why (#4446), sorted. Absent when none. Since {@link PR_REPORT_GROUPS_FLOOR}. */
  fallbacks?: PrGroupFallback[];
  /**
   * A section per member that its lexicon rendered from its own part of the
   * change set (#4573), placed under the member table: rows a resource table
   * does not carry, such as a SQL member's statements and their class. Absent
   * when no lexicon rendered one. Added within contract 1 by the chant that
   * carries `CI_PRODUCT_FLOOR` (`@intentius/chant/ci-product`).
   */
  details?: PrMemberDetail[];
  /**
   * The policy findings capabilities' plans carried (#4550), one entry per
   * member with any. Absent when none did. Added within contract 1 by the
   * chant that carries `CI_PRODUCT_FLOOR`.
   */
  capabilityPolicy?: PrCapabilityPolicy[];
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
  /**
   * The names the pull request's target locks take under `ci.locks` (#4552,
   * ruling D), sorted, when any member is on the resource lock grain: each
   * such member's row keys, and the component name of every component with
   * a member on another grain. `chant lock --from-report` locks these in
   * place of `selection.waves`. Absent when no member is on the resource
   * grain. Added within contract 1 by chant
   * {@link PR_REPORT_LOCK_TARGETS_FLOOR}.
   */
  lockTargets?: string[];
  /**
   * Plan stage (#4626): the addresses each component's plan was narrowed to
   * with `pr-plan --target`, from the command line or the comment, by
   * component. The note and the status say so. Absent when nothing was
   * narrowed. Added within contract 1 by chant {@link PR_REPORT_NARROWED_FLOOR}.
   */
  narrowed?: Record<string, string[]>;
  /**
   * The stacks outside the workspace a member reads (#4617, a Pulumi
   * `StackReference` no step here applies, #4547), each marked stale,
   * current or unknown from the control repo's entries and apply records
   * (`./control/edges.ts`). The plan job marks every one unknown, since it
   * reads no control repo; the job that posts the note marks them again
   * from a checkout of it. Absent when no member reads one. Added within
   * contract 1 by chant {@link PR_REPORT_CROSS_STACK_FLOOR}.
   */
  crossStackEdges?: CrossStackEdge[];
  /**
   * The stage hooks the job ran (#4288), in order. Absent when it ran none.
   * Added within contract 1 by chant {@link PR_REPORT_HOOKS_FLOOR}.
   */
  hooks?: PrHookOutcome[];
  /**
   * What `ci.policy` at base said about the change set (#4294). Absent when
   * the base sets no policy, or the stage reached no plan to judge. Added
   * within contract 1 by chant {@link PR_REPORT_POLICY_FLOOR}.
   */
  policy?: PrPolicyReport;
  /**
   * `pr-apply --before-merge` (#4301): the requires checks. Absent on every
   * other stage. Added within contract 1 by chant
   * {@link PR_REPORT_BEFORE_MERGE_FLOOR}.
   */
  beforeMerge?: PrBeforeMerge;
}

/**
 * A policy engine's findings a capability's plan carried for one member
 * (#4550, from chant#4541's `pulumi-up`: CrossGuard in the preview job).
 * `denied`: the capability refused the plan (`policyDenied`), so the stage
 * exits 7. Otherwise the findings are advisory and the note lists them.
 */
export interface PrCapabilityPolicy {
  member: string;
  denied: boolean;
  denials: Array<{ rule: string; message: string }>;
  holds: Array<{ rule: string; message: string }>;
  warnings: string[];
}

/** One member's detail section (#4573): markdown lines its lexicon rendered. */
export interface PrMemberDetail {
  member: string;
  /** The section's summary line. Default: the member's name. */
  title?: string;
  /** Markdown lines. A table, a list, or both; chant adds nothing inside. */
  lines: string[];
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

/**
 * The approve command a reviewer runs for this report's digest: the product's
 * approve line under its words (#4550). `target` fills the template's
 * `{target}` (#4601): the member the line approves, such as sql-yodeler's
 * environment.
 */
export function prApproveCommand(report: Pick<PrReport, "op" | "gate" | "digest"> & { target?: string }, approver = "<you>", words: CiProductWords = activeProductWords()): string {
  if (!isChantWords(words)) return approveLine(words, { op: report.op, gate: report.gate, digest: report.digest, approver, sign: true, ...(report.target !== undefined ? { target: report.target } : {}) });
  return `chant approve ${report.op} ${report.gate} --plan ${report.digest} --approver ${approver} --sign`;
}

/**
 * The targets the product's approve line names (#4601), one line each: none
 * when its template has no `{target}`; else the workspace member the report
 * is for, else each member in the report, else the environment.
 */
export function prApproveTargets(report: Pick<PrReport, "env"> & Partial<Pick<PrReport, "member" | "members">>, words: CiProductWords = activeProductWords()): string[] {
  if (!words.approve.includes("{target}")) return [];
  if (report.member) return [report.member];
  const names = [...new Set((report.members ?? []).map((m) => m.member))];
  return names.length > 0 ? names : [report.env];
}

/** Every approve command the report asks for: one per {@link prApproveTargets}, or the one line when the template names no target. */
export function prApproveCommands(
  report: Pick<PrReport, "op" | "gate" | "digest" | "env"> & Partial<Pick<PrReport, "member" | "members">>,
  approver = "<you>",
  words: CiProductWords = activeProductWords(),
): string[] {
  const targets = prApproveTargets(report, words);
  if (targets.length === 0) return [prApproveCommand(report, approver, words)];
  return targets.map((target) => prApproveCommand({ op: report.op, gate: report.gate, digest: report.digest, target }, approver, words));
}

/**
 * The refusal when the approved digest is not the planned one: both digests,
 * that nothing applied, and how to close it.
 */
export function describePlanChanged(report: Pick<PrReport, "op" | "gate" | "digest" | "approval"> & Partial<Pick<PrReport, "env" | "member" | "members">>): string {
  const approve = report.env !== undefined ? prApproveCommands({ ...report, env: report.env }).join("; ") : prApproveCommand(report);
  return (
    `The plan changed after review, so nothing was applied. ` +
    `approved: ${report.approval.approved ?? "(none)"}; planned now: ${report.digest}. ` +
    `Read the new plan, and if it is right, approve it: ${approve}; then run the apply again.`
  );
}

const short = (sha: string): string => sha.slice(0, 12);
const code = (s: string): string => "`" + s.replaceAll("`", "'") + "`";

/** A member's status in the note, in the product's verbs (#4550): chant's `planned`, plywood's `previewed`. */
function statusWords(words: CiProductWords): Record<PrMemberStatus, string> {
  const [plan, planned] = words.verbs.plan;
  const [apply, applied] = words.verbs.apply;
  return {
    planned,
    "plan-failed": `${plan} failed`,
    applied,
    failed: `${apply} failed`,
    blocked: "blocked",
    waiting: "waiting on its new plan",
    "not-started": "not started",
  };
}

const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

function headline(report: PrReport, words: CiProductWords): string {
  const n = report.members.length;
  const members = `${n} ${words.noun[n === 1 ? 0 : 1]}`;
  const [plan, planned] = words.verbs.plan;
  const applied = words.verbs.apply[1];
  switch (report.status) {
    case "nothing":
      return `Nothing to ${plan}: no component deploys what this change touches.`;
    case "planned":
      return `${capital(planned)} ${members}.`;
    case "recorded":
      return `Recorded the plan of ${members} on merge. Nothing applied: a release that carries this commit deploys it.`;
    case "plan-failed":
      if (report.hooks?.some((h) => h.outcome === "failed")) return "A hook failed, so nothing can apply.";
      return `${isChantWords(words) ? "Planning" : `The ${plan}`} failed for ${report.members.filter((m) => m.status === "plan-failed").length} of ${members}, so nothing can apply.`;
    case "applied":
      return `${capital(applied)} ${members}.`;
    case "failed": {
      const blocked = report.members.filter((m) => m.status === "blocked").length;
      const notStarted = report.members.filter((m) => m.status === "not-started").length;
      return `The apply failed: ${report.members.filter((m) => m.status === "failed").length} failed, ${blocked > 0 ? `${blocked} blocked, ` : ""}${notStarted > 0 ? `${notStarted} not started, ` : ""}${report.members.filter((m) => m.status === "applied").length} applied.`;
    }
    case "wave-applied": {
      const applied = (report.waves ?? []).filter((w) => w.status === "applied").map((w) => w.wave);
      const total = report.selection.waves.length;
      return `${capital(words.verbs.apply[1])} wave ${applied.at(-1) ?? "?"} of ${total}. The next wave runs in its own job.`;
    }
    case "refused": {
      const waiting = report.waves?.find((w) => w.status === "waiting");
      return waiting ? `Wave ${waiting.wave} waits at its gate ${code(waiting.gate)}; nothing in it applied.` : "The apply refused.";
    }
    case "waiting":
      return `${capital(applied)} ${report.members.filter((m) => m.status === "applied").length} of ${members}; ${report.members.filter((m) => m.status === "waiting").length} wait on an approval of the plan made after their upstream applied.`;
  }
}

/**
 * The blocked set (#4291): each component a failure held, grouped by the
 * component that failed, and that the rest went on. Undefined when nothing
 * is blocked.
 */
/**
 * The cross-stack edges (#4617): a table of each stack outside the
 * workspace a member reads, its owner and its mark, and a line naming the
 * stale ones, whose reader holds outputs that may have changed since.
 */
function crossStackLines(report: Pick<PrReport, "crossStackEdges">): string[] {
  const edges = report.crossStackEdges ?? [];
  if (edges.length === 0) return [];
  const day = (iso?: string): string => (iso ? iso.replace(/\.\d+Z$/, "Z") : "never");
  const out = ["", "| Reader | Reads stack | Owner | Edge | Why |", "|---|---|---|---|---|"];
  for (const e of edges) {
    const why = e.ownerApplied ? `${e.why} (owner applied ${day(e.ownerApplied.at)} at ${code(e.ownerApplied.sha.slice(0, 12))}, reader updated ${day(e.lastUpdate)})` : e.why;
    out.push(`| ${code(e.member)} | ${code(e.stack)} | ${e.owner ? code(e.owner) : "?"} | ${e.status} | ${why} |`);
  }
  const stale = edges.filter((e) => e.status === "stale");
  if (stale.length > 0) {
    out.push("", `Stale: ${stale.map((e) => `${code(e.member)} reads ${code(e.stack)}`).join("; ")}. The owner applied since the reader last updated, so this plan reads its outputs as they are now and the reader's last update read older ones.`);
  }
  return out;
}

function blockedLine(members: readonly PrMember[]): string | undefined {
  const byRoot = new Map<string, Set<string>>();
  for (const m of members) {
    if (m.status !== "blocked") continue;
    const by = m.blockedBy ?? "a dependency";
    byRoot.set(by, (byRoot.get(by) ?? new Set()).add(m.component));
  }
  if (byRoot.size === 0) return undefined;
  const groups = [...byRoot]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([by, names]) => `${[...names].sort().map(code).join(", ")} (blocked by ${by === "a dependency" ? by : code(by)})`);
  return `Blocked, so not applied: ${groups.join("; ")}. A failure blocks only the members that depend on it, so the rest went on.`;
}

/** `a`, `b` and `c`. */
const listed = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

const GROUP_OUTCOME_WORDS: Record<PrGroupOutcome, string> = {
  applied: "applied and stays applied",
  "no-changes": "had no changes",
  partial: "applied in part, and what applied stays",
  failed: "failed",
  "not-started": "did not start",
};

/**
 * The groups and fallbacks (#4446): a line per group naming its members and
 * the reads its apply computes, how a group that stopped part way left each
 * member, and why the components that could have grouped did not.
 */
function groupLines(report: PrReport): string[] {
  const out: string[] = [];
  for (const g of report.groups ?? []) {
    const reads = (g.reads ?? []).map((r) => `${code(r.component)} reads ${code(r.ref)}`);
    out.push(
      "",
      `${listed(g.components.map(code))} plan and apply as one (${code(g.capability)}, wave ${g.wave})` +
        (g.error ? `; the group failed to plan, so nothing applies: ${g.error}.` : reads.length > 0 ? `; ${listed(reads)}, known when the group applies.` : "."),
    );
    const outcome = new Map(report.members.filter((m) => m.groupOutcome && g.components.includes(m.component)).map((m) => [m.component, m.groupOutcome!]));
    const left = g.components.filter((c) => outcome.has(c) && outcome.get(c) !== "applied" && outcome.get(c) !== "no-changes");
    if (left.length === 0) continue;
    out.push(
      "",
      `The group's apply stopped part way: ${g.components.filter((c) => outcome.has(c)).map((c) => `${code(c)} ${GROUP_OUTCOME_WORDS[outcome.get(c)!]}`).join("; ")}. ` +
        `Nothing that applied is undone. \`pr-apply --resume\` plans ${listed(left.map(code))} again, as one group where they still join, and applies them under this approval when the new plans are covered.`,
    );
  }
  const byWhy = new Map<string, string[]>();
  for (const f of report.fallbacks ?? []) {
    if (f.kind === "off") continue;
    const why = `(${code(f.kind)}): ${f.reason}`;
    byWhy.set(why, [...(byWhy.get(why) ?? []), code(f.component)]);
  }
  if (byWhy.size > 0) out.push("", `Planned one by one, not as a group: ${[...byWhy].map(([why, names]) => `${names.join(", ")} ${why}`).join("; ")}.`);
  return out;
}

/** The policy's lines in the note (#4294): what denied or held the plan, and how a denial is overridden. */
function policyLines(report: PrReport): string[] {
  const p = report.policy;
  if (!p) return [];
  const at = `read at ${code(short(p.base))}`;
  const each = (list: Array<{ rule: string; message: string }>): string[] => list.map((f) => `- ${code(f.rule)}: ${f.message}`);
  const out: string[] = [""];
  if (p.result === "error") out.push(`Policy (${p.engine}, ${at}) could not be checked, so nothing applies: ${p.error ?? "no answer"}.`);
  else if (p.result === "passed") out.push(`Policy (${p.engine}, ${at}) passed.`);
  if (p.denials.length > 0) {
    out.push(p.override ? `Policy (${p.engine}, ${at}) denied this plan; ${code(p.override.by)} overrode it: ${p.override.reason}` : `Policy (${p.engine}, ${at}) denied this plan:`, ...each(p.denials));
    if (!p.override && p.overrideCommand) out.push("", `A person the overriders file at base lists may override it once pr-apply has recorded the denial: ${code(p.overrideCommand)}`);
  }
  if (p.holds.length > 0) out.push(`Policy (${p.engine}, ${at}) holds this plan for a person's approval of its digest:`, ...each(p.holds));
  if (p.warnings.length > 0) out.push(`Policy warnings: ${p.warnings.join("; ")}`);
  return out;
}

/**
 * The findings capabilities' plans carried (#4550), in the product's words:
 * a denial with the product's override line, then each advisory finding as
 * a row.
 */
function capabilityPolicyLines(report: PrReport, words: CiProductWords): string[] {
  const all = report.capabilityPolicy ?? [];
  if (all.length === 0) return [];
  const out: string[] = [];
  for (const p of all.filter((x) => x.denied)) {
    out.push("", `The policy in ${code(p.member)}'s ${words.verbs.plan[0]} denied it, so nothing can apply:`, ...p.denials.map((d) => `- ${code(d.rule)}: ${d.message}`));
    if (p.denials.length > 0) out.push("", `A person the overriders file at base lists may override it: ${code(overrideLine(words, { op: "policy-override", gate: report.gate, target: p.member, rules: p.denials.map((d) => d.rule) }))}`);
  }
  const rows = all.flatMap((p) => [
    ...(p.denied ? [] : p.denials).map((d) => [p.member, d.rule, "denied", d.message]),
    ...p.holds.map((d) => [p.member, d.rule, "advisory", d.message]),
    ...p.warnings.map((w) => [p.member, "", "warning", w]),
  ]);
  if (rows.length > 0) {
    out.push("", `| ${capital(words.noun[0])} | Rule | Finding | Message |`, "|---|---|---|---|");
    for (const [m, rule, kind, message] of rows) out.push(`| ${code(m!)} | ${rule ? code(rule) : ""} | ${kind} | ${message!.replaceAll("|", "\\|").replaceAll("\n", " ")} |`);
  }
  return out;
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
function waveLines(report: PrReport, approver: string, words: CiProductWords): string[] {
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
      ...waveApproveCommands(report, w, approver, words),
      "```",
      "",
      "Then run the wave's apply job again.",
    );
  }
  return out;
}

/** A waiting wave's approve lines: one per component when the product's template names `{target}` (#4601). */
function waveApproveCommands(report: PrReport, w: PrWave, approver: string, words: CiProductWords): string[] {
  const targets = words.approve.includes("{target}") ? (w.components.length > 0 ? w.components : [report.env]) : [];
  if (targets.length === 0) return [prApproveCommand({ op: report.op, gate: w.gate, digest: w.digest }, approver, words)];
  return targets.map((target) => prApproveCommand({ op: report.op, gate: w.gate, digest: w.digest, target }, approver, words));
}

/**
 * The note's sentence on what the merge does with the plan (#4601), by the
 * product's apply mode. chant's words keep chant's sentence, which covers
 * the record on merge and the opt-in apply on merge alike.
 */
export function prMergeSentence(report: Pick<PrReport, "gate">, words: CiProductWords = activeProductWords()): string {
  const applied = words.verbs.apply[1];
  switch (words.applyMode) {
    case "on-merge": {
      if (words.approval === "per-wave") {
        return `On merge the waves are ${applied} in order, each under an approval of its own gate for its own plan. A wave whose plan moved since this note waits at its gate for a new approval.`;
      }
      const waveGate = words.gateName.replace("{gate}", report.gate).replace("{k}", "<k>");
      return `On merge the waves are ${applied} in order under this approval, each while its plan is one this approval covers. A wave whose plan moved waits at its own gate, ${code(waveGate)}, for an approval of its own.`;
    }
    case "before-merge": {
      const comment = commentLine(words, "apply");
      return `Before merge, ${comment ? code(comment) : "the apply job"} runs this plan once the pull request is approved, mergeable and green, and only while the plan is still this one; if it moved, the apply refuses and names both digests. The merge records what was ${applied}.`;
    }
    case "release":
      return "On merge the plan is recorded, and a release deploys it. With apply on merge it applies if the plan is still this one; if it moved, the apply refuses and names both digests.";
  }
}

function approvalLines(report: PrReport, approver: string, words: CiProductWords): string[] {
  const a = report.approval;
  if (report.status === "nothing") return [];
  if (a.status === "approved") return [`Approved by ${(a.approvedBy ?? []).map(code).join(", ")} for this digest.`];
  const lines =
    a.status === "changed"
      ? [`An approval stands for ${code(a.approved ?? "(none)")}, not for this digest: the plan changed since it was approved.`]
      : [report.stage === "record" ? "No approval stands for this plan. The release gate decides before it deploys." : "Not approved yet."];
  if (report.stage === "plan" && report.status === "planned") {
    const commands = prApproveCommands(report, approver, words);
    lines.push(
      "",
      commands.length > 1 ? `A reviewer who approved this pull request approves each ${words.noun[0]}'s plan with:` : "A reviewer who approved this pull request approves the plan with:",
      "",
      "```",
      ...commands,
      "```",
      "",
      prMergeSentence(report, words),
    );
  }
  return lines;
}

/**
 * One row of the note for a change-set entry the planner marked `mayAppear`
 * (#4548): a resource a component registers inside an `apply()` that the
 * preview could not run, so it is known only when the apply runs.
 */
export interface PrMayAppearRow {
  member: string;
  /**
   * The component resource that registers it, as `<type> <name>`. Only the
   * type when the entry names no single component (its URN carries the parent
   * type chain, not the parent's name), and `the stack` when it has none.
   */
  component: string;
  /** The resource, as `<type> <name>`; absent on the entry that stands for whatever the component may register. */
  resource?: string;
  /** The entry's action: `create` for the stand-in entry, else what the plan says about a resource the last deployment holds. */
  action: ChangeSetAction;
}

const typeAndName = (urn: string): string => {
  const p = parsePulumiUrn(urn);
  return p ? `${p.type} ${p.name}` : urn;
};

/**
 * The note's rows for the `mayAppear` entries of a change set, sorted by
 * member and component. A stand-in entry (`pulumiMayAppearAddress`) names its
 * component from its own address. Any other entry names the component whose
 * stand-in entry in the same member sits on its parent type chain, when one
 * does; else the type of its parent.
 */
export function prMayAppearRows(doc: Pick<ChangeSetDocument, "entries">): PrMayAppearRow[] {
  const flagged = new Map<string, Array<{ urn: string; chain: string }>>();
  for (const e of doc.entries) {
    if (e.mayAppear !== true) continue;
    const parent = pulumiMayAppearParent(e.address);
    const parsed = parent ? parsePulumiUrn(parent) : undefined;
    if (!parent || !parsed) continue;
    flagged.set(e.member, [...(flagged.get(e.member) ?? []), { urn: parent, chain: parsed.qualifiedType }]);
  }
  const componentOf = (e: ChangeSetEntry): string => {
    const parsed = parsePulumiUrn(e.address);
    if (!parsed) return "the stack";
    const parents = parsed.parentTypes.join("$");
    const under = (flagged.get(e.member) ?? []).filter((c) => parents === c.chain || parents.startsWith(`${c.chain}$`));
    // The nearest component: the longest chain that holds the entry.
    const longest = Math.max(-1, ...under.map((c) => c.chain.length));
    const nearest = under.filter((c) => c.chain.length === longest);
    if (nearest.length === 1) return typeAndName(nearest[0].urn);
    return parsed.parentTypes.at(-1) ?? "the stack";
  };
  const rows: PrMayAppearRow[] = [];
  for (const e of doc.entries) {
    if (e.mayAppear !== true) continue;
    const parent = pulumiMayAppearParent(e.address);
    rows.push(parent ? { member: e.member, component: typeAndName(parent), action: e.action } : { member: e.member, component: componentOf(e), resource: typeAndName(e.address), action: e.action });
  }
  const key = (r: PrMayAppearRow) => `${r.member}\u0000${r.component}\u0000${r.resource === undefined ? "" : `\u0001${r.resource}`}`;
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The words of one may-appear row's last cell. `apply` is the product's word
 * for the apply (a fixed slot, #4550): plywood's is `up`.
 */
export function prMayAppearText(row: PrMayAppearRow, apply = "apply"): string {
  if (row.resource === undefined) return `may register at ${apply}`;
  if (row.action === "delete") return `planned to delete, and may register again at ${apply}`;
  return `missing from the preview, and may register at ${apply}`;
}

/**
 * The may-appear lines of the note (#4548): a row per `mayAppear` entry,
 * naming the component resource that registers it.
 */
function mayAppearLines(report: PrReport, apply: string): string[] {
  const rows = prMayAppearRows(report.changeSet);
  if (rows.length === 0) return [];
  const out = [
    "",
    `Registered inside an \`apply()\` the preview could not run, so known only at ${apply}:`,
    "",
    "| Member | Component resource | Resource | At " + apply + " |",
    "|---|---|---|---|",
  ];
  for (const r of rows) out.push(`| ${code(r.member)} | ${code(r.component)} | ${r.resource === undefined ? "any resource it registers" : code(r.resource)} | ${prMayAppearText(r, apply)} |`);
  return out;
}

/**
 * The pull-request note: the stage's headline, a row per member, the digest
 * and the approval, then the grouped plan summary (#3188) in whatever room
 * `limit` leaves. The note starts with {@link prNoteMarker}, so the same
 * comment is updated by every push and by the apply. `applyWord` is the
 * product's word for the apply in the may-appear rows (#4548), `apply` by
 * default.
 */
export function renderPrNote(report: PrReport, options: { limit?: number; approver?: string; applyWord?: string; words?: CiProductWords } = {}): string {
  const limit = options.limit ?? GITHUB_COMMENT_LIMIT;
  // #4550: the product's words in chant's sentences (ruling D: fixed slots).
  const words = options.words ?? activeProductWords();
  const STATUS_WORDS = statusWords(words);
  const noun = words.noun[0];
  const out: string[] = [
    prNoteMarker(report.env, report.member),
    `### ${words.product} ${words.stages[report.stage]} for ${code(report.env)}${report.member ? ` in ${noun} ${code(report.member)}` : ""}`,
    "",
    `${headline(report, words)} Head ${code(short(report.head))}, measured from ${code(short(report.base))}.`,
  ];
  if (report.message) out.push("", `> ${report.message.split("\n").join("\n> ")}`);
  for (const o of report.overdue ?? []) out.push("", `Warning: ${o.message}`);
  if (report.resumed && report.resumed.applied.length > 0) {
    out.push("", `Resumed under the same approval: ${report.resumed.applied.map(code).join(", ")} applied in an earlier attempt and did not run again.`);
  }
  if (report.members.length > 0) {
    out.push("", `| ${capital(noun)} | Component | Status | Create | Update | Replace | Delete |`, "|---|---|---|---:|---:|---:|---:|");
    for (const m of report.members) {
      const holes = memberHoleReasons(report, m.member);
      // #4463: a member planned with stand-in values says so, naming them.
      const placeholders = report.changeSet.members.find((x) => x.member === m.member)?.placeholders ?? [];
      const status =
        STATUS_WORDS[m.status] +
        (m.status === "blocked" && m.blockedBy ? ` by ${code(m.blockedBy)}` : "") +
        (m.groupOutcome === "partial" ? ", applied in part" : m.groupOutcome === "no-changes" ? ", no changes" : "") +
        (m.inputsMoved?.length ? `, inputs from ${m.inputsMoved.join(", ")} moved` : "") +
        (placeholders.length > 0 ? `, previewed with placeholders for ${placeholders.map(code).join(", ")}` : "") +
        // #4626: a member whose plan was narrowed says to what.
        (report.narrowed?.[m.component] ? `, narrowed to ${report.narrowed[m.component]!.map(code).join(", ")}` : "") +
        (holes.length > 0 ? `; ${holes.length > 2 ? `${holes[0]}; and ${holes.length - 1} more, listed under Holes` : holes.join("; ")}` : "");
      // A member whose plan has holes and no entries says nothing about what
      // it changes, so its counts are unknown, not zero (#4084).
      const unknown = holes.length > 0 && !report.changeSet.entries.some((e) => e.member === m.member);
      const n = (k: keyof PrMemberCounts): string => (unknown ? "?" : String(m.counts[k]));
      out.push(`| ${code(m.member)} | ${m.component} | ${status} | ${n("create")} | ${n("update")} | ${n("replace")} | ${n("delete")} |`);
    }
    if (report.members.some((m) => m.inputsMoved?.length)) {
      out.push("", `A ${noun} whose inputs moved ${words.verbs.apply[1]} the plan it was approved with. The next run plans it against the new values.`);
    }
  }
  out.push(...narrowedLines(report, words));
  out.push(...mayAppearLines(report, options.applyWord ?? words.stages.apply));
  const blocked = blockedLine(report.members);
  if (blocked) out.push("", blocked);
  out.push(...crossStackLines(report));
  out.push(...groupLines(report));
  out.push(...waveLines(report, options.approver ?? "<you>", words));
  // #4288: the hooks that did not pass, by name; a passed hook is a count.
  const hooks = report.hooks ?? [];
  if (hooks.length > 0) {
    const passed = hooks.filter((h) => h.outcome === "passed").length;
    const other = hooks.filter((h) => h.outcome !== "passed").map((h) => `${code(h.name)} ${h.moment}${h.target ? ` for ${code(h.target)}` : ""} ${h.outcome === "held" ? "held" : "failed"} (exit ${h.exit})`);
    out.push("", `Hooks: ${passed} passed${other.length > 0 ? `; ${other.join("; ")}` : ""}.`);
  }
  out.push(...policyLines(report));
  out.push(...capabilityPolicyLines(report, words));
  out.push(...renderMigrationLines(report.migrations));
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
      `Known only after apply: ${unknown.join("; ")}. ` +
        "The apply plans those members again once their upstream applied. When that plan does only what this one shows, with only those inputs filled in, this approval covers it; anything else asks for an approval of its own.",
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
    if (r.covered) {
      const filled = r.covered.filledInputs.length > 0 ? `, with ${r.covered.filledInputs.map(code).join(", ")} filled in` : "";
      out.push("", `${what}: covered by the approval of ${code(r.covered.digest)}${filled}, so it ${r.status === "applied" ? "applied" : "did not apply"} without a new approval${r.status === "failed" ? " (the apply failed)" : ""}.`);
      continue;
    }
    if (r.notCovered) out.push("", `Round ${r.round}'s plan is not covered by the approval of ${code(report.digest)}: ${r.notCovered}.`);
    if (r.status === "waiting") {
      if (r.message) out.push("", `> ${r.message}`);
      out.push("", `${what}. Not approved yet. Approve it, then run the apply again with the same \`--resume\` record:`, "", "```", prApproveCommand({ op: report.op, gate: r.gate, digest: r.digest }, options.approver ?? "<you>", words), "```");
    } else {
      out.push("", `${what}: ${r.status === "applied" ? `applied, approved by ${(r.approval.approvedBy ?? []).map(code).join(", ")}` : r.status === "plan-failed" ? "a member failed to plan" : "the apply failed"}.`);
    }
  }
  if (report.status !== "nothing") {
    out.push("", `Plan digest: ${code(report.digest)}`, "", ...approvalLines(report, options.approver ?? "<you>", words));
  }
  // #4003: with a gate per wave, a later wave's plan on merge may differ from this one.
  if (report.stage === "plan" && report.status === "planned" && report.waveGate) {
    out.push("", `On merge each wave after the first is planned again once the waves before it apply, and a wave whose plan moved stops at its own gate, ${code(words.gateName.replace("{gate}", report.waveGate).replace("{k}", "<k>"))}, for approval.`);
  }
  let head = out.join("\n") + "\n";
  // #4573: each member's lexicon-rendered section, kept within the comment limit with room left for the summary.
  head += memberDetailSections(report, limit - [...head].length - 400, noun);
  if (report.status === "nothing" || report.changeSet.members.length === 0) return head;
  const room = limit - [...head].length - 1;
  if (room < 400) return head;
  return head + "\n" + renderPlanSummaryMarkdown(groupChangeSet(report.changeSet), { limit: room, command: "chant change-set summary .chant/pr/change-set.json" });
}

/**
 * The member detail sections (#4573), each in a `<details>` block under the
 * member it belongs to. A section that does not fit in `room` is left out
 * and named, so the note stays within the forge's comment limit.
 */
function memberDetailSections(report: PrReport, room: number, noun: string): string {
  const out: string[] = [];
  let used = 0;
  const left: string[] = [];
  for (const d of report.details ?? []) {
    if (d.lines.length === 0) continue;
    const block = ["", `<details><summary>${d.title ?? `${capital(noun)} ${code(d.member)}`}</summary>`, "", ...d.lines, "", "</details>"].join("\n");
    const size = [...block].length;
    if (used + size > room - 200) {
      left.push(d.member);
      continue;
    }
    used += size;
    out.push(block);
  }
  if (left.length > 0) out.push("", `Left out to keep this note within the comment limit: the detail of ${left.map(code).join(", ")}. The report artifact carries it.`);
  return out.length > 0 ? out.join("\n") + "\n" : "";
}

/**
 * The note's line for a narrowed plan (#4626): which of the plan's
 * components were narrowed and to how many addresses, and that the plan on
 * merge is of each whole, in the product's words.
 */
function narrowedLines(report: PrReport, words: CiProductWords): string[] {
  const narrowed = Object.entries(report.narrowed ?? {}).filter(([, a]) => a.length > 0);
  if (narrowed.length === 0) return [];
  const each = narrowed.map(([c, a]) => `${code(c)} to ${a.map(code).join(", ")}`).join("; ");
  return ["", `This ${words.verbs.plan[0]} was narrowed with \`--target\`: ${each}. The approval binds the narrowed plan. On merge each ${words.noun[0]} is ${words.verbs.plan[1]} whole.`];
}

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
