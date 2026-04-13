import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Context } from "@temporalio/activity";

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
 * Uses k8sWait profile — 15m timeout, heartbeat every 60s.
 */
export async function waitForStack(args: WaitForStackArgs): Promise<void> {
  const ns = args.namespace ? `-n ${args.namespace}` : "";
  const ctx = args.context ? `--context ${args.context}` : "";
  const interval = args.intervalMs ?? 10_000;
  let attempt = 0;

  while (true) {
    attempt++;
    Context.current().heartbeat({ step: "waitForStack", stack: args.name, attempt });

    try {
      await execAsync(
        `kubectl rollout status deployment/${args.name} ${ns} ${ctx} --timeout=30s`,
      );
      return;
    } catch {
      // Not ready yet — wait and retry
    }

    try {
      await execAsync(
        `kubectl rollout status statefulset/${args.name} ${ns} ${ctx} --timeout=30s`,
      );
      return;
    } catch {
      // Not ready yet
    }

    await new Promise((r) => setTimeout(r, interval));
  }
}
