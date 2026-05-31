import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "./heartbeat";
import { sleep } from "./util";

const execAsync = promisify(exec);

export interface GitlabPipelineArgs {
  /** GitLab project name or path (e.g. "group/project"). */
  name: string;
  /** Git ref to run the pipeline on. Default: current branch. */
  ref?: string;
  /** Poll interval in ms. Default: 30000. */
  intervalMs?: number;
}

/**
 * Trigger a GitLab CI pipeline and wait for it to complete successfully.
 * Requires `glab` CLI authenticated in the environment.
 * Uses longInfra profile — 20m timeout, heartbeat every poll.
 */
export async function gitlabPipeline(args: GitlabPipelineArgs, signal?: AbortSignal): Promise<void> {
  const ref = args.ref ?? "HEAD";
  const interval = args.intervalMs ?? 30_000;

  // Trigger
  const { stdout: triggerOut } = await execAsync(
    `glab ci run --project ${args.name} --ref ${ref}`,
    { signal },
  );
  console.log(triggerOut);

  // Poll status
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error("gitlabPipeline aborted");
    attempt++;
    safeHeartbeat({ step: "gitlabPipeline", project: args.name, attempt });

    const { stdout } = await execAsync(
      `glab ci status --project ${args.name} --format json`,
      { signal },
    );

    let status: string | undefined;
    try {
      const parsed = JSON.parse(stdout) as { status?: string }[];
      status = parsed[0]?.status;
    } catch {
      // Non-JSON output — keep polling
    }

    if (status === "success") return;
    if (status === "failed" || status === "canceled") {
      throw new Error(`GitLab pipeline for ${args.name} ended with status: ${status}`);
    }

    await sleep(interval, signal);
  }
}
