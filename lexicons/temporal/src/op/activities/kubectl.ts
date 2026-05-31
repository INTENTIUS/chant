import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "./heartbeat";

const execAsync = promisify(exec);

export interface KubectlApplyArgs {
  manifest: string;
  /** kubectl context name. Uses current context if omitted. */
  context?: string;
}

/**
 * Run `kubectl apply -f <manifest>`.
 * Uses longInfra profile — 20m timeout, heartbeat every 15s.
 */
export async function kubectlApply(args: KubectlApplyArgs, signal?: AbortSignal): Promise<void> {
  const ctx = args.context ? `--context ${args.context}` : "";
  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "kubectl apply", manifest: args.manifest });
  }, 15_000);

  try {
    const { stdout, stderr } = await execAsync(
      `kubectl apply -f ${args.manifest} ${ctx} --wait=true`,
      { signal },
    );
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    clearInterval(heartbeatInterval);
  }
}
