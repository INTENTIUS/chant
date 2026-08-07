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
  /**
   * Merge the new cluster into the caller's default kubeconfig
   * (`--kubeconfig-update-default=<bool>`). Chant's default is `false` —
   * deliberately the opposite of upstream k3d's `true`: a tool that reconciles
   * infrastructure must not repoint the caller's shell. The context-hijack
   * false-failure during #1394's scoping is the receipt. When the default
   * kubeconfig is left alone, {@link k3dUp} writes a dedicated kubeconfig and
   * returns its path so later steps can still reach the cluster.
   *
   * With a `configFile` and this arg unset, no flag is passed at all — the
   * declared config's own `options.kubeconfig` governs (k3d gives CLI flags
   * precedence over config, so a declared `true` keeps working).
   */
  updateDefaultKubeconfig?: boolean;
  /**
   * Switch the caller's current kubectl context to the new cluster
   * (`--kubeconfig-switch-context=<bool>`). Chant's default is `false` — see
   * {@link K3dUpArgs.updateDefaultKubeconfig} for why chant inverts upstream's
   * default. Same `configFile` rule: unset alongside a `configFile`, no flag
   * is passed and the config governs.
   */
  switchCurrentContext?: boolean;
}

export interface K3dDownArgs {
  /** Cluster name to delete. */
  name: string;
}

/** What {@link k3dUp} resolved for talking to the cluster. */
export interface K3dUpResult {
  /** kubectl context name for the cluster — always `k3d-<name>`. */
  context: string;
  /**
   * Path of the dedicated kubeconfig (`k3d kubeconfig write <name>`), present
   * whenever the caller did not explicitly merge into the default kubeconfig —
   * without it the context exists nowhere a later `kubectl` step could find it.
   */
  kubeconfigPath?: string;
}

/** `k3d cluster list <name> --no-headers` — non-empty stdout means the cluster exists. */
export function k3dExistsCommand(name: string): string {
  return `k3d cluster list ${name} --no-headers`;
}

/** kubectl context name k3d assigns a cluster: `k3d-<name>`. */
export function k3dContextName(name: string): string {
  return `k3d-${name}`;
}

/** `k3d kubeconfig write <name>` — prints the path of the written kubeconfig. */
export function k3dKubeconfigWriteCommand(name: string): string {
  return `k3d kubeconfig write ${name}`;
}

/**
 * Build the `k3d cluster create` command.
 *
 * Kubeconfig behavior: upstream k3d merges the new cluster into the default
 * kubeconfig and switches the current context. Chant defaults both to `false`
 * (see {@link K3dUpArgs.updateDefaultKubeconfig}) — but only forces its
 * defaults when no `configFile` is given. Each kubeconfig flag is emitted when
 * the caller set it explicitly, or when there is no `configFile`; with a
 * `configFile` and the arg unset, the flag is omitted so the declared config's
 * `options.kubeconfig` governs.
 */
export function k3dUpCommand(args: K3dUpArgs): string {
  const parts = ["k3d", "cluster", "create", args.name];
  if (args.servers !== undefined) parts.push(`--servers ${args.servers}`);
  if (args.agents !== undefined) parts.push(`--agents ${args.agents}`);
  if (args.image) parts.push(`--image ${args.image}`);
  for (const p of args.ports ?? []) parts.push(`-p "${p}"`);
  if (args.registryCreate) parts.push(`--registry-create ${args.registryCreate}`);
  if (args.configFile) parts.push(`--config ${args.configFile}`);
  if (!args.configFile || args.updateDefaultKubeconfig !== undefined) {
    parts.push(`--kubeconfig-update-default=${args.updateDefaultKubeconfig ?? false}`);
  }
  if (!args.configFile || args.switchCurrentContext !== undefined) {
    parts.push(`--kubeconfig-switch-context=${args.switchCurrentContext ?? false}`);
  }
  parts.push("--wait");
  parts.push(`--timeout ${args.timeout ?? "120s"}`);
  return parts.join(" ");
}

/** Build the `k3d cluster delete` command. */
export function k3dDownCommand(args: K3dDownArgs): string {
  return `k3d cluster delete ${args.name}`;
}

/**
 * Resolve and report how to reach the cluster. Only an explicit
 * `updateDefaultKubeconfig: true` proves the context landed in the default
 * kubeconfig; in every other case (chant's `false` default, or an opaque
 * `configFile` whose `options.kubeconfig` we cannot see) a dedicated
 * kubeconfig is written so the returned path always works.
 */
async function resolveConnection(args: K3dUpArgs, signal?: AbortSignal): Promise<K3dUpResult> {
  const context = k3dContextName(args.name);
  if (args.updateDefaultKubeconfig === true) {
    console.log(
      `k3d cluster "${args.name}" ready — context "${context}" (merged into the default kubeconfig)`,
    );
    return { context };
  }
  const { stdout } = await execAsync(k3dKubeconfigWriteCommand(args.name), { signal });
  const kubeconfigPath = stdout.trim();
  console.log(
    `k3d cluster "${args.name}" ready — context "${context}", kubeconfig: ${kubeconfigPath}`,
  );
  return { context, kubeconfigPath };
}

/**
 * Create a local k3d cluster (vanilla Kubernetes in Docker). Idempotent: if a
 * cluster of the same name already exists it is left as-is. Uses longInfra
 * profile — 20m timeout, heartbeat every 15s (creation may pull the k3s image).
 *
 * Unlike the upstream CLI, this does NOT touch the caller's default kubeconfig
 * or current context unless asked (see {@link K3dUpArgs.updateDefaultKubeconfig}).
 * It returns the context name and, when the default kubeconfig was left alone,
 * the path of a dedicated kubeconfig — pass those to the steps that apply
 * manifests afterwards.
 */
export async function k3dUp(args: K3dUpArgs, signal?: AbortSignal): Promise<K3dUpResult> {
  try {
    const { stdout } = await execAsync(k3dExistsCommand(args.name), { signal });
    if (stdout.trim()) {
      console.log(`k3d cluster "${args.name}" already exists — skipping create`);
      return await resolveConnection(args, signal);
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

  return resolveConnection(args, signal);
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
