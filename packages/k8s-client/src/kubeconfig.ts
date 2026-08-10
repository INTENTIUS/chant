/**
 * Loading the kubeconfig the way kubectl loads it — chant #1630.
 *
 * `@kubernetes/client-node` parses a kubeconfig faithfully and merges a
 * `KUBECONFIG` path list on two rules that are not kubectl's. Both are
 * reproducible with two files and no cluster (checked against client-node
 * 1.4.0), and both make chant bind a different cluster than the `kubectl get`
 * the operator ran to check:
 *
 * - **Duplicate names throw.** `mergeConfig` funnels every entry through
 *   `addCluster`/`addUser`/`addContext`, each of which throws `Duplicate
 *   cluster: <name>` on a name it already holds. kubectl's documented rule is
 *   the opposite — keep the first, ignore later ones, never fail. Overlapping
 *   names across a list are ordinary: a team-wide file plus a personal one
 *   both naming `dev` is the usual way people get there. Today that throw is
 *   swallowed by `readAmbientContext`'s try/catch, so chant reads those users
 *   as having no kubeconfig at all.
 * - **current-context is last-wins.** `loadFromDefault(opts,
 *   contextFromStartingConfig)` defaults the second argument to `false`, and
 *   `mergeConfig` then overwrites `currentContext` from each later file.
 *   kubectl takes the FIRST file that sets one.
 *
 * So the multi-file case is merged here instead: one `KubeConfig` per file
 * (which is also what keeps each file's relative certificate paths resolved
 * against its own directory), then a first-wins union by name and the first
 * `current-context` that appears. Everything else — the single-file path, the
 * `~/.kube/config` fallback, in-cluster credentials — stays client-node's
 * `loadFromDefault`, with the one-word fix that gives it kubectl's
 * current-context.
 *
 * A file in the list that cannot be read is skipped rather than fatal, which
 * is also kubectl's rule: a stale entry in a shared `KUBECONFIG` export must
 * not take the whole config down with it.
 */

import { delimiter } from "node:path";
import type * as k8s from "@kubernetes/client-node";

type ClientNode = typeof import("@kubernetes/client-node");

/** Where the loaded kubeconfig came from, for {@link ClientProvenance}. */
export type KubeconfigSource = "explicit-string" | "explicit-path" | "default" | "in-cluster";

export interface LoadedKubeConfig {
  kc: k8s.KubeConfig;
  source: KubeconfigSource;
}

/** The `KUBECONFIG` entries, in order. Empty when the variable is unset. */
function kubeconfigPathList(): string[] {
  const raw = process.env.KUBECONFIG;
  if (!raw) return [];
  return raw.split(delimiter).filter((f) => f.length > 0);
}

/**
 * Merge a `KUBECONFIG` path list on kubectl's rules: first-wins for every
 * cluster/user/context name, and the first `current-context` that any file
 * sets. Unreadable files are skipped.
 */
function mergeKubeconfigFiles(mod: ClientNode, files: readonly string[]): k8s.KubeConfig {
  const clusters: k8s.Cluster[] = [];
  const users: k8s.User[] = [];
  const contexts: k8s.Context[] = [];
  const seenClusters = new Set<string>();
  const seenUsers = new Set<string>();
  const seenContexts = new Set<string>();
  let currentContext: string | undefined;

  for (const file of files) {
    const part = new mod.KubeConfig();
    try {
      part.loadFromFile(file);
    } catch {
      continue;
    }
    for (const cluster of part.getClusters()) {
      if (seenClusters.has(cluster.name)) continue;
      seenClusters.add(cluster.name);
      clusters.push(cluster);
    }
    for (const user of part.getUsers()) {
      if (seenUsers.has(user.name)) continue;
      seenUsers.add(user.name);
      users.push(user);
    }
    for (const context of part.getContexts()) {
      if (seenContexts.has(context.name)) continue;
      seenContexts.add(context.name);
      contexts.push(context);
    }
    if (currentContext === undefined) {
      const current = part.getCurrentContext();
      if (current) currentContext = current;
    }
  }

  const kc = new mod.KubeConfig();
  kc.loadFromOptions({ clusters, users, contexts, currentContext });
  return kc;
}

/**
 * The kubeconfig this invocation should read, by the same precedence every
 * entry point in this package uses: an explicit literal, then an explicit
 * path, then the ambient default (`KUBECONFIG`, `~/.kube/config`, in-cluster).
 *
 * Throws whatever client-node throws for an explicit string or path — those
 * are the caller naming a file, and a caller who names an unreadable one wants
 * to hear about it. The ambient path never throws for a duplicate name.
 */
export function loadKubeConfig(
  mod: ClientNode,
  options: { kubeconfig?: string; kubeconfigPath?: string } = {},
): LoadedKubeConfig {
  if (options.kubeconfig !== undefined) {
    const kc = new mod.KubeConfig();
    kc.loadFromString(options.kubeconfig);
    return { kc, source: "explicit-string" };
  }
  if (options.kubeconfigPath !== undefined) {
    const kc = new mod.KubeConfig();
    kc.loadFromFile(options.kubeconfigPath);
    return { kc, source: "explicit-path" };
  }

  const files = kubeconfigPathList();
  if (files.length > 1) return { kc: mergeKubeconfigFiles(mod, files), source: "default" };

  const kc = new mod.KubeConfig();
  // `true` is the whole current-context fix for the single-file and
  // `~/.kube/config` paths: it tells client-node to keep the starting config's
  // context rather than letting a later merge overwrite it.
  kc.loadFromDefault(undefined, true);
  return { kc, source: kc.getCurrentContext() === "inCluster" ? "in-cluster" : "default" };
}
