/**
 * Reading a member's pipeline (#5324): from its working tree, for builds and
 * for showing the order, and from a commit, for the gates. A gate folds the
 * file as it stood at the base commit, as an op wave reads its spec there,
 * so a change cannot loosen the gate it is judged by. Folding runs nothing,
 * so reading the change's own file is safe too (the plan note's diff).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foldPipelineSource, pipelineFindingLine, type PipelineFinding } from "./fold";
import { PIPELINE_FILE, type PipelineSpec } from "./spec";

/** A member's pipeline as read: absent, folded, or refused with its finding. */
export type PipelineRead =
  | { status: "absent" }
  | { status: "folded"; file: string; spec: PipelineSpec }
  | { status: "refused"; file: string; finding: PipelineFinding; line: string };

function fromText(text: string, file: string): PipelineRead {
  const folded = foldPipelineSource(text, file);
  if ("spec" in folded) return { status: "folded", file, spec: folded.spec };
  return { status: "refused", file, finding: folded.finding, line: pipelineFindingLine(file, folded.finding) };
}

/** The pipeline in member directory `dir`'s working tree. */
export function readMemberPipeline(dir: string): PipelineRead {
  const path = join(dir, PIPELINE_FILE);
  if (!existsSync(path)) return { status: "absent" };
  return fromText(readFileSync(path, "utf-8"), PIPELINE_FILE);
}

/** The file's text at `commit` in the repository holding `cwd`, or null when that commit has none. `file` is relative to `cwd`. */
export type PipelineShow = (commit: string, file: string, cwd: string) => string | null;

/** {@link PipelineShow} through git. */
export const gitShowPipeline: PipelineShow = (commit, file, cwd) => {
  try {
    return execFileSync("git", ["show", `${commit}:./${file}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

/** The member's pipeline as it stood at `commit`: absent when the commit has no pipeline file. */
export function readPipelineAt(commit: string, cwd: string, show: PipelineShow = gitShowPipeline): PipelineRead {
  const text = show(commit, PIPELINE_FILE, cwd);
  return text === null ? { status: "absent" } : fromText(text, `${PIPELINE_FILE} at ${commit.slice(0, 12)}`);
}

/**
 * The commit a promote reads its gates at: the default branch as the
 * remote has it (`origin/HEAD`, else `origin/main`, else `origin/master`),
 * else `HEAD` when the repository has no remote. A promote run from a
 * branch with an edited pipeline is still judged by the merged one.
 */
export function promoteBase(cwd: string): string | undefined {
  for (const ref of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "HEAD"]) {
    try {
      const sha = execFileSync("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (sha) return sha;
    } catch {
      // Try the next.
    }
  }
  return undefined;
}
