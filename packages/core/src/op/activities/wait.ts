import { exec } from "node:child_process";
import { promisify } from "node:util";
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
 * Uses the `k8sWait` profile — 15m timeout.
 *
 * Progress goes to stdout, one line per poll, which is the executor's step-record
 * channel: the local executor streams an activity's output alongside the step it
 * belongs to, so a long rollout is visible without a liveness protocol. Nothing
 * mid-run is durable here by design (chant #2114) — the op re-runs and converges.
 *
 * Deliberately NOT migrated onto the generic `waitForReady` (#957): `kubectl
 * rollout status` encodes rollout-specific semantics — progress-deadline
 * timeouts, partial/paused rollouts, generation tracking — that a status-field
 * predicate spec does not replicate, and it targets built-in workloads rather
 * than arbitrary operator CRDs. `waitForReady` is the right tool for CRD
 * readiness; `waitForStack` stays the right tool for workload rollouts.
 */
export async function waitForStack(args: WaitForStackArgs, signal?: AbortSignal): Promise<void> {
  const ns = args.namespace ? `-n ${args.namespace}` : "";
  const ctx = args.context ? `--context ${args.context}` : "";
  const interval = args.intervalMs ?? 10_000;
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw new Error("waitForStack aborted");
    attempt++;
    console.log(`[waitForStack] ${args.name}: poll ${attempt}`);

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
