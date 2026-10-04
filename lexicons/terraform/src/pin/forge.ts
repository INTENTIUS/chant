/**
 * What a pin-bump rollout asks the forge (#3189): find a wave's pull request
 * by its branch, open one, and read the checks on the commit a merge made.
 *
 * The default answers through `gh`, the way core's `proposeWorkspaceUpgrade`
 * (#2550) opens its pull request: `gh pr list --head`, `gh pr create`, and
 * `gh api` for the commit's check runs and statuses. A test, or a caller with
 * its own forge client, passes a {@link PinForge} instead.
 */

import type { CommandRunner } from "@intentius/chant/op/activities/propose-upgrade";

/** A wave's pull request, as the forge reports it. */
export interface PinPullRequest {
  url: string;
  state: "open" | "merged" | "closed";
  body: string;
  /** The commit the merge made on the base branch, once merged. */
  mergeCommit?: string;
}

/** One check or status on a commit. */
export interface PinCommitCheck {
  name: string;
  state: "success" | "pending" | "failure";
}

export interface PinForge {
  /** The newest pull request whose head is `branch`, in any state, or null. */
  findPullRequest(branch: string): Promise<PinPullRequest | null>;
  /** Open a pull request and return its URL. */
  createPullRequest(input: { base: string; head: string; title: string; body: string }): Promise<string>;
  /** The checks and statuses on a commit. */
  commitChecks(sha: string): Promise<PinCommitCheck[]>;
}

const CHECK_STATE: Record<string, PinCommitCheck["state"]> = {
  success: "success",
  neutral: "success",
  skipped: "success",
  failure: "failure",
  cancelled: "failure",
  timed_out: "failure",
  action_required: "failure",
  startup_failure: "failure",
  stale: "failure",
  error: "failure",
  pending: "pending",
};

/** A {@link PinForge} over `gh`, run in `repo`. */
export function ghPinForge(run: CommandRunner, repo: string): PinForge {
  return {
    async findPullRequest(branch) {
      const out = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "url,state,body,mergeCommit"], repo);
      const list = JSON.parse(out || "[]") as Array<{ url: string; state: string; body?: string; mergeCommit?: { oid?: string } | null }>;
      const pr = list[0];
      if (!pr) return null;
      const state = pr.state.toLowerCase() === "merged" ? "merged" : pr.state.toLowerCase() === "open" ? "open" : "closed";
      return { url: pr.url, state, body: pr.body ?? "", ...(pr.mergeCommit?.oid ? { mergeCommit: pr.mergeCommit.oid } : {}) };
    },
    async createPullRequest({ base, head, title, body }) {
      const out = await run("gh", ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body], repo);
      return out.trim().split("\n").pop() ?? "";
    },
    async commitChecks(sha) {
      const checks: PinCommitCheck[] = [];
      const runs = await run("gh", ["api", "--paginate", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq", ".check_runs[] | [.name, .status, (.conclusion // \"\")] | @tsv"], repo);
      for (const line of runs.split("\n").filter(Boolean)) {
        const [name, status, conclusion] = line.split("\t");
        checks.push({ name: name!, state: status === "completed" ? (CHECK_STATE[conclusion ?? ""] ?? "failure") : "pending" });
      }
      // Statuses come newest first; the first one per context is its state.
      const statuses = await run("gh", ["api", "--paginate", `repos/{owner}/{repo}/commits/${sha}/statuses`, "--jq", ".[] | [.context, .state] | @tsv"], repo);
      const seen = new Set<string>();
      for (const line of statuses.split("\n").filter(Boolean)) {
        const [name, state] = line.split("\t");
        if (seen.has(name!)) continue;
        seen.add(name!);
        checks.push({ name: name!, state: CHECK_STATE[state ?? ""] ?? "pending" });
      }
      return checks;
    },
  };
}
