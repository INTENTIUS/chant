/**
 * Live introspection of Helm releases via `helm list -A -o json`.
 *
 * The Helm lexicon's chant entities describe chart-authoring primitives
 * (Chart.yaml, templates/, values.yaml). The runtime concept — a Helm
 * release installed in a kubeconfig context — is created by `helm install`
 * outside chant's entity model. This implementation reports those releases
 * as artifacts so `state diff --live` / `WatchOp` can detect manual
 * installs/upgrades/rollbacks that slip past CI.
 *
 * Helm-not-installed (binary missing) → returns `{}` cleanly so other
 * lexicons' snapshots aren't blocked.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactMetadata } from "@intentius/chant/lexicon";

const execAsync = promisify(exec);

interface HelmListEntry {
  name?: string;
  namespace?: string;
  revision?: string;
  updated?: string;
  status?: string;
  chart?: string;
  app_version?: string;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function listArtifacts(_options: {
  environment: string;
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};

  let stdout: string;
  try {
    ({ stdout } = await execAsync("helm list -A -o json"));
  } catch {
    // Binary not installed, no kubeconfig, or some other error — return
    // empty rather than blocking the whole snapshot.
    return result;
  }

  let entries: HelmListEntry[];
  try {
    entries = JSON.parse(stdout);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.name || !entry.namespace) continue;
    const key = `release/${entry.namespace}/${entry.name}`;
    result[key] = {
      type: "Helm::Release",
      physicalId: `${entry.namespace}/${entry.name}`,
      status: entry.status ?? "unknown",
      lastUpdated: entry.updated,
      attributes: pruneUndefined({
        chart: entry.chart,
        revision: entry.revision,
        appVersion: entry.app_version,
        namespace: entry.namespace,
      }),
    };
  }

  return result;
}
