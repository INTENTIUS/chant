/**
 * What a collector pod needs from its node, worked out from the collector
 * config it runs, the way `agentClusterRules` works out its RBAC (chant
 * #3103). `OtelCollector` and `GkeOtelCollector` add the result to their
 * DaemonSet, and WK8605 reports a workload that runs such a config without it.
 *
 * Only components a pipeline runs count, since the collector starts no
 * other. A config that reads nothing from the node gets nothing, so its
 * DaemonSet is unchanged. Each requirement cites the component's README at
 * collector-contrib v0.130.0, the version the otel lexicon pins:
 *
 * - The node's name, from the downward API (`spec.nodeName`), in each
 *   variable a `k8sattributes` processor names in `filter.node_from_env_var`
 *   (processor/k8sattributesprocessor README, "Deployment scenarios": "Use
 *   the downward API to inject the node name as an environment variable"),
 *   and in each `${env:VAR}` a `kubeletstats` receiver's `node` uses, or its
 *   `endpoint` uses when the variable's name ends in `NODE_NAME`
 *   (receiver/kubeletstatsreceiver README, "Service Account Authentication
 *   Example"). An `endpoint` variable ending in `NODE_IP` or `HOST_IP` gets
 *   `status.hostIP` instead. Any other variable is the caller's to set.
 * - The host root, read-only at a `hostmetrics` receiver's `root_path`
 *   (receiver/hostmetricsreceiver README, "Collecting host metrics from
 *   inside a container (Linux only)": bind mount the host filesystem, then
 *   configure `root_path`). Mounted with `HostToContainer` propagation so
 *   filesystems the node mounts later show up, as the upstream Helm chart's
 *   hostMetrics preset does.
 * - The directories a `filelog` receiver's `include` patterns read, read-only
 *   at the same path (receiver/filelogreceiver README, "Configuration":
 *   `include` is a list of file glob patterns the receiver reads). The mount
 *   is the fixed directory part of each pattern, so `/var/log/pods/*\/*\/*.log`
 *   mounts `/var/log/pods`. `/var/log/containers` holds symlinks into
 *   `/var/log/pods`, so reading it mounts both. A pattern with no fixed
 *   directory below `/`, or one that would cover the config directory, is
 *   left to the caller.
 *
 * `readsLogs` is set when a `filelog` receiver reads a host directory: the
 * kubelet's container logs there are owned by root, which the composites
 * deal with (see `logAccess` on `OtelCollector`).
 */

import { canonicalTypeOf } from "@intentius/chant-lexicon-otel/model";

/** A variable set from the downward API. A type alias, so it fits where container fields are a plain record. */
export type NodeEnvVar = {
  name: string;
  valueFrom: { fieldRef: { fieldPath: "spec.nodeName" | "status.hostIP" } };
};

/** A host directory the collector reads, mounted read-only. */
export interface NodeHostMount {
  /** Volume name, a DNS label. */
  name: string;
  /** Path on the node. */
  hostPath: string;
  /** Path in the container. */
  mountPath: string;
  /** Which component needs it, for messages. */
  component: string;
  /** `hostmetrics` takes any host mount at or under `mountPath` (the README allows mounting only parts of the root). */
  partial?: boolean;
  mountPropagation?: "HostToContainer";
}

export interface CollectorNodeAccess {
  env: NodeEnvVar[];
  mounts: NodeHostMount[];
  /** A `filelog` receiver reads a host directory, whose files are root-owned. */
  readsLogs: boolean;
}

/** The part of a collector config this reads; both the built config and a parsed ConfigMap value fit. */
export interface NodeReadingConfig {
  receivers?: Record<string, unknown>;
  processors?: Record<string, unknown>;
  service?: { pipelines?: Record<string, unknown> } | unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Component ids of one kind that some pipeline runs. */
function runningIds(config: NodeReadingConfig, kind: "receivers" | "processors"): Set<string> {
  const ids = new Set<string>();
  const pipelines = isRecord(config.service) && isRecord(config.service.pipelines) ? config.service.pipelines : {};
  for (const p of Object.values(pipelines)) {
    const list = isRecord(p) ? p[kind] : undefined;
    if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** [id, settings] of each running component of `type`, under its old or new name (`kubelet_stats`). */
function running(config: NodeReadingConfig, kind: "receivers" | "processors", type: string): Array<[string, Record<string, unknown>]> {
  const ids = runningIds(config, kind);
  const section = isRecord(config[kind]) ? (config[kind] as Record<string, unknown>) : {};
  const componentKind = kind === "receivers" ? "receiver" : "processor";
  return Object.entries(section)
    .filter(([id]) => ids.has(id) && canonicalTypeOf(componentKind, id) === type)
    .map(([id, cfg]) => [id, isRecord(cfg) ? cfg : {}]);
}

/** The variables a string reads as `${env:NAME}`. */
function envRefs(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

/** The directory part of a glob before its first wildcard: `/var/log/pods/*\/x.log` is `/var/log/pods`. */
export function fixedDirectory(pattern: string): string | undefined {
  if (!pattern.startsWith("/")) return undefined;
  const parts = pattern.split("/");
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[{]/.test(part)) break;
    fixed.push(part);
  }
  // No wildcard at all: a file, so its directory.
  if (fixed.length === parts.length) fixed.pop();
  const dir = fixed.join("/").replace(/\/+$/, "");
  return dir === "" ? undefined : dir;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function volumeName(prefix: string, path: string): string {
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix}-${slug}`.slice(0, 63).replace(/-+$/, "");
}

/**
 * What a collector config needs from the node. `configDir` is where the
 * collector's own config is mounted; a log directory covering it is skipped.
 */
export function collectorNodeAccess(config: NodeReadingConfig, configDir = "/etc/otel"): CollectorNodeAccess {
  const env = new Map<string, NodeEnvVar["valueFrom"]["fieldRef"]["fieldPath"]>();
  const setEnv = (name: string, fieldPath: NodeEnvVar["valueFrom"]["fieldRef"]["fieldPath"]) => {
    if (!env.has(name)) env.set(name, fieldPath);
  };

  for (const [, p] of running(config, "processors", "k8sattributes")) {
    const name = isRecord(p.filter) ? p.filter.node_from_env_var : undefined;
    if (typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) setEnv(name, "spec.nodeName");
  }
  for (const [, r] of running(config, "receivers", "kubeletstats")) {
    for (const name of envRefs(r.node)) setEnv(name, "spec.nodeName");
    for (const name of envRefs(r.endpoint)) {
      if (/(NODE|HOST)_IP$/.test(name)) setEnv(name, "status.hostIP");
      else if (/NODE_NAME$/.test(name)) setEnv(name, "spec.nodeName");
    }
  }

  const mounts: NodeHostMount[] = [];
  const rootPaths = new Set<string>();
  for (const [id, r] of running(config, "receivers", "hostmetrics")) {
    const root = typeof r.root_path === "string" ? r.root_path.replace(/\/+$/, "") : "";
    if (!root.startsWith("/") || rootPaths.has(root)) continue;
    rootPaths.add(root);
    mounts.push({
      name: rootPaths.size === 1 ? "hostfs" : volumeName("hostfs", root),
      hostPath: "/",
      mountPath: root,
      component: id,
      partial: true,
      mountPropagation: "HostToContainer",
    });
  }

  const logDirs: Array<{ dir: string; component: string }> = [];
  for (const [id, r] of running(config, "receivers", "filelog")) {
    const include = Array.isArray(r.include) ? r.include : [];
    for (const pattern of include) {
      if (typeof pattern !== "string") continue;
      const dir = fixedDirectory(pattern);
      if (!dir || within(configDir, dir)) continue;
      logDirs.push({ dir, component: id });
      if (within(dir, "/var/log/containers")) logDirs.push({ dir: "/var/log/pods", component: id });
    }
  }
  // One mount per directory, the outermost of nested ones.
  const kept = logDirs.filter(({ dir }, i) =>
    !logDirs.some((o, j) => (o.dir !== dir && within(dir, o.dir)) || (o.dir === dir && j < i)),
  );
  for (const { dir, component } of kept) {
    if ([...rootPaths].some((root) => within(dir, root))) continue;
    mounts.push({ name: volumeName("host", dir), hostPath: dir, mountPath: dir, component });
  }

  return {
    env: [...env].map(([name, fieldPath]) => ({ name, valueFrom: { fieldRef: { fieldPath } } })),
    mounts,
    readsLogs: kept.length > 0,
  };
}

/** The pod volumes for a set of mounts. */
export function nodeVolumes(mounts: NodeHostMount[]): Array<Record<string, unknown>> {
  return mounts.map((m) => ({ name: m.name, hostPath: { path: m.hostPath } }));
}

/** The container volume mounts for a set of mounts, all read-only. */
export function nodeVolumeMounts(mounts: NodeHostMount[]): Array<Record<string, unknown>> {
  return mounts.map((m) => ({
    name: m.name,
    mountPath: m.mountPath,
    readOnly: true,
    ...(m.mountPropagation ? { mountPropagation: m.mountPropagation } : {}),
  }));
}
