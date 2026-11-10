/**
 * The before-merge decisions on `chant/lifecycle` (#4984): read and written
 * through the ledger's git, at `_waves/<op>.before-merge.json` from the top
 * of the branch (./before-merge.ts says what a decision is). Kept apart from
 * ./before-merge.ts so the generators and the guard load no git code.
 */

import { fetchLifecycleStatus, pushLifecycleStatus, readBlobBySha, readPathSha, writeBlobToPath } from "../lifecycle/git";
import { BEFORE_MERGE_DIR, beforeMergeDigest, beforeMergeFile, beforeMergeKeyProblem, parseBeforeMerge, renderBeforeMerge, type BeforeMergeDecision, type BeforeMergeFile, type BeforeMergeRecord } from "./before-merge";

/** The decision of op `op` for `head`, from `chant/lifecycle` as the remote has it. Undefined when there is none. */
export async function beforeMergeRecordAt(op: string, head: string, opts: { cwd?: string } = {}): Promise<BeforeMergeRecord | undefined> {
  if (beforeMergeKeyProblem(op, head)) return undefined;
  const fetched = await fetchLifecycleStatus(opts);
  if (fetched.status === "unreachable") throw new Error("chant/lifecycle could not be fetched, so the decision cannot be read");
  const blob = await readPathSha(BEFORE_MERGE_DIR, beforeMergeFile(op), { ...opts, ledgerPrefix: "" });
  if (!blob) return undefined;
  return parseBeforeMerge(await readBlobBySha(blob, opts)).heads[head];
}

/**
 * Write a decision for op `op` and push `chant/lifecycle`: the record the
 * run's guard reads. Read, written and pushed again when another writer
 * pushed first, up to three times. Returns the record, digest included.
 */
export async function recordBeforeMerge(op: string, decision: BeforeMergeDecision, opts: { cwd?: string } = {}): Promise<BeforeMergeRecord> {
  const problem = beforeMergeKeyProblem(op, decision.head) ?? beforeMergeKeyProblem(op, decision.base);
  if (problem) throw new Error(problem);
  const record: BeforeMergeRecord = { ...decision, digest: beforeMergeDigest(op, decision) };
  const where = { ...opts, ledgerPrefix: "" };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fetched = await fetchLifecycleStatus(opts);
    if (fetched.status === "unreachable") throw new Error("chant/lifecycle could not be fetched, so the decision was not written");
    const blob = await readPathSha(BEFORE_MERGE_DIR, beforeMergeFile(op), where);
    const file = parseBeforeMerge(blob ? await readBlobBySha(blob, opts) : null);
    const next: BeforeMergeFile = { version: 1, heads: { ...file.heads, [decision.head]: record } };
    await writeBlobToPath(BEFORE_MERGE_DIR, beforeMergeFile(op), renderBeforeMerge(next), `Decide ${op} before merge: pull request ${decision.pr} at ${decision.head.slice(0, 12)}`, { ...where, expectPriorPathSha: blob });
    const pushed = await pushLifecycleStatus(opts);
    if (pushed.status === "stale") continue;
    if (pushed.status === "failed") throw new Error(`could not push the decision to chant/lifecycle (${pushed.stderr.trim()})`);
    return record;
  }
  throw new Error("chant/lifecycle kept moving, so the decision was not written; comment again");
}
