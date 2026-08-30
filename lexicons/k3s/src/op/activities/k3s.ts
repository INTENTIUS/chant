import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "@intentius/chant/op";
import { K3S_VERSION } from "../../spec/fetch";

const execAsync = promisify(exec);

/** `k3s server` runs the control plane; `k3s agent` joins one as a worker. */
export type K3sRole = "server" | "agent";

export interface K3sInstallArgs {
  /** Which k3s subcommand the installer configures (`k3s server` / `k3s agent`). */
  role: K3sRole;
  /**
   * Path to the chant-emitted `config.yaml` on the reachable host, passed as
   * `--config` to the installed binary. chant does not write this file itself
   * — a build/apply step upstream of this activity is responsible for getting
   * it onto the host (host provisioning is out of scope, chant#1598).
   */
  configFile: string;
  /**
   * Installer version pin (`INSTALL_K3S_VERSION`). Default: the lexicon's
   * {@link K3S_VERSION} pin — bump that constant, not this arg, to track a
   * new upstream release across the whole lexicon.
   */
  version?: string;
  /**
   * Path to a file on the host holding the cluster join token, passed to the
   * installer as `K3S_TOKEN_FILE`. This is the only token-shaped input this
   * activity accepts — see the "token boundary" note below.
   */
  tokenFile?: string;
}

export interface K3sUninstallArgs {
  /** Which uninstall script to run — k3s ships a separate one per role. */
  role: K3sRole;
}

/** What {@link k3sInstall} resolved. */
export interface K3sInstallResult {
  /** The k3s version now installed (the target version, whether freshly installed or already present). */
  version: string;
  /** `false` when an already-installed matching version made the install a no-op. */
  installed: boolean;
}

/**
 * `k3s --version` output, first line: `k3s version v1.36.3+k3s1 (hash)`.
 * Returns `undefined` when k3s is not installed or the output doesn't match.
 */
export function parseK3sVersion(stdout: string): string | undefined {
  return stdout.match(/k3s version (\S+)/)?.[1];
}

/** Check-install-version command — errors (non-zero exit) when k3s is absent. */
export function k3sVersionCommand(): string {
  return "k3s --version";
}

/**
 * Build the get.k3s.io installer command. The version pin and the join-token
 * reference (if any) travel as environment variables via {@link k3sInstallEnv},
 * not interpolated into this string — see the token-boundary note on
 * {@link k3sInstall}.
 */
export function k3sInstallCommand(args: K3sInstallArgs): string {
  return `curl -sfL https://get.k3s.io | sh -s - ${args.role} --config ${args.configFile}`;
}

/**
 * Environment for {@link k3sInstallCommand}: `INSTALL_K3S_VERSION` (the pin)
 * and, only when a `tokenFile` path is given, `K3S_TOKEN_FILE`.
 *
 * ## The token boundary (#1601)
 *
 * This is the only token-shaped input the install activity accepts, and it
 * is a path, not a secret — the join token itself never passes through
 * activity args, never gets logged, and never lands in an emitted
 * config.yaml (K3S001 rejects a literal `token`/`agent-token` at lint). A
 * `K3S_TOKEN` (the literal, env-var form k3s itself supports for agents) is
 * deliberately not modeled here: the reference form the lexicon carries
 * end-to-end is a file path, matching `token-file`/`agent-token-file` on the
 * declared config surface (chant#1365's provenance stance applied at this
 * surface, not a new mechanism).
 */
export function k3sInstallEnv(args: K3sInstallArgs): Record<string, string> {
  const env: Record<string, string> = { INSTALL_K3S_VERSION: args.version ?? K3S_VERSION };
  if (args.tokenFile) env.K3S_TOKEN_FILE = args.tokenFile;
  return env;
}

/** Path k3s installs its uninstall script at — one per role. */
export function k3sUninstallScript(role: K3sRole): string {
  return role === "agent" ? "/usr/local/bin/k3s-agent-uninstall.sh" : "/usr/local/bin/k3s-uninstall.sh";
}

/**
 * Build the uninstall command. Gated the way `k3dDown` is (chant#1410): no
 * pre-check activity, no SSH orchestration — just the native idempotent
 * behavior. Unlike `k3d cluster delete` (idempotent on its own), the k3s
 * uninstall script does not exist at all on a host where k3s was never
 * installed, so the command guards on the script's presence itself rather
 * than assume it errors safely.
 */
export function k3sUninstallCommand(args: K3sUninstallArgs): string {
  const script = k3sUninstallScript(args.role);
  return `test -x ${script} && ${script} || echo "k3s ${args.role} already uninstalled"`;
}

/**
 * Run the pinned k3s installer against a reachable host. Idempotent on an
 * already-installed matching version: if `k3s --version` already reports the
 * target version, the install is skipped. Uses longInfra profile — 20m
 * timeout, heartbeat every 15s (the installer downloads and starts the
 * k3s binary).
 *
 * Bounded exactly as `k3dUp`/`k3dDown` were (chant#1410, epic #1598): this
 * drives the case where the host is reachable from where the Op runs. It
 * does not provision the host, and it is not an SSH orchestrator.
 */
export async function k3sInstall(
  args: K3sInstallArgs,
  signal?: AbortSignal,
): Promise<K3sInstallResult> {
  const target = args.version ?? K3S_VERSION;

  try {
    const { stdout } = await execAsync(k3sVersionCommand(), { signal });
    const installed = parseK3sVersion(stdout);
    if (installed === target) {
      console.log(`k3s ${target} already installed (${args.role}) — skipping install`);
      return { version: target, installed: false };
    }
    if (installed) {
      console.log(`k3s ${installed} installed, target is ${target} — reinstalling`);
    }
  } catch {
    // `k3s --version` errors when k3s is absent — fall through to install.
  }

  const heartbeatInterval = setInterval(() => {
    safeHeartbeat({ step: "k3s install", role: args.role, version: target });
  }, 15_000);

  try {
    const { stdout, stderr } = await execAsync(k3sInstallCommand(args), {
      signal,
      env: { ...process.env, ...k3sInstallEnv(args) },
    });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } finally {
    clearInterval(heartbeatInterval);
  }

  return { version: target, installed: true };
}

/**
 * Uninstall k3s from a reachable host. Uses fastIdempotent profile — 5m
 * timeout. A host where k3s was never installed (no uninstall script present)
 * is a no-op success, the same idempotent shape as `k3dDown` against an
 * already-gone cluster.
 */
export async function k3sUninstall(args: K3sUninstallArgs, signal?: AbortSignal): Promise<void> {
  const { stdout, stderr } = await execAsync(k3sUninstallCommand(args), { signal });
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}
