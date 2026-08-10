/**
 * Getting from a chant environment to a live API client — chant #1074.
 *
 * The cluster binding (chant #1100/#1155, revised by #1488):
 * `resolveClusterTarget` in core stays the single resolver, and a declared
 * binding is now *used*, never policed against the ambient context. Two
 * outcomes:
 *
 * - **Bound** — the bound context is passed explicitly to the client,
 *   regardless of what `kubectl` is ambiently pointed at. A binding that
 *   names a context the kubeconfig does not have fails in the client with an
 *   error naming both the context and the `k8s.profiles.<env>.context`
 *   binding — never by falling back to ambient. (#1488: the old
 *   ambient-mismatch refusal meant any other project's k3d cluster stealing
 *   the current-context turned a healthy estate grey with `read-failed` as
 *   the only explanation.)
 * - **Unbound** — the kubeconfig's own current-context, with a visible
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
  const { createK8sClient } = await import("@intentius/chant-k8s-client");

  if (options.context !== undefined) {
    const client = await createK8sClient({
      context: options.context,
      contextSource: "bound",
      contextLabel: "explicit --context",
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

  // #1488 — the resolver returns the declared binding (or ambient-with-warning
  // when unbound); it no longer reads the ambient context at all, so no reader
  // is supplied.
  const target = await resolveClusterTarget(config as Record<string, unknown>, options.environment, "k8s");

  // #1488 — every failure the client throws names the cluster it read and how
  // that cluster was selected, so a `read-failed` against the wrong context is
  // legible from the reason alone.
  const contextLabel =
    target.source === "bound"
      ? `bound by k8s.profiles.${options.environment}.context`
      : `ambient; no k8s.profiles.${options.environment} binding`;

  const client = await createK8sClient({
    ...options.client,
    ...(target.context ? { context: target.context } : {}),
    contextSource: target.source,
    contextLabel,
    ...(execAllowlist ? { execAllowlist } : {}),
  });
  return { client, target };
};
