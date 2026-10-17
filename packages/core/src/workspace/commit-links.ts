/**
 * Which work item a commit belongs to (#4029).
 *
 * A work item implements a decision, and a trunk commit says which work item
 * it carries out in one of two ways:
 *
 * - a `Chant-Record: <kind>:<id>` trailer, where `<kind>` is a work kind the
 *   declaration names (conventionally `work`) and the kind has a record `<id>`;
 * - a `Chant-Lease` trailer whose token a lease history on `chant/lifecycle`
 *   names a work item for, and that item is a record of a work kind.
 *
 * A window match (the intent graph's `worked` bucket) does not link a commit:
 * the commit never said so itself. A commit is wrongly linked when it names a
 * work record that does not exist, a record of a kind that is not a work
 * kind, a lease that resolves to nothing, or a `Chant-Record` value that is
 * not `<kind>:<id>`, and no trailer of it links to a work item.
 *
 * This is the one place that judgement is made. `workspace check --changes`
 * reports it, `ci list` and `ci tick` show it, and later readers share
 * {@link judgeCommitLink}. It reads trailers through `readTrailerJoins`,
 * which `graph --intent` joins commits with, so both resolve a Chant-Record
 * and a Chant-Lease the same way. Everything here reads local git.
 */

import { execFileSync } from "node:child_process";
import { declaredRecordKinds, readDeclaration, WorkspaceReadError } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { trailerValues } from "./intent-joins";
import { commitDetails } from "./intent";
import { loadRecordKind, RecordReadError } from "./records";
import { readRecordsFor } from "./records-cli";
import { readTrailerJoins } from "./trailer-joins";
import { parseRecordRef, RECORD_TRAILER, LEASE_TRAILER } from "./trailers";
import { locateWorkspace } from "./which-chant";

/** `linked`, `unlinked` (no trailer names a work item), `wrong` (trailers name one that is not there), or `merge` (a merge commit carries no work of its own). */
export type CommitLinkState = "linked" | "unlinked" | "wrong" | "merge";

/** One trailer that does not link the commit, with why. */
export interface CommitLinkProblem {
  /** The trailer as written, such as `Chant-Record: decision:ws-075`. */
  trailer: string;
  message: string;
}

/** What {@link judgeCommitLink} says about one commit. */
export interface CommitLink {
  state: CommitLinkState;
  /** The work records the commit's trailers name, as `<kind>:<id>`. Empty unless `linked`; also empty for a lease that could not be checked. */
  ids: string[];
  /** The trailers that do not link. Empty unless `wrong`. */
  problems: CommitLinkProblem[];
}

/** The work records a revision has, by work kind. */
export interface WorkIndex {
  /** Each work kind's name, with the ids of its records. */
  kinds: Map<string, Set<string>>;
  /** Whether lease histories can be read: the local `chant/lifecycle` branch exists. Without it a lease is not judged. */
  ledger: boolean;
}

/** The fix line for each state a check reports. */
export const COMMIT_UNLINKED_FIX = "add a `Chant-Record: work:<id>` trailer when the commit is made (git commit --trailer \"Chant-Record: work:<id>\"), naming the work item the commit carries out";

function workKindList(index: WorkIndex): string {
  return [...index.kinds.keys()].join(", ") || "none";
}

/**
 * Judge one commit from its trailers.
 *
 * `trailers` are the commit's parsed trailers, `joins` what
 * `readTrailerJoins` made of them, and `index` the work records of the
 * revision judged against. A commit is `linked` when any trailer names a
 * work record; another trailer that names a decision or a typo beside it
 * does not make it wrong.
 */
export function judgeCommitLink(trailers: Record<string, string[]>, joins: { records: { kind: string; id: string }[]; lease: { token: string; item: string | null } | null }, index: WorkIndex): CommitLink {
  const ids: string[] = [];
  const problems: CommitLinkProblem[] = [];
  let unchecked = false;
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const value of trailerValues(trailers, RECORD_TRAILER)) {
    const trailer = `${RECORD_TRAILER}: ${value}`;
    const ref = parseRecordRef(value);
    if (!ref) {
      problems.push({ trailer, message: `${value} is not <kind>:<id>` });
      continue;
    }
    const known = index.kinds.get(ref.kind);
    if (!known) problems.push({ trailer, message: `${ref.kind} is not a work kind (the work kinds are ${workKindList(index)})` });
    else if (!known.has(ref.id)) problems.push({ trailer, message: `the ${ref.kind} kind has no record ${ref.id}` });
    else add(`${ref.kind}:${ref.id}`);
  }
  if (joins.lease) {
    const trailer = `${LEASE_TRAILER}: ${joins.lease.token}`;
    const item = joins.lease.item;
    if (item === null) {
      if (index.ledger) problems.push({ trailer, message: "no lease history on chant/lifecycle names this token" });
      else unchecked = true;
    } else {
      const hits = [...index.kinds].filter(([, found]) => found.has(item)).map(([kind]) => kind);
      if (hits.length === 1) add(`${hits[0]}:${item}`);
      else problems.push({ trailer, message: hits.length === 0 ? `the lease was taken on ${item}, which no work kind has a record for` : `the lease was taken on ${item}, which ${hits.join(" and ")} both have, so it names no one work item` });
    }
  }
  if (ids.length > 0 || unchecked) return { state: "linked", ids, problems: [] };
  return problems.length > 0 ? { state: "wrong", ids: [], problems } : { state: "unlinked", ids: [], problems: [] };
}

/**
 * Judge each commit by its own trailers. A commit in `merges` is `merge`:
 * its work is the commits it brings. Reads the lease histories on the local
 * `chant/lifecycle` branch once, and never fetches.
 */
export function judgeCommits(top: string, shas: string[], index: WorkIndex, merges: ReadonlySet<string> = new Set()): Map<string, CommitLink> {
  const details = commitDetails(top, shas);
  const joined = readTrailerJoins(
    top,
    shas.map((sha) => ({ sha, trailers: details.get(sha)?.trailers ?? {} })),
  );
  const out = new Map<string, CommitLink>();
  for (const sha of shas) {
    if (merges.has(sha)) {
      out.set(sha, { state: "merge", ids: [], problems: [] });
      continue;
    }
    out.set(sha, judgeCommitLink(details.get(sha)?.trailers ?? {}, joined.get(sha)!.joins, index));
  }
  return out;
}

/** Whether the lease histories can be read from this repository: the local `chant/lifecycle` branch exists. */
export function hasLeaseLedger(top: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"], { cwd: top, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Which of `shas` are merge commits. */
export function mergeCommits(top: string, shas: string[]): Set<string> {
  const out = new Set<string>();
  if (shas.length === 0) return out;
  const text = execFileSync("git", ["log", "--no-walk=unsorted", "--stdin", "--format=%H %P"], { cwd: top, encoding: "utf-8", input: `${shas.join("\n")}\n`, maxBuffer: 256 * 1024 * 1024 });
  for (const line of text.split("\n")) {
    const [sha, ...parents] = line.trim().split(" ");
    if (sha && parents.length > 1) out.add(sha);
  }
  return out;
}

/**
 * The work records the declaration's work kinds hold at `at` (a revision, or
 * the working tree without one). Null when `cwd` is in no workspace, the
 * declaration names no work kind, or a kind can't be read: the question
 * "which work item" has no answer there.
 */
export async function readWorkIndex(cwd: string, top: string, at?: string): Promise<WorkIndex | null> {
  try {
    const located = locateWorkspace(cwd, at);
    const declaration = readDeclaration(located.tree);
    const kinds = new Map<string, Set<string>>();
    for (const d of declaredRecordKinds(declaration)) {
      const file = declaredKindFile(d, located.rootOnDisk);
      const loaded = await loadRecordKind(file, cwd);
      if (!loaded.kind.work) continue;
      const read = await readRecordsFor({ kind: file, cwd, ...(at !== undefined ? { at } : {}) });
      const ids = (kinds.get(loaded.kind.name) ?? new Set<string>());
      for (const r of read.result.records) if (r.id !== null) ids.add(r.id);
      kinds.set(loaded.kind.name, ids);
    }
    return kinds.size === 0 ? null : { kinds, ledger: hasLeaseLedger(top) };
  } catch (err) {
    if (err instanceof WorkspaceReadError || err instanceof RecordReadError) return null;
    throw err;
  }
}
