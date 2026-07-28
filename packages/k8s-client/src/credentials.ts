/**
 * Credential policy — chant #1074's managed-cluster half.
 *
 * On EKS, AKS and GKE, kubeconfig authentication is an **exec credential
 * plugin**: `aws eks get-token`, `kubelogin`, `gke-gcloud-auth-plugin`. So on
 * the clusters most people actually run, a "native" client still spawns a
 * process — once per token instead of once per resource read. That is still
 * the win the issue is after, but it is worth stating rather than implying,
 * because an exec plugin runs an arbitrary binary named in a file chant did
 * not write.
 *
 * Three things are chant's to decide, and they live here:
 *
 * 1. **Allowlist.** The plugin's command must be on a list, not merely present
 *    in the kubeconfig. The default covers the three managed providers.
 * 2. **Caching.** `@kubernetes/client-node`'s `ExecAuth` caches a credential
 *    until its `expirationTimestamp`, keyed by kubeconfig user. The client
 *    builds one `KubeConfig` per session and reuses it for every request, so a
 *    200-entity observation invokes `aws eks get-token` once rather than 200
 *    times. That is a property of not rebuilding the config, so it is asserted
 *    in this package's tests rather than reimplemented here.
 * 3. **Provenance.** Which credential path authorized a read is recorded on
 *    the client and travels with the observation.
 */

import { ExecCredentialNotAllowedError } from "./errors";
import type { CredentialPath } from "./types";

/**
 * Exec credential plugins chant will execute without being asked twice.
 *
 * The three managed-Kubernetes providers plus `kubectl`, which is what
 * `kubectl config set-credentials --exec-command` writes for OIDC setups that
 * shell back through the binary the user already trusts. Anything else has to
 * be named explicitly in `k8s.execCredentialPlugins`.
 */
export const DEFAULT_EXEC_ALLOWLIST: readonly string[] = [
  "aws", // EKS — `aws eks get-token`
  "aws-iam-authenticator", // EKS, pre-`aws eks get-token`
  "gke-gcloud-auth-plugin", // GKE
  "kubelogin", // AKS
  "kubectl", // OIDC via `kubectl oidc-login`, and k3d/kind setups
];

/** The exec stanza of a kubeconfig user, as far as this module cares. */
export interface ExecConfig {
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

/** The kubeconfig user fields this module reads. */
export interface KubeConfigUser {
  name?: string;
  exec?: ExecConfig;
  authProvider?: { name?: string; config?: { exec?: ExecConfig } };
  token?: string;
  certData?: string;
  certFile?: string;
  username?: string;
  password?: string;
}

/**
 * The exec stanza this user authenticates with, if any. `authProvider` can
 * carry one too — client-node's `ExecAuth.isAuthProvider` accepts both shapes,
 * so the gate has to look in both places or it is trivially bypassed.
 */
export function execConfigOf(user: KubeConfigUser | null | undefined): ExecConfig | undefined {
  if (!user) return undefined;
  if (user.exec) return user.exec;
  const providerExec = user.authProvider?.config?.exec;
  if (providerExec) return providerExec;
  return undefined;
}

/**
 * Reduce a plugin command to the name that is allowlisted: `aws` for `aws`,
 * for `/usr/local/bin/aws`, and for `C:\\tools\\aws.exe`. Matching the bare
 * name rather than the full path is deliberate — the path varies per machine,
 * and pinning it would make the allowlist unusable — but it does mean the
 * allowlist expresses "which tool", not "which file".
 */
export function execCommandName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat)$/i, "");
}

/**
 * Throw unless the user's exec plugin (if it has one) is allowlisted. Called
 * before the client issues its first request, so a refusal happens before any
 * binary runs — the check is worthless if it fires after the spawn.
 */
export function assertExecCredentialAllowed(
  user: KubeConfigUser | null | undefined,
  allowlist: readonly string[] = DEFAULT_EXEC_ALLOWLIST,
): void {
  const exec = execConfigOf(user);
  if (!exec?.command) return;
  const name = execCommandName(exec.command);
  if (allowlist.some((entry) => execCommandName(entry) === name)) return;
  throw new ExecCredentialNotAllowedError(exec.command, allowlist);
}

/** Which credential path a kubeconfig user represents, for provenance. */
export function credentialPathOf(user: KubeConfigUser | null | undefined): {
  credential: CredentialPath;
  execCommand?: string;
} {
  const exec = execConfigOf(user);
  if (exec?.command) return { credential: "exec-plugin", execCommand: exec.command };
  if (user?.authProvider?.name) return { credential: "auth-provider" };
  if (user?.token) return { credential: "token" };
  if (user?.certData || user?.certFile) return { credential: "client-certificate" };
  if (user?.username) return { credential: "basic-auth" };
  return { credential: "none" };
}
