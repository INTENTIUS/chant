/**
 * Which commits of a change agent runs made, and which of those a signed run
 * statement covers (#3192), for `chant workspace verify`.
 *
 * A commit names its run by the `Chant-Run` trailer (ws-075), or a run's end
 * lists it (ws-076). A run statement verified against the runner keys at
 * base names the commits it covers as its subjects. Every `_agent-runs`
 * directory on `chant/lifecycle` is read, the flat one and each member's,
 * from the local branch or, when there is none, from `origin`'s copy. Nothing
 * is fetched: CI fetches `chant/lifecycle` before it verifies.
 */

import { execFileSync } from "node:child_process";
import { AGENT_RUNS_DIR, LEDGER_BRANCH, foldRun, parseRunFile, readRunFiles, type RunView } from "../runs";
import { RUN_TRAILER } from "../trailers";
import type { RunnerKey } from "./policy";
import { attestRun } from "./run-statement";

function git(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** Every run on the ledger, in every member's `_agent-runs`, and the ref and tip read. */
export function readLedgerRuns(repo: string): { ref: string | null; tip: string | null; runs: RunView[] } {
  for (const ref of [`refs/heads/${LEDGER_BRANCH}`, `refs/remotes/origin/${LEDGER_BRANCH}`]) {
    const tip = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
    if (!tip) continue;
    const dirs = new Set<string>();
    for (const path of (git(repo, ["ls-tree", "-r", "--name-only", tip]) ?? "").split("\n")) {
      const at = path.lastIndexOf(`${AGENT_RUNS_DIR}/`);
      if (at >= 0 && (at === 0 || path[at - 1] === "/") && path.endsWith(".jsonl")) dirs.add(path.slice(0, at + AGENT_RUNS_DIR.length));
    }
    const runs: RunView[] = [];
    for (const dir of dirs) {
      for (const [id, f] of readRunFiles(repo, dir, ref).files) {
        const view = foldRun(id, f.path, parseRunFile(f.content, id).lines);
        if (view) runs.push(view);
      }
    }
    return { ref, tip, runs };
  }
  return { ref: null, tip: null, runs: [] };
}

/** One commit of a change that an agent run made, and whether a signed statement covers it. */
export interface RunCommitVerdict {
  commit: string;
  /** The runs that name the commit: by its `Chant-Run` trailer, or by their end's list. */
  runs: string[];
  /** Whether a statement verified against the runner keys at base names the commit. */
  attested: boolean;
  /** The run whose statement covers it, when attested. */
  run?: string;
  signer?: string;
  class?: RunnerKey["class"];
  reason: string;
}

export interface ChangeRuns {
  /** The ledger ref read, or null when there is no `chant/lifecycle` here. */
  ledger: string | null;
  /** The runner and steward principals at base. */
  runners: string[];
  /** The change's commits that a run names or a statement covers, oldest first. */
  commits: RunCommitVerdict[];
}

/**
 * Judge `commits` (the change, oldest first) against the run ledger: which
 * ones runs made, and which of those a verified statement covers.
 */
export function changeRuns(repo: string, commits: string[], runners: readonly RunnerKey[]): ChangeRuns {
  const { ref, runs } = readLedgerRuns(repo);
  const out: ChangeRuns = { ledger: ref, runners: runners.map((r) => r.principal), commits: [] };
  if (commits.length === 0) return out;
  const inChange = new Set(commits);
  const naming = new Map<string, Set<string>>();
  const name = (sha: string, id: string) => (naming.get(sha) ?? naming.set(sha, new Set()).get(sha)!).add(id);
  // Trailers on the change's own commits.
  const log = git(repo, ["log", "--no-walk=unsorted", `--format=%x00%H%x1f%(trailers:key=${RUN_TRAILER},valueonly,separator=%x1e)`, ...commits]) ?? "";
  for (const rec of log.split("\0")) {
    if (!rec.trim()) continue;
    const [sha, values] = rec.split("\x1f");
    for (const v of (values ?? "").split("\x1e").map((x) => x.trim()).filter(Boolean)) name(sha.trim(), v);
  }
  const covered = new Map<string, { run: string; signer: string; class: RunnerKey["class"] }>();
  for (const run of runs) {
    for (const c of run.commits) if (inChange.has(c.sha)) name(c.sha, run.id);
    const a = attestRun(run, runners);
    if (a.status !== "signed") continue;
    for (const sha of a.commits) if (inChange.has(sha) && !covered.has(sha)) covered.set(sha, { run: run.id, signer: a.signer!, class: a.class! });
  }
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const commit of commits) {
    const ids = [...(naming.get(commit) ?? [])].sort();
    const cover = covered.get(commit);
    if (ids.length === 0 && !cover) continue;
    if (cover) {
      out.commits.push({ commit, runs: ids, attested: true, run: cover.run, signer: cover.signer, class: cover.class, reason: `agent run ${cover.run}'s statement, signed by ${cover.signer} (${cover.class}), names this commit` });
      continue;
    }
    const why = ids.map((id) => {
      const r = byId.get(id);
      if (!r) return `${id} is not in the run ledger${ref ? "" : " (there is no chant/lifecycle branch here; fetch it)"}`;
      const a = attestRun(r, runners);
      return a.status === "signed" ? `${id}'s statement, signed by ${a.signer}, does not name this commit` : `${id}: ${a.reason}`;
    });
    out.commits.push({ commit, runs: ids, attested: false, reason: why.join("; ") });
  }
  return out;
}
