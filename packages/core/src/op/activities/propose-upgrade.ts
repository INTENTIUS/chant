/**
 * proposeWorkspaceUpgrade — the propose-only activity behind scheduled
 * template upgrades (#2550, D9, ws-032).
 *
 * `chant workspace upgrade` is a core command. An Op, including a workspace Op
 * later (#2554), schedules it through this activity, which stages the same
 * upgrade (fetch, migrate, merge per file, build, lint and `workspace check`
 * in a worktree) and then only proposes it:
 *
 * - `report` (default): stage and check, and return the summary.
 * - `branch`: commit the patch on a proposal branch, by default
 *   `chant/upgrade/<scope>`, and push it when the repository has the remote.
 * - `pull-request`: the branch, plus an open pull request against the default
 *   branch, created once and edited on later runs.
 *
 * It never writes the default branch or the checked-out branch, and it never
 * applies the patch to the working tree, so an Op cannot rewrite itself or
 * the gates that judge it. Review and merge of the pull request are the
 * approval. The PR body names the patch digest, the value `chant workspace
 * upgrade` binds its gate to, so the two paths approve the same thing.
 *
 * The workspace code loads on first call, so importing core's activities
 * loads nothing under `workspace/` (#2525 rule 5).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StagedUpgrade } from "../../workspace/lineage-upgrade";

const execFileAsync = promisify(execFile);

export type ProposeUpgradeMode = "report" | "branch" | "pull-request";

export interface ProposeWorkspaceUpgradeArgs {
  /** The lineage scope: `"."` (default) or a vendor scope's directory. */
  scope?: string;
  /** The target ref. Defaults to the ref the scope is pinned at, so a moving ref such as a branch is followed. */
  to?: string;
  mode?: ProposeUpgradeMode;
  /** The proposal branch. Default `chant/upgrade/<scope>`, with `root` for `"."`. */
  branch?: string;
  /** The branch the pull request targets. Default: the remote's default branch. */
  base?: string;
  /** The remote to push to. Default `origin`. */
  remote?: string;
  /** Run code migrations. Default false. */
  allowCode?: boolean;
  /** The directory holding the lineage lock. Default: the working directory. */
  cwd?: string;
  /** Replaces the git and gh child processes. For tests. */
  _run?: CommandRunner;
  /** Replaces build and lint in the worktree. For tests. */
  _runChant?: import("../../workspace/lineage-upgrade").ChantRunner;
}

/** Runs `git` or `gh` with arguments, returning stdout. Rejects on a non-zero exit. */
export type CommandRunner = (bin: "git" | "gh", args: string[], cwd: string) => Promise<string>;

export interface ProposeWorkspaceUpgradeResult {
  scope: string;
  mode: ProposeUpgradeMode;
  /** Whether the template has anything new for the scope. */
  changed: boolean;
  /** Whether a branch or pull request was written. */
  proposed: boolean;
  checksOk: boolean;
  from: string | null;
  to: string | null;
  /** The patch digest `chant workspace upgrade` binds its gate to. */
  digest: string;
  manualSteps: number;
  governance: boolean;
  branch?: string;
  commit?: string;
  pushed?: boolean;
  prUrl?: string;
  summary: string;
}

const defaultRun: CommandRunner = async (bin, args, cwd) => (await execFileAsync(bin, args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

/** The proposal branch for a scope. */
export function proposalBranch(scope: string): string {
  return `chant/upgrade/${scope === "." ? "root" : scope.replace(/[^A-Za-z0-9._/-]/g, "-")}`;
}

/** The marker that finds this scope's pull request again. */
export function proposalMarker(scope: string): string {
  return `<!-- chant-workspace-upgrade:${scope} -->`;
}

function body(staged: StagedUpgrade, lines: string[]): string {
  return [
    proposalMarker(staged.scope),
    `## Template upgrade: \`${staged.scope}\``,
    "",
    `\`${staged.template}\` from \`${staged.from ?? "(no ref)"}\` to \`${staged.to ?? "(no ref)"}\`.`,
    "",
    `Patch digest: \`${staged.digest}\``,
    "",
    "```",
    ...lines,
    "```",
    "",
    staged.manualSteps.length > 0
      ? `${staged.manualSteps.length} file(s) did not merge cleanly and are kept as they were, each with a manual step. \`chant workspace check\` fails until each is merged and resolved with \`chant workspace lineage resolve <path>\`.`
      : "Every file merged cleanly.",
    staged.governance ? "\nThis upgrade changes governance files. Review it under the rules on the default branch, not the ones it proposes." : "",
    "",
    "Proposed by the `proposeWorkspaceUpgrade` activity. It never writes the default branch.",
  ].join("\n");
}

async function defaultBranch(run: CommandRunner, repo: string, remote: string): Promise<string | null> {
  try {
    const ref = (await run("git", ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], repo)).trim();
    return ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : ref;
  } catch {
    return null;
  }
}

/** Stage a workspace upgrade and propose it as a branch or pull request. Never writes the default branch. */
export async function proposeWorkspaceUpgrade(args: ProposeWorkspaceUpgradeArgs): Promise<ProposeWorkspaceUpgradeResult> {
  const mode = args.mode ?? "report";
  const run = args._run ?? defaultRun;
  const remote = args.remote ?? "origin";
  const { stageUpgrade, describeStaged, commitStagedUpgrade } = await import("../../workspace/lineage-upgrade");
  const staged = await stageUpgrade({
    root: args.cwd ?? process.cwd(),
    scope: args.scope,
    to: args.to,
    allowCode: args.allowCode,
    ...(args._runChant ? { runChant: args._runChant } : {}),
  });
  try {
    const lines = describeStaged(staged);
    const result: ProposeWorkspaceUpgradeResult = {
      scope: staged.scope,
      mode,
      changed: staged.changed,
      proposed: false,
      checksOk: staged.checksOk,
      from: staged.from,
      to: staged.to,
      digest: staged.digest,
      manualSteps: staged.manualSteps.length,
      governance: staged.governance !== null,
      summary: lines.join("\n"),
    };
    if (!result.changed || !result.checksOk || mode === "report") return result;

    const branch = args.branch ?? proposalBranch(staged.scope);
    const remoteDefault = await defaultBranch(run, staged.repo, remote);
    const base = args.base ?? remoteDefault;
    let current: string | null = null;
    try {
      current = (await run("git", ["symbolic-ref", "--short", "HEAD"], staged.repo)).trim();
    } catch {
      // Detached HEAD: nothing checked out to protect.
    }
    for (const [what, name] of [["default branch", remoteDefault], ["base branch", base], ["checked-out branch", current]] as const) {
      if (name && branch === name) {
        throw new Error(`proposeWorkspaceUpgrade only proposes: it will not write the ${what} "${name}". Choose another branch.`);
      }
    }
    if (mode === "pull-request" && !base) {
      throw new Error(`proposeWorkspaceUpgrade: cannot tell the default branch of "${remote}"; pass base`);
    }

    const title = `chore(upgrade): ${staged.template} ${staged.to ?? ""} (${staged.scope})`.replace(/\s+/g, " ").replace(" )", ")");
    result.commit = commitStagedUpgrade(staged, branch, `${title}\n\nPatch digest: ${staged.digest}\n`);
    result.branch = branch;
    result.proposed = true;

    let hasRemote = false;
    try {
      await run("git", ["remote", "get-url", remote], staged.repo);
      hasRemote = true;
    } catch {
      hasRemote = false;
    }
    if (hasRemote) {
      // The proposal branch is rebuilt from the default branch on every run, so it is replaced.
      await run("git", ["push", "--force", remote, `${result.commit}:refs/heads/${branch}`], staged.repo);
      result.pushed = true;
    } else {
      result.pushed = false;
    }
    if (mode !== "pull-request") return result;
    if (!hasRemote) throw new Error(`proposeWorkspaceUpgrade: no remote "${remote}" to open a pull request on`);

    const text = body(staged, lines);
    const existing = (await run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"], staged.repo)).trim();
    if (existing) {
      await run("gh", ["pr", "edit", existing, "--title", title, "--body", text], staged.repo);
      result.prUrl = existing;
    } else {
      const out = await run("gh", ["pr", "create", "--base", base!, "--head", branch, "--title", title, "--body", text], staged.repo);
      result.prUrl = out.trim().split("\n").pop();
    }
    return result;
  } finally {
    staged.dispose();
  }
}
