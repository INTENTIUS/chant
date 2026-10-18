/**
 * Overlap between in-flight work items (#4025, policy from #4016).
 *
 * A work lease locks one item, and nothing compares two items with each
 * other. This report does, after the fact: it says which in-flight work items
 * changed the same files, and which entries of a planned change set more than
 * one of them reaches. It never blocks anything. Two people or agents read it
 * and sort the overlap out between them.
 *
 * ## In flight
 *
 * A work item is a current record of a declared work kind. It is in flight
 * unless it implements at least one decision and every decision it implements
 * is confirmed, as #4024 defines confirmed ({@link decisionConfirmed}: in one
 * of the decision kind's closed states and superseded by nothing). The item's
 * own state does not matter: work marked done whose decision is not settled
 * can still collide.
 *
 * ## Linked commits
 *
 * The commits of a work item are the commits linked to it as #4029 defines
 * linked ({@link judgeCommits}): a `Chant-Record: <work kind>:<id>` trailer,
 * or a `Chant-Lease` trailer that resolves to the item. A window match does
 * not link. The walk covers every local branch, every remote-tracking branch
 * and HEAD, so work pushed to a branch and fetched shows before it is merged.
 * The ledger branches under `chant/` hold no work and are left out. Merge
 * commits carry no work of their own and are skipped. Nothing is fetched.
 *
 * ## Files
 *
 * An item's files are the paths its linked commits add, change or delete,
 * from the repository root, with renames read as a delete and an add. Two
 * items overlap by file when both touch one path.
 *
 * ## Change-set entries
 *
 * A change set is planned from many commits, and a release bundles many work
 * items, so an entry belongs to no single item on its face. An entry is
 * attributed to a work item when:
 *
 * 1. the entry has a `source`: the file that declares its graph node, from
 *    the repository root, recorded when the change set was stored
 *    (`../change-set-graph.ts`);
 * 2. a commit linked to the item changed that file; and
 * 3. that commit is in the history the change set was planned from: an
 *    ancestor of (or equal to) the commit its graph was read at, else the
 *    commit the gate was reached at. When neither is known, or the commit is
 *    not in this repository, the third test is skipped.
 *
 * An entry can be attributed to several items, and two items overlap by
 * address when one entry is attributed to both. An entry with no `source`
 * (stored by an older chant, mapped onto no node, or a node with no source
 * location) is attributed to none and counted in `unattributed`.
 *
 * The change sets read are the ones `workspace status` lists on a gate that
 * is pending or approved: the plans still waiting to apply.
 */

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import type { ChangeSetDocument } from "../change-set";
import { judgeCommits, hasLeaseLedger, type WorkIndex } from "./commit-links";
import { declaredRecordKinds, type Declaration } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { decisionConfirmed } from "./flags";
import { loadRecordKind } from "./records";
import { readRecordsFor } from "./records-cli";
import { LEASE_TRAILER, RECORD_TRAILER } from "./trailers";

/** One in-flight work item with at least one linked commit. */
export interface OverlapItem {
  /** `<work kind>:<id>`, as a `Chant-Record` trailer names it. */
  item: string;
  /** The work record file, from the repository root. */
  path: string;
  state: string | null;
  /** The commits linked to the item, newest first. */
  commits: string[];
}

/** One change-set entry two items both reach. */
export interface OverlapAddress {
  /** The change set's digest, as `chant change-set show` takes it. */
  changeSet: string;
  /** The workspace member whose ledger stores the change set, or null for the flat ledger. */
  ledgerMember: string | null;
  /** The entry's change-set member and planner address. */
  member: string;
  address: string;
  /** The entry's graph node, or null. */
  node: string | null;
  /** The source file the attribution went through, from the repository root. */
  source: string;
}

/** Two in-flight work items that changed the same thing. */
export interface OverlapPair {
  /** The two items, `<work kind>:<id>`, in sorted order. */
  items: [string, string];
  /** The files both items' linked commits touch, sorted. */
  files: string[];
  /** The change-set entries attributed to both items, by change set then address. */
  addresses: OverlapAddress[];
}

/** What `workspace status` reports as `overlap`. */
export interface OverlapReport {
  /** The in-flight work items with a linked commit, by item. */
  items: OverlapItem[];
  /** Each pair of items that share a file or an entry, by the first item then the second. */
  pairs: OverlapPair[];
  /** The digests of the change sets read, sorted. */
  changeSets: string[];
  /** Entries of those change sets with no `source`, so attributed to no item. */
  unattributed: number;
}

/** A change set to attribute: one a pending or approved gate binds. */
export interface OverlapChangeSetRef {
  digest: string;
  /** A directory whose ledger stores it: the member's directory. */
  cwd: string;
  ledgerMember: string | null;
  /** The commit the gate was reached at, when the pending fact records one. */
  gitSha: string | null;
}

/** Reads a stored change set; the lifecycle store unless a test swaps it. */
export type StoredChangeSetReader = (digest: string, cwd: string) => Promise<ChangeSetDocument | null>;

const defaultReadChangeSet: StoredChangeSetReader = async (digest, cwd) => {
  const { readStoredChangeSet } = await import("../lifecycle/change-set-store");
  const read = await readStoredChangeSet(digest, { cwd });
  return read.status === "found" ? read.document : null;
};

function git(top: string, args: string[], input?: string): string {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd: top,
    encoding: "utf-8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    maxBuffer: 512 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
}

/** The work items of every declared work kind, with the index commits are judged against and the ones in flight. */
async function readWorkItems(declaration: Declaration, root: string, top: string): Promise<{ index: WorkIndex; inFlight: Map<string, { path: string; state: string | null }> } | null> {
  const kinds = new Map<string, Set<string>>();
  const inFlight = new Map<string, { path: string; state: string | null }>();
  for (const d of declaredRecordKinds(declaration)) {
    const file = declaredKindFile(d, root);
    const loaded = await loadRecordKind(file, root);
    if (!loaded.kind.work) continue;
    const decisionKind = await loadRecordKind(loaded.kind.work.decisions, dirname(loaded.file));
    const closed = new Set(decisionKind.kind.closedStates ?? []);
    const read = await readRecordsFor({ kind: file, cwd: root });
    const decisions = new Map((read.result.decisions ?? []).map((x) => [x.id, x]));
    const ids = kinds.get(loaded.kind.name) ?? new Set<string>();
    for (const r of read.result.records) {
      if (r.id === null) continue;
      ids.add(r.id);
      if (r.supersededBy !== null) continue;
      const implemented = r.implements ?? [];
      const settled = implemented.length > 0 && implemented.every((x) => decisionConfirmed(decisions.get(x.id), closed));
      const key = `${loaded.kind.name}:${r.id}`;
      if (!settled && !inFlight.has(key)) inFlight.set(key, { path: r.path, state: r.state });
    }
    kinds.set(loaded.kind.name, ids);
  }
  if (kinds.size === 0) return null;
  return { index: { kinds, ledger: hasLeaseLedger(top) }, inFlight };
}

/**
 * The non-merge commits on every local and remote-tracking branch and HEAD
 * that carry a `Chant-Record` or `Chant-Lease` trailer, newest first. The
 * ledger branches under `chant/` are left out.
 */
export function trailerCommits(top: string): string[] {
  let text: string;
  try {
    text = git(top, [
      "log",
      "--no-merges",
      `--format=%H%x1f%(trailers:key=${RECORD_TRAILER},key=${LEASE_TRAILER},valueonly,separator=%x1e)%x1d`,
      "--exclude=chant/*",
      "--branches",
      "--exclude=*/chant/*",
      "--remotes",
      "HEAD",
      "--",
    ]);
  } catch {
    // An unborn HEAD has no history to read.
    return [];
  }
  const out: string[] = [];
  for (const chunk of text.split("\x1d")) {
    const [sha, trailers] = chunk.trim().split("\x1f");
    if (sha && trailers && trailers.trim() !== "") out.push(sha);
  }
  return out;
}

/** The paths each commit adds, changes or deletes, from the repository root, renames read as a delete and an add. */
export function commitFiles(top: string, shas: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (shas.length === 0) return out;
  const text = git(top, ["log", "--no-walk=unsorted", "--stdin", "--no-renames", "--name-only", "--format=%x1e%H"], `${shas.join("\n")}\n`);
  for (const block of text.split("\x1e")) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    out.set(lines[0], lines.slice(1));
  }
  return out;
}

/** Every commit reachable from `rev`, or null when `rev` is not in the repository. */
function reachable(top: string, rev: string): Set<string> | null {
  try {
    return new Set(git(top, ["rev-list", rev, "--"]).split("\n").filter(Boolean));
  } catch {
    return null;
  }
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The work items a change-set entry is attributed to, sorted: each item with
 * a linked commit that changed the entry's `source` and is in `within`, the
 * history the change set was planned from (null when that is unknown, so
 * every linked commit counts). An entry with no source has none.
 *
 * `commitsOf` maps each in-flight item to its linked commits, and `files`
 * each commit to the paths it touches.
 */
export function attributeEntry(
  source: string | undefined,
  commitsOf: ReadonlyMap<string, readonly string[]>,
  files: ReadonlyMap<string, readonly string[]>,
  within: ReadonlySet<string> | null,
): string[] {
  if (source === undefined) return [];
  const out: string[] = [];
  for (const [item, commits] of commitsOf) {
    if (commits.some((sha) => (files.get(sha) ?? []).includes(source) && (within === null || within.has(sha)))) out.push(item);
  }
  return out.sort(byString);
}

/**
 * The overlap report for the workspace declared at `root` in the repository
 * at `top`. Null when the declaration names no work kind. Throws when a work
 * kind or its records can't be read, or git fails; `workspace status` writes
 * null then.
 */
export async function readOverlap(input: {
  declaration: Declaration;
  root: string;
  top: string;
  changeSets: OverlapChangeSetRef[];
  readChangeSet?: StoredChangeSetReader;
}): Promise<OverlapReport | null> {
  const { top } = input;
  const work = await readWorkItems(input.declaration, input.root, top);
  if (work === null) return null;

  // The commits of each in-flight item, newest first.
  const commitsOf = new Map<string, string[]>();
  if (work.inFlight.size > 0) {
    const candidates = trailerCommits(top);
    const links = judgeCommits(top, candidates, work.index);
    for (const sha of candidates) {
      for (const id of links.get(sha)?.ids ?? []) {
        if (!work.inFlight.has(id)) continue;
        const list = commitsOf.get(id) ?? [];
        if (!list.includes(sha)) list.push(sha);
        commitsOf.set(id, list);
      }
    }
  }
  const items = [...commitsOf.keys()].sort(byString);
  const files = commitFiles(top, [...new Set([...commitsOf.values()].flat())]);
  const filesOf = new Map(items.map((id) => [id, new Set(commitsOf.get(id)!.flatMap((sha) => files.get(sha) ?? []))]));

  // Each change-set entry with a source, attributed to the items whose linked commits changed it within the change set's history.
  const read = input.readChangeSet ?? defaultReadChangeSet;
  const seen = new Set<string>();
  const changeSets: string[] = [];
  let unattributed = 0;
  const addressesOf = new Map<string, OverlapAddress[]>();
  const history = new Map<string, Set<string> | null>();
  for (const ref of input.changeSets) {
    const key = `${ref.ledgerMember ?? ""}\0${ref.digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = await read(ref.digest, ref.cwd);
    if (doc === null) continue;
    if (!changeSets.includes(doc.digest)) changeSets.push(doc.digest);
    const at = doc.graph?.at ?? ref.gitSha;
    for (const e of doc.entries) {
      if (e.source === undefined) {
        unattributed++;
        continue;
      }
      // Only an entry two items could share needs the change set's history.
      if (attributeEntry(e.source, commitsOf, files, null).length < 2) continue;
      if (at && !history.has(at)) history.set(at, reachable(top, at));
      const owners = attributeEntry(e.source, commitsOf, files, at ? history.get(at)! : null);
      if (owners.length < 2) continue;
      const address: OverlapAddress = { changeSet: doc.digest, ledgerMember: ref.ledgerMember, member: e.member, address: e.address, node: e.node ?? null, source: e.source };
      for (const id of owners) addressesOf.set(id, [...(addressesOf.get(id) ?? []), address]);
    }
  }
  changeSets.sort(byString);

  const pairs: OverlapPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const fb = filesOf.get(b)!;
      const shared = [...filesOf.get(a)!].filter((f) => fb.has(f)).sort(byString);
      const ab = addressesOf.get(b) ?? [];
      const addresses = (addressesOf.get(a) ?? [])
        .filter((x) => ab.includes(x))
        .sort((x, y) => byString(x.changeSet, y.changeSet) || byString(x.member, y.member) || byString(x.address, y.address));
      if (shared.length > 0 || addresses.length > 0) pairs.push({ items: [a, b], files: shared, addresses });
    }
  }

  return {
    items: items.map((id) => ({ item: id, path: work.inFlight.get(id)!.path, state: work.inFlight.get(id)!.state, commits: commitsOf.get(id)! })),
    pairs,
    changeSets,
    unattributed,
  };
}
