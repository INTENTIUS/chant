/**
 * k3s Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `k3s` lexicon. Lifecycle activities for the
 * reachable-host case (chant#1601, epic #1598):
 *   - k3sInstall — run the pinned installer (`INSTALL_K3S_VERSION`), idempotent
 *     on an already-installed matching version.
 *   - k3sUninstall — the uninstall script, gated the way k3dDown is.
 *
 * Bounded exactly as k3dUp/k3dDown were (chant#1410): no SSH orchestration,
 * no host provisioning. The join token never travels through these activities
 * as a value — only `tokenFile`, a path — see the token-boundary note on
 * {@link k3sInstall} in ./k3s.
 *
 * The step builders (k3sInstall, k3sUninstall) live in core, re-exported from
 * the temporal Op-authoring barrel like k3dUp/k3dDown. The activities here are
 * dependency-light — they shell out to the k3s installer/uninstall scripts and
 * only pull in the lexicon's version pin, not its declarable surface — so a
 * Temporal worker loads them cheaply.
 */
export {
  k3sInstall,
  k3sUninstall,
  k3sInstallCommand,
  k3sInstallEnv,
  k3sUninstallCommand,
  k3sUninstallScript,
  k3sVersionCommand,
  parseK3sVersion,
} from "./k3s";
export type { K3sRole, K3sInstallArgs, K3sUninstallArgs, K3sInstallResult } from "./k3s";
