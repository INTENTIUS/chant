import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "./heartbeat";
import { sleep } from "./util";

const execAsync = promisify(exec);

export interface WaitForStackArgs {
  /** Stack name — used to locate the kubectl deployment/statefulset to poll. */
  name: string;
  /** Kubernetes namespace. */
  namespace?: string;
  /** kubectl context. */
  context?: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
}

/**
 * Poll until a Kubernetes Deployment or StatefulSet named `name` is fully rolled out.
 * Uses k8sWait profile — 15m timeout, heartbeat every poll.
 */
export async function waitForStack(args: WaitForStackArgs, signal?: AbortSignal): Promise<void> {
  const ns = args.namespace ? `-n ${args.namespace}` : "";
  const ctx = args.context ? `--context ${args.context}` : "";
  const interval = args.intervalMs ?? 10_000;
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw new Error("waitForStack aborted");
    attempt++;
    safeHeartbeat({ step: "waitForStack", stack: args.name, attempt });

    try {
      await execAsync(
        `kubectl rollout status deployment/${args.name} ${ns} ${ctx} --timeout=30s`,
        { signal },
      );
      return;
    } catch {
      if (signal?.aborted) throw new Error("waitForStack aborted");
      // Not ready yet — wait and retry
    }

    try {
      await execAsync(
        `kubectl rollout status statefulset/${args.name} ${ns} ${ctx} --timeout=30s`,
        { signal },
      );
      return;
    } catch {
      if (signal?.aborted) throw new Error("waitForStack aborted");
      // Not ready yet
    }

    await sleep(interval, signal);
  }
}
