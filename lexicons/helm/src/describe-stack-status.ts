/**
 * Deploy-unit status for Helm (#1495 piece 4).
 *
 * A Helm deploy unit *is* a release: `helm list` already reports its
 * presence, revision, and native status, and that status lands on
 * `StackStatusObservation` almost field-for-field — `deployed` is the one
 * terminal success state, so `healthy` is exactly `status === "deployed"`.
 * This reads back what `helm-upgrade` (the paired capability) writes, the
 * same one-name-both-jobs pairing `cfn-deploy`/`kubectl-apply` have.
 *
 * Tri-state, matching the k8s observer's contract:
 *  - release found        → `{ present: true, status, healthy }`
 *  - release not in list  → `{ present: false }` (pre-first-install)
 *  - helm missing, no cluster, exec failure, unparseable output → `null` —
 *    "I cannot tell", never a confident absence.
 *
 * Cluster selection follows #1488: the environment's declared k8s binding
 * (`k8s.profiles.<env>.context`) is passed as `--kube-context` when present;
 * ambient otherwise. A Helm release lives on the same cluster the k8s half
 * observes, so it rides the same binding.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { StackStatusObservation } from "@intentius/chant/lexicon";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { resolveClusterTarget } from "@intentius/chant/kubectl-context";

const execAsync = promisify(exec);

/** Injectable command runner, so tests drive every branch without helm or a cluster. */
export type HelmRunner = (command: string) => Promise<{ stdout: string }>;

interface HelmListEntry {
  name?: string;
  namespace?: string;
  status?: string;
  revision?: string;
}

export async function describeStackStatus(
  options: { environment: string; stack: string },
  run: HelmRunner = execAsync,
): Promise<StackStatusObservation | null> {
  // The unit is a release name, optionally namespace-qualified as
  // "<namespace>/<name>" when the same release name exists in two namespaces.
  const slash = options.stack.indexOf("/");
  const wantNs = slash > 0 ? options.stack.slice(0, slash) : undefined;
  const wantName = slash > 0 ? options.stack.slice(slash + 1) : options.stack;

  let context: string | undefined;
  try {
    const { config } = await loadChantConfigUpward(process.cwd());
    context = (await resolveClusterTarget(config as Record<string, unknown>, options.environment, "helm")).context;
  } catch {
    context = undefined;
  }

  let stdout: string;
  try {
    ({ stdout } = await run(`helm list -A -o json${context ? ` --kube-context '${context.replace(/'/g, "'\\''")}'` : ""}`));
  } catch {
    // Binary missing, no kubeconfig, cluster unreachable — indeterminate.
    return null;
  }

  let entries: HelmListEntry[];
  try {
    entries = JSON.parse(stdout) as HelmListEntry[];
    if (!Array.isArray(entries)) return null;
  } catch {
    return null;
  }

  const found = entries.find(
    (e) => e.name === wantName && (wantNs === undefined || e.namespace === wantNs),
  );
  if (!found) return { stack: options.stack, present: false };

  return {
    stack: options.stack,
    present: true,
    ...(found.status ? { status: found.status, healthy: found.status === "deployed" } : {}),
  };
}
