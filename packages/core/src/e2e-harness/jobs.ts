/**
 * The kill-job step, for real (chant#4587): forgejo-runner's docker
 * executor runs each job in a container on the project network, named
 * `FORGEJO-ACTIONS-TASK-<id>_WORKFLOW-<name>_JOB-<name>`. Killing the newest
 * one that matches is a job dying mid-run, the way a runner host does.
 */
import { run } from "./git";
import type { Jobs } from "./ports";

/** forgejo-runner's job containers carry this in their names. */
export const JOB_CONTAINER_MARK = "ACTIONS-TASK";

/** Pick the container to kill from `docker ps` lines (`<created>\t<name>`), newest first by docker's order. */
export function pickJobContainer(psLines: string[], match?: string): string | null {
  for (const line of psLines) {
    const name = line.split("\t").pop()?.trim() ?? "";
    if (!name.includes(JOB_CONTAINER_MARK)) continue;
    if (match && !name.includes(match)) continue;
    return name;
  }
  return null;
}

/** Jobs on `network`, through the host's docker. */
export function dockerJobs(network: string): Jobs {
  return {
    async kill(match) {
      const ps = await run("docker", ["ps", "--filter", `network=${network}`, "--format", "{{.CreatedAt}}\t{{.Names}}"]);
      const name = pickJobContainer(ps.stdout.split("\n").filter(Boolean), match);
      if (!name) return false;
      await run("docker", ["kill", name]);
      return true;
    },
  };
}
