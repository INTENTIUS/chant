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
import { DEFAULT_IMPORT_TYPES } from "./api/sweep-types";

/**
 * Entity types a bare `chant import --from <cluster>` sweeps: the workload,
 * config, networking and RBAC kinds people actually author. Everything else is
 * reachable by naming it with `--selector type=...`. Defined in
 * `./api/sweep-types.ts` and re-exported here, its original home — chant
 * #1075's ownership-scoped prune needs the same list without pulling the
 * import parser into a Temporal worker.
 */
export { DEFAULT_IMPORT_TYPES };

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
