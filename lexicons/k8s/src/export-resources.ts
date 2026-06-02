/**
 * Live export for the Kubernetes lexicon — implements
 * LexiconPlugin.exportResources() so `chant import --from <cluster-env>`
 * regenerates live objects as chant TypeScript.
 *
 * Reads live objects with `kubectl get <kinds> -A -o json`, strips
 * server-managed noise to reach the declared shape (kept under `verbatim`),
 * and maps to the import IR via the shared K8sParser. All I/O lives here; the
 * cleaning and IR-building logic is pure in `./import/live-export`.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { KUBECTL_RESOURCE } from "./describe-resources";
import { buildExportFromObjects } from "./import/live-export";

const execAsync = promisify(exec);

interface KubectlList {
  items?: unknown[];
}

export async function exportResources(options: {
  environment: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}): Promise<ExportedTemplate> {
  // Resolve which kinds to query. A type selector narrows to one kind;
  // otherwise sweep every kind chant knows how to map.
  const kinds = options.selector?.type
    ? [KUBECTL_RESOURCE[options.selector.type]].filter(Boolean)
    : Array.from(new Set(Object.values(KUBECTL_RESOURCE)));

  if (kinds.length === 0) {
    return { resources: [], parameters: [] };
  }

  // One List per kind keeps parsing simple and isolates a missing-kind error
  // to that kind rather than failing the whole export.
  const objects: unknown[] = [];
  for (const kind of kinds) {
    try {
      const { stdout } = await execAsync(
        ["kubectl", "get", kind, "-A", "-o", "json"].join(" "),
      );
      const list = JSON.parse(stdout) as KubectlList;
      if (Array.isArray(list.items)) objects.push(...list.items);
    } catch {
      // Kind not present in the cluster / RBAC denied — skip it, don't fail
      // the whole export.
    }
  }

  // `owned` is accepted but inert until ownership marking lands (#120).
  return buildExportFromObjects(objects, {
    verbatim: options.verbatim,
    selector: options.selector,
  });
}
