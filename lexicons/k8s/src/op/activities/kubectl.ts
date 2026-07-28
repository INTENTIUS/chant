/**
 * `kubectlApply` — apply a rendered manifest to a cluster.
 *
 * chant #1074 moved this off `kubectl apply -f`. The activity contract is
 * unchanged (a manifest path, an optional context, `Promise<void>`, the
 * `longInfra` profile's 15s heartbeat) because Temporal workers register it by
 * that signature; what changed is underneath. The name is kept for the same
 * reason.
 *
 * Consequences worth knowing:
 *
 * - **A worker image needs no `kubectl` binary.** That was the point.
 * - **It is a server-side apply**, with `chant` as the field manager, rather
 *   than the client-side three-way merge `kubectl apply` performs by default.
 *   Server-side apply is the direction Kubernetes itself has taken, it removes
 *   the `last-applied-configuration` annotation from the story, and it is what
 *   chant #1075 builds the field-ownership and conflict surface on. A conflict
 *   with another field manager arrives here as a typed 409 rather than a line
 *   of stderr; #1075 is where it gets a proper presentation.
 * - **Documents apply in file order**, as `kubectl apply -f` does, and a
 *   directory's files are read in sorted order.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";
import { safeHeartbeat } from "@intentius/chant/op";
import type { K8sObject } from "@intentius/chant-k8s-client";
import { defaultK8sConnector, type K8sConnector } from "../../api/connect";

export interface KubectlApplyArgs {
  /** Path to a manifest file, or a directory of them. */
  manifest: string;
  /**
   * kubectl context name. Uses the ambient context if omitted. To target the
   * same cluster the read path (`describeResources`) resolved for an
   * environment — chant #1100 — resolve it with `resolveClusterTarget` from
   * `./index.ts` and pass `.context` through.
   */
  context?: string;
  /**
   * chant environment, used to resolve `k8s.profiles.<env>.context` when no
   * explicit `context` is given. Optional and additive: omitting both keeps
   * the previous behavior of using whatever the kubeconfig selects.
   */
  environment?: string;
  /** Field manager recorded on the applied objects. Default `chant`. */
  fieldManager?: string;
  /** Take ownership of fields another manager owns instead of failing (chant #1075). */
  force?: boolean;
}

/** Read a manifest path — one file, or every YAML/JSON file in a directory. */
export function readManifestDocuments(path: string): Record<string, unknown>[] {
  const files = statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => /\.(ya?ml|json)$/i.test(f))
        .sort()
        .map((f) => join(path, f))
    : [path];

  const documents: Record<string, unknown>[] = [];
  for (const file of files) {
    for (const doc of loadAll(readFileSync(file, "utf-8"))) {
      // Multi-document YAML files routinely carry empty documents between
      // separators; they are not objects to apply.
      if (doc && typeof doc === "object") documents.push(doc as Record<string, unknown>);
    }
  }
  return documents;
}

/**
 * Apply every document in `args.manifest`.
 * Uses longInfra profile — 20m timeout, heartbeat every 15s.
 */
export async function kubectlApply(
  args: KubectlApplyArgs,
  signal?: AbortSignal,
  connect: K8sConnector = defaultK8sConnector,
): Promise<void> {
  const documents = readManifestDocuments(args.manifest);
  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "kubectl apply", manifest: args.manifest });
  }, 15_000);

  try {
    const { client } = await connect({
      ...(args.environment !== undefined ? { environment: args.environment } : {}),
      ...(args.context !== undefined ? { context: args.context } : {}),
    });

    for (const document of documents) {
      const applied = await client.apply(document as K8sObject, {
        fieldManager: args.fieldManager ?? "chant",
        force: args.force ?? false,
        signal,
      });
      safeHeartbeat({
        step: "kubectl apply",
        manifest: args.manifest,
        applied: `${applied.kind ?? document.kind}/${applied.metadata?.name ?? "?"}`,
      });
      console.log(
        `${String(applied.apiVersion ?? document.apiVersion)} ${String(applied.kind ?? document.kind)}/${String(applied.metadata?.name ?? "")} applied`,
      );
    }
  } finally {
    clearInterval(heartbeatInterval);
  }
}
