/**
 * Live export for the GCP Config Connector lexicon — implements
 * LexiconPlugin.exportResources() so `chant import --from <gcp-env>`
 * regenerates GCP resources as chant TypeScript.
 *
 * Config Connector encodes each GCP resource as a Kubernetes CRD on a
 * management cluster, so export reads live CC objects with kubectl and maps
 * them to the import IR. A type selector targets one kind; otherwise every
 * `*.cnrm.cloud.google.com` resource kind is discovered and swept. All I/O
 * lives here; cleaning and IR-building is pure in `./import/live-export`.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import { deriveGVK } from "./describe-resources";
import { buildExportFromObjects } from "./import/live-export";

const execAsync = promisify(exec);

interface KubectlList {
  items?: unknown[];
}

/** Discover all Config Connector resource kinds present in the cluster. */
async function discoverCnrmResources(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("kubectl api-resources -o name");
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.endsWith(".cnrm.cloud.google.com"));
  } catch {
    return [];
  }
}

export async function exportResources(options: {
  environment: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}): Promise<ExportedTemplate> {
  let resources: string[];
  if (options.selector?.type) {
    const gvk = deriveGVK(options.selector.type);
    resources = gvk ? [`${gvk.kind.toLowerCase()}.${gvk.group}`] : [];
  } else {
    resources = await discoverCnrmResources();
  }

  if (resources.length === 0) {
    return { resources: [], parameters: [] };
  }

  const objects: unknown[] = [];
  for (const resource of resources) {
    try {
      const { stdout } = await execAsync(
        ["kubectl", "get", resource, "-A", "-o", "json"].join(" "),
      );
      const list = JSON.parse(stdout) as KubectlList;
      if (Array.isArray(list.items)) objects.push(...list.items);
    } catch {
      // Kind absent / RBAC denied — skip, don't fail the whole export.
    }
  }

  // `owned` is accepted but inert until ownership marking lands (#120).
  return buildExportFromObjects(objects, {
    verbatim: options.verbatim,
    selector: options.selector,
  });
}
