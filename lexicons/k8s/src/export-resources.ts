/**
 * Live export for the Kubernetes lexicon — implements
 * LexiconPlugin.exportResources() so `chant import --from <cluster-env>`
 * regenerates live objects as chant TypeScript.
 *
 * Reads live objects through the typed API client (chant #1074, previously
 * `kubectl get <kinds> -A -o json`), strips server-managed noise to reach the
 * declared shape (kept under `verbatim`), and maps to the import IR via the
 * shared K8sParser. All I/O lives here; the cleaning and IR-building logic is
 * pure in `./import/live-export`.
 *
 * The list below is a *product* decision — what a bare `chant import` should
 * sweep when the caller names no type — not an addressing limit. It used to be
 * both, because `KUBECTL_RESOURCE` was simultaneously the sweep set and the
 * only way the lexicon knew how to address anything (chant #1074 removed the
 * second job). A `--selector type=<entity type>` import can now name any of the
 * ~180 types the generated operation surface carries, CRDs included.
 */
import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import { operationFor } from "./api/operation-surface";
import { buildExportFromObjects } from "./import/live-export";

/**
 * Entity types a bare `chant import --from <cluster>` sweeps: the workload,
 * config, networking and RBAC kinds people actually author. Everything else is
 * reachable by naming it with `--selector type=...`.
 */
export const DEFAULT_IMPORT_TYPES: readonly string[] = [
  "K8s::Apps::Deployment",
  "K8s::Apps::StatefulSet",
  "K8s::Apps::DaemonSet",
  "K8s::Apps::ReplicaSet",
  "K8s::Core::Service",
  "K8s::Core::ConfigMap",
  "K8s::Core::Secret",
  "K8s::Core::Namespace",
  "K8s::Core::Pod",
  "K8s::Core::PersistentVolumeClaim",
  "K8s::Core::ServiceAccount",
  "K8s::Batch::Job",
  "K8s::Batch::CronJob",
  "K8s::Networking::Ingress",
  "K8s::Networking::NetworkPolicy",
  "K8s::Rbac::Role",
  "K8s::Rbac::RoleBinding",
  "K8s::Rbac::ClusterRole",
  "K8s::Rbac::ClusterRoleBinding",
];

export async function exportResources(
  options: {
    environment: string;
    selector?: ResourceSelector;
    owned?: boolean;
    verbatim?: boolean;
    cwd?: string;
  },
  connect: K8sConnector = defaultK8sConnector,
): Promise<ExportedTemplate> {
  const types = options.selector?.type ? [options.selector.type] : DEFAULT_IMPORT_TYPES;
  const operations = types.map((t) => operationFor(t)).filter((o) => o !== undefined);

  if (operations.length === 0) {
    return { resources: [], parameters: [] };
  }

  const { client } = await connect({ environment: options.environment, cwd: options.cwd });

  // One List per kind keeps parsing simple and isolates a missing-kind error
  // to that kind rather than failing the whole export. They now run
  // concurrently instead of serially.
  const perKind = await client.concurrently(operations, async (operation) => {
    try {
      return await client.list({ apiVersion: operation.apiVersion, kind: operation.kind });
    } catch {
      // Kind not served by this cluster / RBAC denied — skip it, don't fail
      // the whole export.
      return [];
    }
  });

  return buildExportFromObjects(perKind.flat(), {
    verbatim: options.verbatim,
    selector: options.selector,
    owned: options.owned,
  });
}
