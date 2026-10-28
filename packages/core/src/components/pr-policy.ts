/**
 * Gate-time policy on the pull-request path (#4294): `ci.policy` in the
 * workspace declaration, run by `chant components pr-plan` and `pr-apply`
 * over the change-set document the gate binds (`CapabilityPlan.changeSet`,
 * composed by `planPrSet`).
 *
 * The settings and the policy directory are both read at the base the job
 * measures the change from, so a pull request cannot loosen, edit or delete
 * the policy that judges it. The engine and its result shapes are
 * `../gate-policy.ts`.
 *
 * - deny: pr-apply applies nothing unless an override counts
 *   (`../override-gate.ts`, subject the gate's op, such as `pr-12`). The
 *   first refusal records the denial on `_gates/policy-override.jsonl`, so
 *   `chant approve policy-override <op> --rule <id> --reason <text>` can
 *   answer it. The gate's own approval is still needed. The override is
 *   spent just before anything applies.
 * - hold: the plan needs a person's approval of its own digest. pr-apply
 *   always asks for one, so a hold changes one path: a green commit's plan
 *   no longer applies under the approvals of the merges it carries.
 * - error: the policy did not run or gave no readable answer. pr-apply
 *   applies nothing.
 *
 * A policy also reads `input.review` (#4326): the risk the pull request's
 * review note names, when the review agent posted one ({@link policyReviewOf}).
 *
 * `ci.policy.source` (#4613) names a shared repository and ref instead of
 * the workspace's own directory. The source is named at base, fetched once
 * per job (`../policy-source.ts`), and the commit its ref named goes on the
 * verdict and the report, so a decision names the rules it used. A source
 * that cannot be fetched is an error, and nothing applies.
 */

import { readDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { locateWorkspace } from "../workspace/which-chant";
import type { WorkspaceTree } from "../workspace/tree";
import { fetchGatePolicySourceOnce, type ResolvedGatePolicySource } from "../policy-source";
import {
  checkGatePolicy,
  DEFAULT_POLICY_PATH,
  exportGatePolicy,
  type GatePolicyExec,
  type GatePolicySettings,
  type GatePolicyVerdict,
} from "../gate-policy";
import type { ChangeSetDocument } from "../change-set";
import type { GateLedgerPort } from "../op/gate";
import type { PrPolicyReport } from "../pr-loop";
import type { PrForge } from "../pr-forge";
import { parseReviewResult, REVIEW_MARKER_PREFIX, type ReviewRisk } from "../op/activities/review-agent";

/** `ci.policy` as read at base. */
export interface PrLoopPolicy {
  /** Absent when the declaration at base sets none. */
  settings?: GatePolicySettings;
  /** The commit it was read at. */
  base: string;
  /**
   * Where the policy directory is read: the tree of the declaration's
   * directory at base, or with `ci.policy.source` the shared repository's
   * tree at the commit its ref named.
   */
  tree?: WorkspaceTree;
  /** The shared source the tree is (#4613), with the commit fetched. */
  source?: ResolvedGatePolicySource;
  /** Why the source named at base could not be read. Every policy run is then an error. */
  error?: string;
  /** A line for the log when no policy runs because the base has no declaration, or could not be read. */
  note?: string;
}

/** Whether the working tree's declaration names a `ci.policy`. */
function checkoutNamesPolicy(cwd: string): boolean {
  try {
    return readDeclaration(locateWorkspace(cwd).tree).ci?.policy !== undefined;
  } catch {
    return false;
  }
}

/**
 * The policy a pull-request job in `cwd` runs, from the declaration at
 * `base`. Throws when the declaration at base cannot be read and the
 * working tree's names a policy: running none would let the change waive it.
 */
export function prLoopPolicyAt(cwd: string, base: string): PrLoopPolicy {
  try {
    const located = locateWorkspace(cwd, base);
    const settings = readDeclaration(located.tree).ci?.policy;
    if (!settings) return { base };
    if (!settings.source) return { base, settings, tree: located.tree };
    const fetched = fetchGatePolicySourceOnce(settings.source);
    if ("error" in fetched) return { base, settings, error: fetched.error };
    return { base, settings, tree: fetched.tree, source: fetched.source };
  } catch (err) {
    const missing = err instanceof WorkspaceReadError && (err.code === "declaration-missing" || err.code === "not-a-git-repository");
    const why = err instanceof Error ? err.message : String(err);
    if (checkoutNamesPolicy(cwd)) {
      if (missing) return { base, note: `ci.policy: the base ${base.slice(0, 12)} has no workspace declaration, so the policy this change declares runs once it merges` };
      throw new Error(`ci.policy is read from the workspace declaration at ${base.slice(0, 12)}, and it could not be read (${why}), so the policy cannot be run`);
    }
    return missing ? { base } : { base, note: `ci.policy: the declaration at ${base.slice(0, 12)} could not be read (${why}); this checkout names no policy, so none runs` };
  }
}

/** What the engine reads as `input`. */
export interface PrPolicyInput {
  version: 1;
  stage: "plan" | "apply";
  /** The gate's op, `pr-<n>`. */
  op: string;
  gate: string;
  env: string;
  pr: number | null;
  base: string;
  head: string;
  /** The change-set document the gate binds. Its `entries` are every change the plan proposes. */
  changeSet: ChangeSetDocument;
  /** What the pull request's review note says (#4326). Absent only when the caller did not look. */
  review?: PolicyReview;
}

/**
 * The review agent's finding as a policy reads it, `input.review`. The risk is
 * the model's, so a policy treats it as one signal beside the change set, never
 * as a verdict. `head` is the commit the review read; a policy that cares
 * whether the review is current compares it with `input.head`.
 */
export interface PolicyReview {
  /** Whether a review note written by the run's own token was found on the pull request. */
  found: boolean;
  /** The risk the review named, or `unknown` when none was found, the command failed or the review gave none. */
  risk: ReviewRisk | "unknown";
  /** The commit the review read, or null when none was found. */
  head: string | null;
  /** Why nothing was found, for the log. Absent when a review was. */
  reason?: string;
}

/**
 * The users the run's own token acts as on GitHub and Forgejo. Only a note one
 * of them wrote counts as the review: a pull request's author can post a
 * comment that starts with the marker, and cannot post as these.
 */
export const REVIEW_NOTE_AUTHORS: readonly string[] = ["github-actions[bot]", "gitea-actions", "forgejo-actions"];

/**
 * The review of pull request `pr`, read from the sticky note the review job
 * posted (`postReviewNote`, ../op/activities/review-agent.ts). A forge that
 * cannot be read, a pull request that is not known and a note nobody trusted
 * all give `found: false`, which a policy sees as `risk: "unknown"`.
 */
export async function policyReviewOf(forge: PrForge | undefined, pr: number | null): Promise<PolicyReview> {
  const none = (reason: string): PolicyReview => ({ found: false, risk: "unknown", head: null, reason });
  if (!forge) return none("no forge client, so no pull request note was read");
  if (pr === null) return none("no pull request to read a review from");
  let note;
  try {
    note = await forge.findComment(pr, REVIEW_MARKER_PREFIX, { author: REVIEW_NOTE_AUTHORS });
  } catch (err) {
    return none(`could not read the notes of #${pr}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!note) return none(`#${pr} has no review note written by the run's token`);
  const result = parseReviewResult(note.body);
  if (!result) return none(`the review note on #${pr} names no head and risk`);
  return { found: true, risk: result.risk, head: result.head };
}

/** The Rego directory a read names: the source's `path`, else `ci.policy.path`, else the default, and whether one was named. */
export function prPolicyPath(read: Pick<PrLoopPolicy, "settings" | "source">): { path: string; named: boolean } {
  const named = read.source ? read.settings?.source?.path : read.settings?.path;
  return { path: read.source?.path ?? named ?? DEFAULT_POLICY_PATH, named: named !== undefined };
}

/**
 * Run the policy over `input`. Undefined when the base sets no policy, or
 * sets only `packs` (CrossGuard, run by the pulumi lexicon's preview) and
 * names no Rego directory that exists.
 */
export function runPrPolicy(read: PrLoopPolicy, input: PrPolicyInput, exec?: GatePolicyExec): GatePolicyVerdict | undefined {
  if (!read.settings) return undefined;
  const engine = read.settings.engine ?? "conftest";
  const source = read.source ? { source: read.source } : {};
  if (read.error !== undefined) return { result: "error", engine, denials: [], rules: [], holds: [], warnings: [], error: read.error };
  if (!read.tree) return undefined;
  const { path, named } = prPolicyPath(read);
  // ci.policy with only packs: no Rego runs unless its directory is there.
  if (!named && read.settings.packs?.length && read.tree.stat(path) === undefined) return undefined;
  const exported = exportGatePolicy(read.tree, path);
  if ("error" in exported) {
    const where = read.source ? `${read.source.repo}@${read.source.ref} (${read.source.commit.slice(0, 12)})` : "base";
    return { result: "error", engine, denials: [], rules: [], holds: [], warnings: [], error: read.source ? `the policy directory ${path} does not exist in ${where}` : exported.error, ...source };
  }
  try {
    return { ...checkGatePolicy({ settings: read.settings, input, policyDir: exported.dir, cwd: process.cwd(), ...(exec ? { exec } : {}) }), ...source };
  } finally {
    exported.cleanup();
  }
}

/** The verdict as the report keeps it. */
export function prPolicyReport(verdict: GatePolicyVerdict, base: string): PrPolicyReport {
  return {
    result: verdict.result,
    engine: verdict.engine,
    base,
    denials: verdict.denials,
    ...(verdict.rules.length > 0 ? { rules: verdict.rules } : {}),
    holds: verdict.holds,
    warnings: verdict.warnings,
    ...(verdict.error !== undefined ? { error: verdict.error } : {}),
    ...(verdict.source ? { source: { ...verdict.source } } : {}),
  };
}

export interface PrPolicyOverrideInput {
  port: GateLedgerPort;
  /** The override's subject: the gate's op. */
  subject: string;
  /** The digest the gate binds: the change-set document's. */
  digest: string;
  rules: readonly string[];
  /** The commit the overriders and signers are read at. */
  base: string;
  cwd: string;
  /** Count only sealed overrides, as a sealed gate counts only sealed approvals. */
  sealed: boolean;
  /** Record the denial when no override counts and none stands. The plan stage records nothing. */
  record: boolean;
  description?: string;
  now?: string;
}

/** Where an override of a denial stands. */
export type PrPolicyOverride =
  | { status: "overridden"; override: NonNullable<PrPolicyReport["override"]> }
  | { status: "none"; refusals: string[]; command: string; overriders: string[]; recorded: boolean; moved?: { by: string } };

/**
 * Decide a denied plan against the override ledger, as an Op waves job
 * decides a denied run (`settleDenials` in `../op/op-waves-run.ts`).
 */
export async function decidePrPolicyOverride(input: PrPolicyOverrideInput): Promise<PrPolicyOverride> {
  const og = await import("../override-gate");
  const overriders = og.overridersAt(input.cwd, input.base).principals;
  const signers = input.sealed ? (await import("../gate-decision")).gateSignersAt(input.cwd, input.base) : undefined;
  const ledger = await input.port.read(og.OVERRIDE_OP);
  const applied = ((await input.port.readApplied?.(og.OVERRIDE_OP)) ?? []) as unknown as import("../override-gate").AppliedOverrideRecord[];
  const now = input.now ?? new Date().toISOString();
  const verdict = og.decideOverride({
    ledger,
    applied,
    subject: input.subject,
    planDigest: input.digest,
    rules: input.rules,
    overriders,
    mode: input.sealed ? "sealed" : "ledger",
    ...(signers ? { signers } : {}),
    now,
  });
  if (verdict.status === "overridden") {
    const o = verdict.override;
    return { status: "overridden", override: { by: o.by, at: o.at, reason: o.reason, digest: o.digest } };
  }
  let recorded = false;
  if (input.record && !verdict.standing) {
    const { version: _v, kind: _k, ...fact } = og.overridePending({
      subject: input.subject,
      planDigest: input.digest,
      rules: input.rules,
      timestamp: now,
      expiresAt: new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString(),
      ...(input.description ? { description: input.description } : {}),
    });
    await input.port.appendPending(fact);
    recorded = true;
  }
  return {
    status: "none",
    refusals: verdict.refusals,
    command: og.overrideCommand(input.subject, input.rules, input.sealed),
    overriders,
    recorded,
    ...(verdict.status === "moved" ? { moved: { by: verdict.by } } : {}),
  };
}

/**
 * Spend the override the apply runs under: append its applied record before
 * anything applies. Throws when it could not be written or did not reach the
 * remote, and the caller applies nothing.
 */
export async function spendPrPolicyOverride(port: GateLedgerPort, subject: string, override: NonNullable<PrPolicyReport["override"]>, at: { now?: string; commit?: string } = {}): Promise<void> {
  const og = await import("../override-gate");
  if (!port.appendApplied) throw new Error("this gate ledger cannot record an applied override");
  const record = og.appliedOverride({ subject, digest: override.digest, at: override.at, by: override.by }, { timestamp: at.now ?? new Date().toISOString(), ...(at.commit ? { commit: at.commit } : {}) });
  const pushed = await port.appendApplied(record as unknown as Parameters<NonNullable<GateLedgerPort["appendApplied"]>>[0]);
  const { isLifecycleLocalNote } = await import("../lifecycle/local-note");
  if (!pushed.pushed && !isLifecycleLocalNote(pushed.pushWarning)) {
    throw new Error(`the applied record did not reach the remote the next run reads: ${pushed.pushWarning ?? "the push did not land"}`);
  }
}
