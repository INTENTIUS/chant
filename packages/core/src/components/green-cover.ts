/**
 * Apply on merge per green commit (#4168 step 9): whether the change sets
 * approved for the merges since the last applied green commit cover the plan
 * at the green one.
 *
 * Each member of the fresh plan is checked against the newest approved change
 * set that planned it, with the same rule `pr-apply` uses for one pull request
 * (`planCoveredBy`, ./pr-run.ts). A member with nothing to do is covered by
 * nothing. Any member left uncovered sends the whole plan to a gate of its own,
 * bound to the combined digest.
 */

import { execFileSync } from "node:child_process";
import type { ChangeSetDocument } from "../change-set";
import type { GateLedgerPort } from "../op/gate";
import { planCoveredBy } from "./pr-run";

/** One merge's approved change set, with who approved it. */
export interface ApprovedMerge {
  commit: string;
  pr?: number;
  doc: ChangeSetDocument;
  approvedBy: readonly string[];
}

export interface GreenCover {
  covered: boolean;
  /** Why each uncovered member is not covered, one line each. */
  uncovered: string[];
  /** The approvers of the change sets that covered a member, sorted. */
  approvedBy: string[];
  /** The merges whose approval covered a member, in trunk order. */
  coveredBy: string[];
}

/** Whether `member` has anything to apply in `doc`. */
function hasWork(doc: ChangeSetDocument, member: string): boolean {
  const m = doc.members.find((x) => x.member === member);
  if (m && m.status === "failed") return true;
  if (doc.entries.some((e) => e.member === member && e.action !== "no-op" && e.action !== "read")) return true;
  return (doc.sideEffects ?? []).some((s) => s.member === member);
}

/**
 * Check `fresh` against `merges`, given oldest first, as the first-parent
 * history between the last applied green commit and this one runs.
 */
export function coverByMerges(fresh: ChangeSetDocument, merges: readonly ApprovedMerge[]): GreenCover {
  const uncovered: string[] = [];
  const approvers = new Set<string>();
  const used = new Set<string>();
  for (const member of fresh.members.map((m) => m.member)) {
    if (!hasWork(fresh, member)) continue;
    const newest = [...merges].reverse().find((m) => m.doc.members.some((x) => x.member === member));
    if (!newest) {
      uncovered.push(`${member}: no merge since the last applied green commit had an approved plan for it`);
      continue;
    }
    const why = planCoveredBy(newest.doc, fresh, member);
    if (why) {
      uncovered.push(`${why} (checked against ${newest.pr !== undefined ? `#${newest.pr}` : newest.commit.slice(0, 12)})`);
      continue;
    }
    used.add(newest.commit);
    for (const a of newest.approvedBy) approvers.add(a);
  }
  return {
    covered: uncovered.length === 0,
    uncovered,
    approvedBy: [...approvers].sort(),
    coveredBy: merges.filter((m) => used.has(m.commit)).map((m) => m.commit),
  };
}

/** The green commit `pr-apply --green` applies, what it is measured from, and the approved merges between. */
export interface GreenTarget {
  commit: string;
  /** The last green commit applied to the environment, else `--base`, else the green commit before this one, else its parent. */
  base: string;
  /** Where `base` came from. */
  baseFrom: "applied" | "flag" | "previous-green" | "parent";
  /** The first-parent commits after `base` up to `commit`, oldest first. */
  merges: string[];
  /** Their pull requests, from the merge records, in trunk order. */
  prs: number[];
  /** The merges whose approved change set still stands, oldest first. */
  approved: ApprovedMerge[];
}

export type GreenTargetResult =
  | { status: "target"; target: GreenTarget }
  /** The checkout is the green commit last applied. */
  | { status: "applied"; commit: string }
  | { status: "error"; message: string; hint?: string };

function gitOut(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the green target for `env` at `cwd`'s HEAD (#4168 step 9). HEAD must
 * carry a counting `ci/green` tag and no `ci/revoked` one, judged by the
 * declaration's `ci.green` as `release cut` judges them. Reads the local tags
 * and `chant/lifecycle` and never fetches.
 */
export async function resolveGreenTarget(req: { cwd: string; env: string; base?: string; gate: string; ledger?: GateLedgerPort }): Promise<GreenTargetResult> {
  const { readGreen, CI_GREEN_TAG_PREFIX } = await import("../workspace/ci-green");
  const { judgedCiTags } = await import("../lifecycle/release-revocation");
  let green: ReturnType<typeof readGreen>["green"];
  let top: string;
  try {
    ({ green, top } = readGreen(req.cwd));
  } catch (err) {
    return {
      status: "error",
      message: `apply on merge applies green commits (#4168), and ${err instanceof Error ? err.message : String(err)}`,
      hint: "Declare ci.green in chant.workspace.json, or run chant ci init --workflow trunk-curated+apply-on-merge.",
    };
  }
  const head = gitOut(req.cwd, ["rev-parse", "HEAD"]);
  if (!head) return { status: "error", message: "pr-apply --green applies the checkout's HEAD, and it has none" };
  const tags = await judgedCiTags(top, green);
  const counts = (sha: string) => tags.green.has(sha) && !tags.revoked.has(sha);
  if (!counts(head)) {
    return {
      status: "error",
      message: `${head.slice(0, 12)} is not a green commit (no counting ${CI_GREEN_TAG_PREFIX}${head.slice(0, 12)}… tag, or a ci/revoked one), so apply on merge does not apply it`,
      hint: "Check out the newest green commit first: git checkout --detach \"$(chant ci last-green)\"",
    };
  }

  const { readGreenApply } = await import("../lifecycle/green-apply");
  const last = await readGreenApply(req.env, { cwd: req.cwd });
  if (last?.commit === head) return { status: "applied", commit: head };
  let base: string | undefined;
  let baseFrom: GreenTarget["baseFrom"] = "applied";
  if (last && gitOut(req.cwd, ["merge-base", "--is-ancestor", last.commit, head]) !== undefined) base = last.commit;
  if (!base && req.base) {
    base = gitOut(req.cwd, ["rev-parse", "--verify", "--quiet", `${req.base}^{commit}`]);
    baseFrom = "flag";
    if (!base) return { status: "error", message: `--base ${req.base} names no commit here` };
  }
  if (!base) {
    const before = (gitOut(req.cwd, ["rev-list", "--first-parent", `${head}^`]) ?? "").split("\n").filter(Boolean);
    base = before.find(counts);
    baseFrom = "previous-green";
    if (!base) {
      base = before[0];
      baseFrom = "parent";
    }
  }
  if (!base) return { status: "error", message: `${head.slice(0, 12)} is a root commit, so there is nothing to measure its change from; pass --base` };

  const merges = (gitOut(req.cwd, ["rev-list", "--first-parent", "--reverse", `${base}..${head}`]) ?? "").split("\n").filter(Boolean);
  const { readMergeRecord } = await import("../lifecycle/merge-record");
  const { readStoredChangeSet } = await import("../lifecycle/change-set-store");
  const { gitGateLedgerPort } = await import("../op/gate");
  const { decidePrGate, readOnlyLedger, approvalOf } = await import("./pr-run");
  const prs: number[] = [];
  const approved: ApprovedMerge[] = [];
  for (const commit of merges) {
    const record = await readMergeRecord(commit, { cwd: req.cwd }).catch(() => null);
    if (!record || record.env !== req.env) continue;
    const pr = record.source.kind === "pull-request" ? record.source.pr : undefined;
    if (pr !== undefined) prs.push(pr);
    // The digest a person approved: the merged plan's when it matched, else the one approved before it moved.
    const digest = record.plan === "approved" ? record.digest : record.plan === "changed" ? record.approvedDigest : undefined;
    if (!digest || !record.op) continue;
    const stored = await readStoredChangeSet(digest, { cwd: req.cwd }).catch(() => ({ status: "missing" as const }));
    if (stored.status !== "found") continue;
    // The approval must still stand: one revoked since the merge covers nothing.
    const check = await decidePrGate(readOnlyLedger(req.ledger ?? gitGateLedgerPort()), { op: record.op, gate: record.gate ?? req.gate, digest }).catch(() => undefined);
    if (!check?.satisfied) continue;
    approved.push({ commit, ...(pr !== undefined ? { pr } : {}), doc: stored.document, approvedBy: approvalOf(check).approvedBy ?? [] });
  }
  return { status: "target", target: { commit: head, base, baseFrom, merges, prs, approved } };
}

/** The op a green commit's own gate is recorded under: `green-<sha>`, or `green-<sha>-<member>` for a workspace member. */
export function greenOp(commit: string, member?: string): string {
  return member ? `green-${commit.slice(0, 12)}-${member}` : `green-${commit.slice(0, 12)}`;
}
