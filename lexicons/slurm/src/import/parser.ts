/**
 * Slurm configuration import parser.
 *
 * Parses an existing slurm.conf (or slurm.conf fragment) into an intermediate
 * representation (IR) for TypeScript code generation via the generator.
 *
 * slurm.conf is NOT YAML — it uses a key=value format with stanzas:
 *   - Global key=value lines (ClusterName, ControlMachine, ...)
 *   - NodeName stanzas (inline key=value on one line)
 *   - PartitionName stanzas (inline key=value on one line)
 *
 * All Slurm conf options are parsed on the same key=value basis.
 */

// ── IR types ────────────────────────────────────────────────────────

export interface ClusterIR {
  kind: "cluster";
  name: string;
  props: Record<string, unknown>;
}

export interface NodeIR {
  kind: "node";
  name: string;
  props: Record<string, unknown>;
}

export interface PartitionIR {
  kind: "partition";
  name: string;
  props: Record<string, unknown>;
}

export interface LicenseIR {
  kind: "license";
  name: string;
  props: Record<string, unknown>;
}

export type SlurmIR = ClusterIR | NodeIR | PartitionIR | LicenseIR;

export interface ParseResult {
  entities: SlurmIR[];
  warnings: string[];
}

// ── Allowed props (allowlists) ────────────────────────────────────

const CLUSTER_PROPS = [
  "ClusterName", "ControlMachine", "AuthType", "AuthAltTypes", "AuthAltParameters",
  "StateSaveLocation", "SlurmctldPort", "SlurmdPort", "SlurmctldLogFile", "SlurmdLogFile",
  "SlurmctldPidFile", "SlurmdPidFile", "SelectType", "SelectTypeParameters",
  "SlurmctldParameters", "ProctrackType", "PropagateResourceLimitsExcept",
  "AccountingStorageType", "AccountingStorageHost", "AccountingStorageEnforce",
  "GresTypes", "Licenses", "PriorityType", "PriorityWeightFairshare",
  "PriorityWeightAge", "PriorityWeightJobSize", "PriorityWeightPartition",
  "PriorityDecayHalfLife", "SchedulerType", "JobAcctGatherType",
  "JobAcctGatherFrequency", "CompleteWait", "KillWait",
  "SuspendProgram", "ResumeProgram", "SuspendTime", "ResumeTimeout",
] as const;

const NODE_PROPS = [
  "NodeName", "NodeAddr", "CPUs", "RealMemory", "Sockets", "CoresPerSocket",
  "ThreadsPerCore", "Gres", "Feature", "State", "Weight", "TmpDisk",
] as const;

const PARTITION_PROPS = [
  "PartitionName", "Nodes", "Default", "MaxTime", "State", "OverSubscribe",
  "Priority", "QOS", "DefMemPerCPU", "DefMemPerNode", "MaxMemPerCPU",
  "MaxMemPerNode", "AllowGroups", "AllowAccounts", "DenyAccounts",
  "PreemptMode", "TRESBillingWeights", "LLN",
] as const;

// ── Parser helpers ────────────────────────────────────────────────

/**
 * Parse an inline stanza line (e.g. "NodeName=node001 CPUs=96 RealMemory=196608")
 * into a key→value map.
 */
function parseStanza(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Match KEY=VALUE pairs; values may contain slashes, commas, dots but not spaces
  const re = /(\w+)=(\S+)/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

/**
 * Coerce a string value to a number if it looks like one, otherwise return as-is.
 */
function coerce(value: string): unknown {
  const n = Number(value);
  if (!isNaN(n) && value.trim() !== "") return n;
  return value;
}

/**
 * Extract only the allowed keys from a raw stanza map.
 */
function extractAllowed(
  raw: Record<string, string>,
  allowed: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in raw) result[key] = coerce(raw[key]);
  }
  return result;
}

// ── Main parser ────────────────────────────────────────────────────

/**
 * Parse slurm.conf content into an array of typed IR entities.
 */
export class SlurmConfParser {
  parse(content: string): ParseResult {
    if (!content.trim()) return { entities: [], warnings: [] };

    const entities: SlurmIR[] = [];
    const warnings: string[] = [];

    // Accumulate global key=value pairs for the Cluster entity
    const globalProps: Record<string, string> = {};

    for (let line of content.split("\n")) {
      // Strip comments and whitespace
      const commentIdx = line.indexOf("#");
      if (commentIdx >= 0) line = line.substring(0, commentIdx);
      line = line.trim();
      if (!line) continue;

      // NodeName stanza
      if (line.startsWith("NodeName=")) {
        const raw = parseStanza(line);
        const props = extractAllowed(raw, NODE_PROPS);
        const nodeName = String(props.NodeName ?? raw.NodeName ?? "node");
        entities.push({ kind: "node", name: nodeName, props });
        continue;
      }

      // PartitionName stanza
      if (line.startsWith("PartitionName=")) {
        const raw = parseStanza(line);
        const props = extractAllowed(raw, PARTITION_PROPS);
        const partName = String(props.PartitionName ?? raw.PartitionName ?? "partition");
        entities.push({ kind: "partition", name: partName, props });
        continue;
      }

      // Global key=value (goes into Cluster)
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        const key = line.substring(0, eqIdx).trim();
        const value = line.substring(eqIdx + 1).trim();
        globalProps[key] = value;
      }
    }

    // Build the Cluster entity from accumulated global props
    if (Object.keys(globalProps).length > 0) {
      const clusterProps = extractAllowed(globalProps, CLUSTER_PROPS);
      const clusterName = String(clusterProps.ClusterName ?? "cluster");

      // Extract Licenses= separately — they become License entities
      const licensesStr = globalProps["Licenses"];
      if (licensesStr) {
        delete clusterProps["Licenses"];
        for (const entry of licensesStr.split(",")) {
          const [licName, countStr] = entry.split(":");
          if (licName && countStr) {
            entities.push({
              kind: "license",
              name: licName.trim(),
              props: {
                LicenseName: licName.trim(),
                Count: parseInt(countStr.trim(), 10),
              },
            });
          }
        }
        if (Object.keys(clusterProps).length === 0 && licensesStr) {
          // No other cluster props — only licenses
        }
      }

      if (Object.keys(clusterProps).length > 0) {
        entities.push({ kind: "cluster", name: clusterName, props: clusterProps });
      }
    }

    return { entities, warnings };
  }
}
