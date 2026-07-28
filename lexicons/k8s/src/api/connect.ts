/**
 * Getting from a chant environment to a live API client — chant #1074.
 *
 * The cluster binding (chant #1100, landed in #1155) is unchanged by the move
 * off `kubectl`, and deliberately so: `resolveClusterTarget` in core stays the
 * single resolver, shared with the GCP lexicon's Config Connector observation,
 * and the refusal it throws on a bound-but-mismatched context still aborts
 * before any resource is touched. What changes is only *how the ambient
 * context is read*: the typed client parses the kubeconfig it is about to use
 * rather than shelling `kubectl config current-context`, so a worker image with
 * no `kubectl` in it can still check the binding. Same question, same three
 * outcomes:
 *
 * - **Bound and ambient agrees** — the bound context is passed explicitly to
 *   the client, never left to the ambient default.
 * - **Bound and ambient disagrees** — `ClusterBindingMismatchError`, thrown
 *   before the first request. Core turns the throw into NOT-OBSERVED for every
 *   declared entity (chant #1089), which is what stops a wrong-cluster read
 *   becoming a confident list of creates.
 * - **Unbound** — the kubeconfig's own current-context, with the same visible
 *   warning naming the environment and the missing binding.
 */

import { loadChantConfig } from "@intentius/chant/config";
import { resolveClusterTarget, type ResolvedClusterTarget } from "@intentius/chant/kubectl-context";
import type { K8sClient, K8sClientOptions } from "@intentius/chant-k8s-client";
import type { K8sChantConfig } from "../config";

/**
 * Build a client for an environment. Injectable so tests drive the real client
 * against a fake request layer, and so `describeResources` and the Op
 * activities share one connection story rather than each inventing one.
 */
export type K8sConnector = (options: ConnectOptions) => Promise<ConnectedClient>;

export interface ConnectOptions {
  /**
   * chant environment being observed or applied to. Omitting it skips the
   * config lookup and the binding check — which is what an Op activity called
   * with no environment and no explicit context has always done: use whatever
   * the kubeconfig selects.
   */
  environment?: string;
  /** Directory whose `chant.config.ts` carries `k8s.profiles`. Defaults to cwd. */
  cwd?: string;
  /**
   * An explicit context, for the Op write path whose activity contract has
   * always taken one. Skips the config lookup and the binding check entirely.
   */
  context?: string;
  /** Extra client options — the request-layer seam, concurrency. */
  client?: Partial<K8sClientOptions>;
}

export interface ConnectedClient {
  client: K8sClient;
  target: ResolvedClusterTarget;
}

/**
 * The production connector: read the project's config, resolve the binding,
 * build a client honoring it.
 */
export const defaultK8sConnector: K8sConnector = async (options) => {
  const { createK8sClient, readAmbientContext } = await import("@intentius/chant-k8s-client");

  if (options.context !== undefined) {
    const client = await createK8sClient({
      context: options.context,
      contextSource: "bound",
      ...options.client,
    });
    return { client, target: { context: options.context, source: "bound" } };
  }

  if (options.environment === undefined) {
    const client = await createK8sClient({ contextSource: "ambient", ...options.client });
    return { client, target: { source: "ambient" } };
  }

  const { config } = await loadChantConfig(options.cwd ?? process.cwd());
  const k8sConfig = (config as { k8s?: K8sChantConfig }).k8s;
  const execAllowlist = k8sConfig?.execCredentialPlugins;

  // The binding check reads the kubeconfig's current-context directly. Only a
  // context name is needed, and requiring a *usable* ambient cluster to check a
  // binding would defeat the binding: pointing an environment at a specific
  // context is how you recover from an ambient one that is wrong or broken.
  const target = await resolveClusterTarget(config as Record<string, unknown>, options.environment, "k8s", {
    ambientContext: () =>
      readAmbientContext({
        kubeconfig: options.client?.kubeconfig,
        kubeconfigPath: options.client?.kubeconfigPath,
      }),
  });

  const client = await createK8sClient({
    ...options.client,
    ...(target.context ? { context: target.context } : {}),
    contextSource: target.source,
    ...(execAllowlist ? { execAllowlist } : {}),
  });
  return { client, target };
};
