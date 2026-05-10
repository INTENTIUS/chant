/**
 * Live introspection of a Slurm cluster via `sinfo --json`.
 *
 * The Slurm lexicon's chant entities describe sbatch-script authoring.
 * Cluster-runtime queries — partitions, nodes, jobs — are conceptually
 * orthogonal. We surface partition state because it's reasonably stable
 * (drift = config change), and skip job history because it's high-churn
 * (every snapshot would diff).
 *
 *   sinfo --json  →  partitions
 *
 * Slurm not installed → returns `{}` cleanly. The sinfo JSON schema
 * varies by Slurm version; this implementation reads several common
 * paths and degrades to "unknown" when fields are missing.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactMetadata } from "@intentius/chant/lexicon";

const execAsync = promisify(exec);

interface SinfoPartitionEntry {
  // Newer Slurm (22+): { partition: { name, state }, nodes, cpus, memory }
  partition?: { name?: string; state?: string[] | string };
  nodes?: { count?: number; total?: number; allocated?: number; idle?: number };
  cpus?: { total?: number };
  memory?: { total?: number };
  // Older fallback: flat fields
  name?: string;
  state?: string;
  partition_name?: string;
}

interface SinfoResponse {
  // Newer Slurm: { sinfo: [...] }
  sinfo?: SinfoPartitionEntry[];
  // Older fallback: top-level array
  partitions?: SinfoPartitionEntry[];
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

function partitionName(entry: SinfoPartitionEntry): string | undefined {
  return entry.partition?.name ?? entry.name ?? entry.partition_name;
}

function partitionState(entry: SinfoPartitionEntry): string {
  const s = entry.partition?.state ?? entry.state;
  if (Array.isArray(s)) return s.join(",") || "UNKNOWN";
  if (typeof s === "string") return s;
  return "UNKNOWN";
}

export async function listArtifacts(_options: {
  environment: string;
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};

  let stdout: string;
  try {
    ({ stdout } = await execAsync("sinfo --json"));
  } catch {
    // sinfo not on PATH or no Slurm cluster context — return empty
    return result;
  }

  let parsed: SinfoResponse;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return result;
  }

  const entries = parsed.sinfo ?? parsed.partitions ?? [];
  for (const entry of entries) {
    const name = partitionName(entry);
    if (!name) continue;
    const key = `partition/${name}`;
    // Skip duplicates — sinfo rows can repeat the same partition with different
    // node-state buckets; we just want one row per partition for drift purposes.
    if (key in result) continue;

    result[key] = {
      type: "Slurm::Partition",
      physicalId: name,
      status: partitionState(entry),
      attributes: pruneUndefined({
        nodeCount: entry.nodes?.count ?? entry.nodes?.total,
        nodesAllocated: entry.nodes?.allocated,
        nodesIdle: entry.nodes?.idle,
        cpus: entry.cpus?.total,
        memory: entry.memory?.total,
      }),
    };
  }

  return result;
}
