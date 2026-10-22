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
 */

import { readDeclaration, WorkspaceReadError } from "../workspace/declaration";
import { locateWorkspace } from "../workspace/which-chant";
import type { WorkspaceTree } from "../workspace/tree";
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

/** `ci.policy` as read at base. */
export interface PrLoopPolicy {
  /** Absent when the declaration at base sets none. */
  settings?: GatePolicySettings;
  /** The commit it was read at. */
  base: string;
  /** The tree of the declaration's directory at base, where the policy directory is read. */
  tree?: WorkspaceTree;
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
    return { base, ...(settings ? { settings, tree: located.tree } : {}) };
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
}

/** Run the policy over `input`. Undefined when the base sets no policy. */
export function runPrPolicy(read: PrLoopPolicy, input: PrPolicyInput, exec?: GatePolicyExec): GatePolicyVerdict | undefined {
  if (!read.settings || !read.tree) return undefined;
  const engine = read.settings.engine ?? "conftest";
  const path = read.settings.path ?? DEFAULT_POLICY_PATH;
  const exported = exportGatePolicy(read.tree, path);
  if ("error" in exported) return { result: "error", engine, denials: [], rules: [], holds: [], warnings: [], error: exported.error };
  try {
    return checkGatePolicy({ settings: read.settings, input, policyDir: exported.dir, cwd: process.cwd(), ...(exec ? { exec } : {}) });
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
