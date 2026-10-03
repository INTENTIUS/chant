/**
 * Joining a commit through chant's own trailers (#3149, ws-075), for `graph
 * --intent` and `graph --intent --record`.
 *
 * A plugin's `commitJoins` reads a kind's own trailers (`intent-joins.ts`).
 * These are core's: a `Chant-Record` names a record by kind and id, and a
 * `Chant-Lease` names a work lease by its fencing token, which the lease
 * histories on `chant/lifecycle` turn into the work item it was taken on.
 * Both read the local branch and never fetch.
 */

import { execFileSync } from "node:child_process";
import { parseLeaseHistory } from "../lifecycle/work-lease";
import { readChantTrailers, type AppliedTrailers, type ChantTrailers } from "./trailers";

/** The branch the lease histories are on. */
const LEDGER_BRANCH = "refs/heads/chant/lifecycle";

/** What chant's trailers on one commit join it to, as a commit in `graph --intent` reports it. */
export interface CommitTrailerJoins {
  /** `Chant-Agent`: the agent session that wrote the commit. */
  agent: string | null;
  /** `Chant-Lease`: the work lease's token, and the work item a lease history on `chant/lifecycle` names for it, or null when none does. */
  lease: { token: string; item: string | null } | null;
  /** `Chant-Run`: the agent run that made the commit. */
  run: string | null;
  /** Each `Chant-Record`, with the id of its node in the graph, or null when no kind read has the record. */
  records: { kind: string; id: string; node: string | null }[];
  /** The `Chant-Applied-*` trailers of a commit that applied a leased branch. */
  applied: AppliedTrailers | null;
}

function git(top: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * The work item each lease token names, from the lease histories
 * (`_leases/<item>.jsonl`, any member's) on the local `chant/lifecycle`
 * branch. A token no history names is left out. Never fetches.
 */
export function leaseItemsByToken(top: string, tokens: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const wanted = [...new Set(tokens.filter((t) => t !== ""))];
  if (wanted.length === 0 || git(top, ["rev-parse", "--verify", "--quiet", LEDGER_BRANCH]) === undefined) return out;
  const listed = git(top, ["grep", "-l", "-F", ...wanted.flatMap((t) => ["-e", t]), LEDGER_BRANCH, "--", ":(glob)**/_leases/*.jsonl"]);
  for (const line of (listed ?? "").split("\n")) {
    const path = line.startsWith(`${LEDGER_BRANCH}:`) ? line.slice(LEDGER_BRANCH.length + 1) : "";
    const m = path.match(/(?:^|\/)_leases\/([^/]+)\.jsonl$/);
    if (!m) continue;
    const text = git(top, ["show", `${LEDGER_BRANCH}:${path}`]);
    for (const r of parseLeaseHistory(text ?? "").records) if (wanted.includes(r.token) && r.item === m[1] && !out.has(r.token)) out.set(r.token, r.item);
  }
  return out;
}

/** Read chant's trailers from each commit, and the work items their lease tokens name. */
export function readTrailerJoins(top: string, commits: { sha: string; trailers: Record<string, string[]> }[]): Map<string, { trailers: ChantTrailers; joins: CommitTrailerJoins }> {
  const read = commits.map((c) => ({ sha: c.sha, trailers: readChantTrailers(c.trailers) }));
  const items = leaseItemsByToken(
    top,
    read.map((r) => r.trailers.lease).filter((t): t is string => t !== null),
  );
  const out = new Map<string, { trailers: ChantTrailers; joins: CommitTrailerJoins }>();
  for (const { sha, trailers } of read) {
    out.set(sha, {
      trailers,
      joins: {
        agent: trailers.agent,
        lease: trailers.lease === null ? null : { token: trailers.lease, item: items.get(trailers.lease) ?? null },
        run: trailers.run,
        records: trailers.records.map((r) => ({ kind: r.kind, id: r.id, node: null })),
        applied: trailers.applied,
      },
    });
  }
  return out;
}
