/**
 * `chant kube top pods|nodes` (chant #1079).
 *
 * `metrics.k8s.io` is not part of the standard Kubernetes OpenAPI schema chant's
 * codegen ingests — it is an aggregated API a cluster may or may not be running
 * (metrics-server). It needs no entry in the generated operation surface either
 * way: the typed client's kubectl-style selector (`{ resource, group }`) resolves
 * purely off the *cluster's own* discovery, the same path `waitForReady`'s `kind`
 * argument already uses for CRDs — so this needs no client change, only the
 * right selector.
 *
 * Kubectl's own `top` sums each Pod's per-container usage into one CPU/memory
 * figure, which needs real quantity-unit arithmetic (`250m` + `100m`, `128Mi` +
 * `64Mi`). That normalization is not implemented here — each container's raw
 * usage string is shown as the API reported it, unsummed. Good enough for "is
 * anything obviously starved", not a replacement for `kubectl top --containers`.
 */

import { formatUnobserved } from "@intentius/chant/observation";
import { defaultK8sConnector, type K8sConnector } from "../api/connect";
import { classifyApiFailure } from "../api/classify";
import { kubeConnect } from "./connect";
import { parseKubeFlags, connectOptionsFrom } from "./flags";
import { renderTable } from "./render";

export interface TopDeps {
  connect?: K8sConnector;
}

const RESOURCE_ALIASES: Record<string, "pods" | "nodes"> = {
  pod: "pods",
  pods: "pods",
  po: "pods",
  node: "nodes",
  nodes: "nodes",
  no: "nodes",
};

export async function runTop(rawArgs: string[], deps: TopDeps = {}): Promise<number> {
  const connect = deps.connect ?? defaultK8sConnector;

  let flags;
  try {
    flags = parseKubeFlags(rawArgs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const resource = RESOURCE_ALIASES[flags.positional[0] ?? "pods"];
  if (!resource) {
    console.error(`error: unknown resource "${flags.positional[0]}" — chant kube top supports "pods" and "nodes"`);
    return 1;
  }

  const connected = await kubeConnect(connectOptionsFrom(flags.values), connect);
  if (connected.kind === "unobserved") {
    console.error(formatUnobserved(resource, { reason: connected.reason, detail: connected.detail }));
    return 1;
  }
  const { client } = connected;

  let info;
  try {
    info = await client.resolve({ resource, group: "metrics.k8s.io" });
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(resource, {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }
  if (!info) {
    console.error(
      "error: the metrics API (metrics.k8s.io) is not available in this cluster — is metrics-server installed?",
    );
    return 1;
  }

  const namespace = resource === "pods" && !flags.flags.allNamespaces ? (flags.values.namespace ?? client.defaultNamespace) : undefined;

  let items;
  try {
    items = await client.list(
      { apiVersion: info.apiVersion, kind: info.kind },
      { ...(namespace ? { namespace } : {}) },
    );
  } catch (err) {
    const outcome = classifyApiFailure(err);
    console.error(
      formatUnobserved(resource, {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail: outcome.kind === "unobserved" ? outcome.detail : String(err),
      }),
    );
    return 1;
  }

  if (resource === "nodes") {
    const rows = items.map((n) => [
      n.metadata?.name ?? "",
      String((n.usage as Record<string, unknown> | undefined)?.cpu ?? "<unknown>"),
      String((n.usage as Record<string, unknown> | undefined)?.memory ?? "<unknown>"),
    ]);
    console.log(renderTable(["NAME", "CPU", "MEMORY"], rows));
    return 0;
  }

  const rows = items.map((p) => {
    const containers = (p.containers as Array<{ name?: string; usage?: Record<string, unknown> }> | undefined) ?? [];
    const cpu = containers.map((c) => `${c.name}:${c.usage?.cpu ?? "?"}`).join(",") || "<none>";
    const memory = containers.map((c) => `${c.name}:${c.usage?.memory ?? "?"}`).join(",") || "<none>";
    return [p.metadata?.namespace ?? "", p.metadata?.name ?? "", cpu, memory];
  });
  console.log(renderTable(["NAMESPACE", "NAME", "CPU (per container)", "MEMORY (per container)"], rows));
  return 0;
}
