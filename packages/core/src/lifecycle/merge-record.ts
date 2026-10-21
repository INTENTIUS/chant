/**
 * Merge records (#4168 step 1): what landed on the target branch, keyed by
 * the commit, kept on `chant/lifecycle` so a release can say which changes
 * it carries and whether each was approved.
 *
 *   _merges/<commit>.json    one record per commit, rewritten when the record job runs again
 *
 * A merge never deploys. The record job (`chant components pr-record`)
 * plans the members the change reaches on the merged commit, stores the
 * change set (../lifecycle/change-set-store.ts) and writes this record. It
 * applies nothing and refuses nothing: a plan that differs from the
 * approved one is recorded, and the job sets a failing `chant/record`
 * status (#4168 decision 1).
 *
 * The record names where the change came from (#4168 4.4): the pull request
 * that merged it, the work items its `Chant-Record: work:<id>` trailers name,
 * or a direct push. A workspace member's record sits under
 * `_members/<member>/_merges/` through the same `ledgerDir` prefix the gate
 * ledger uses.
 */

import { execFileSync } from "node:child_process";
import { sortedJsonReplacer } from "../utils";
import { parseRecordRef, RECORD_TRAILER, type RecordRef } from "../workspace/trailers";
import { ledgerDir, readBlobFromPath, readPathSha, RefCASConflictError, writeLedgerFiles, type LedgerLocation } from "./git";

/** The directory on `chant/lifecycle` that holds merge records. */
export const MERGES_DIR = "_merges";

export const MERGE_RECORD_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/merge-record/v1/merge-record.schema.json";
export const MERGE_RECORD_CONTRACT = 1;

/** Where the change came from. */
export type MergeSource =
  /** The pull or merge request that merged the commit. */
  | { kind: "pull-request"; pr: number }
  /** No pull request merged it; its `Chant-Record` trailers name the work items it carries out. */
  | { kind: "work-item"; records: RecordRef[] }
  /** No pull request merged it and its message names no work item. */
  | { kind: "direct-push" };

/**
 * How the planned change set compares with the approval. `approved`: an
 * approval stands for this digest. `changed`: one stands for another digest,
 * so the plan moved after review. `unapproved`: none stands. `nothing`: no
 * component deploys what the change touches. `plan-failed`: a member failed
 * to plan, so there is no digest to compare.
 */
export type MergePlanStatus = "approved" | "changed" | "unapproved" | "nothing" | "plan-failed";

export interface MergeRecord {
  $schema: typeof MERGE_RECORD_SCHEMA_ID;
  contract: typeof MERGE_RECORD_CONTRACT;
  /** The merged commit. */
  commit: string;
  /** The commit the change is measured from. */
  base: string;
  env: string;
  /** The workspace member whose pipeline recorded it. */
  member?: string;
  source: MergeSource;
  /** The pull request's gate op (`pr-<n>`), or null without a pull request. */
  op: string | null;
  gate: string;
  /** The change-set digest planned on the merged commit, or null when nothing was planned. */
  digest: string | null;
  plan: MergePlanStatus;
  /** With `changed`: the digest the approval stands for. */
  approvedDigest?: string;
  /** Who approved the planned digest, with `approved`. */
  approvedBy: string[];
  /**
   * Approvers who wrote the change: the pull request's author, or an author
   * or committer of one of its commits (#4000). Read only with a forge. An
   * approval by its author counts toward nothing under the review-rules
   * group; the record keeps it so a release gate can say so.
   */
  authorApproved?: string[];
  /** The components the change selects, in plan order. */
  components: string[];
  /** ISO 8601. */
  recordedAt: string;
}

/**
 * Where `commit` came from: the pull request `pr` when one merged it, else
 * the work items its `Chant-Record: work:<id>` trailers name, else a direct
 * push. A commit git can't read names no work item.
 */
export function mergeSourceOf(cwd: string, commit: string, pr: number | null): MergeSource {
  if (pr !== null) return { kind: "pull-request", pr };
  let text = "";
  try {
    text = execFileSync("git", ["log", "-1", `--format=%(trailers:key=${RECORD_TRAILER},valueonly,separator=%x1e)`, commit], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    text = "";
  }
  const records: RecordRef[] = [];
  for (const value of text.split("\x1e").map((v) => v.trim()).filter(Boolean)) {
    const ref = parseRecordRef(value);
    if (ref && ref.kind === "work" && !records.some((r) => r.id === ref.id)) records.push(ref);
  }
  return records.length > 0 ? { kind: "work-item", records } : { kind: "direct-push" };
}

/** The file a commit's record is stored in, inside {@link MERGES_DIR}. */
export function mergeRecordFile(commit: string): string {
  return `${commit}.json`;
}

/**
 * Write `record` under its commit and return whether anything changed. A
 * record already there with the same content is left alone; another is
 * replaced, since the record job may run again on the same commit. Does not
 * push: call `pushLifecycleReport` (./git.ts) after.
 */
export async function writeMergeRecord(record: MergeRecord, opts?: LedgerLocation): Promise<{ commit: string | null; written: boolean }> {
  const file = mergeRecordFile(record.commit);
  const content = `${JSON.stringify(record, sortedJsonReplacer)}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await readPathSha(MERGES_DIR, file, opts);
    if (prior !== null) {
      const text = await readBlobFromPath(MERGES_DIR, file, opts);
      if (text !== null && sameRecord(text, record)) return { commit: null, written: false };
    }
    const dir = await ledgerDir(MERGES_DIR, opts);
    try {
      const commit = await writeLedgerFiles([{ path: `${dir}/${file}`, content, expectPriorSha: prior }], `Merge record ${record.commit}`, opts);
      return { commit, written: true };
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
    }
  }
  throw new Error(`could not write the merge record for ${record.commit}: chant/lifecycle kept moving`);
}

/** The same record, ignoring when it was written. */
function sameRecord(text: string, record: MergeRecord): boolean {
  try {
    const { recordedAt: _a, ...had } = JSON.parse(text) as MergeRecord;
    const { recordedAt: _b, ...now } = record;
    return JSON.stringify(had, sortedJsonReplacer) === JSON.stringify(now, sortedJsonReplacer);
  } catch {
    return false;
  }
}

/** The record of `commit`, or null when none is stored. Reads the local `chant/lifecycle` and never fetches. */
export async function readMergeRecord(commit: string, opts?: LedgerLocation): Promise<MergeRecord | null> {
  const text = await readBlobFromPath(MERGES_DIR, mergeRecordFile(commit), opts);
  if (text === null) return null;
  const doc = JSON.parse(text) as MergeRecord;
  return doc?.$schema === MERGE_RECORD_SCHEMA_ID ? doc : null;
}
