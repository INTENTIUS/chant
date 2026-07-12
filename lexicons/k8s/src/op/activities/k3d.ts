import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "@intentius/chant/op";

const execAsync = promisify(exec);

export interface K3dUpArgs {
  /** Cluster name (`k3d cluster create <name>`). */
  name: string;
  /** Number of server (control-plane) nodes. */
  servers?: number;
  /** Number of agent (worker) nodes. */
  agents?: number;
  /** k3s image, e.g. `rancher/k3s:v1.31.4-k3s1`. */
  image?: string;
  /** Port mappings, e.g. `["8080:80@loadbalancer"]`. */
  ports?: string[];
  /** Create a managed local registry with this name (`--registry-create`). */
  registryCreate?: string;
  /** Path to a k3d config file (`--config`). */
  configFile?: string;
  /** Readiness timeout for `--wait`. Default: `120s`. */
  timeout?: string;
}

export interface K3dDownArgs {
  /** Cluster name to delete. */
  name: string;
}

/** `k3d cluster list <name> --no-headers` — non-empty stdout means the cluster exists. */
export function k3dExistsCommand(name: string): string {
  return `k3d cluster list ${name} --no-headers`;
}

/**
 * Build the `k3d cluster create` command. k3d merges the new cluster into the
 * default kubeconfig and switches context by default, so no extra flags are
 * needed for the manifests to be `kubectl apply`-able afterward.
 */
export function k3dUpCommand(args: K3dUpArgs): string {
  const parts = ["k3d", "cluster", "create", args.name];
  if (args.servers !== undefined) parts.push(`--servers ${args.servers}`);
  if (args.agents !== undefined) parts.push(`--agents ${args.agents}`);
  if (args.image) parts.push(`--image ${args.image}`);
  for (const p of args.ports ?? []) parts.push(`-p "${p}"`);
  if (args.registryCreate) parts.push(`--registry-create ${args.registryCreate}`);
  if (args.configFile) parts.push(`--config ${args.configFile}`);
  parts.push("--wait");
  parts.push(`--timeout ${args.timeout ?? "120s"}`);
  return parts.join(" ");
}

/** Build the `k3d cluster delete` command. */
export function k3dDownCommand(args: K3dDownArgs): string {
  return `k3d cluster delete ${args.name}`;
}

/**
 * Create a local k3d cluster (vanilla Kubernetes in Docker). Idempotent: if a
 * cluster of the same name already exists it is left as-is. Uses longInfra
 * profile — 20m timeout, heartbeat every 15s (creation may pull the k3s image).
 */
export async function k3dUp(args: K3dUpArgs, signal?: AbortSignal): Promise<void> {
  try {
    const { stdout } = await execAsync(k3dExistsCommand(args.name), { signal });
    if (stdout.trim()) {
      console.log(`k3d cluster "${args.name}" already exists — skipping create`);
      return;
    }
  } catch {
    // `cluster list` errors when the cluster is absent — fall through to create.
  }

  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "k3d cluster create", cluster: args.name });
  }, 15_000);

  try {
    const { stdout, stderr } = await execAsync(k3dUpCommand(args), { signal });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/**
 * Delete a local k3d cluster. Uses fastIdempotent profile — 5m timeout.
 * `k3d cluster delete` is a no-op success when the cluster is already gone.
 */
export async function k3dDown(args: K3dDownArgs, signal?: AbortSignal): Promise<void> {
  const { stdout, stderr } = await execAsync(k3dDownCommand(args), { signal });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
