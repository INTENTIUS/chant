/**
 * K8s environment→cluster binding — chant #1100.
 *
 * Every cloud lexicon binds an environment to a scope: AWS resolves `<env>`
 * to a CloudFormation stack, Azure treats `<env>` as the resource group,
 * Temporal looks up `temporal.profiles.<env>` in `chant.config.ts`. K8s (and
 * GCP-via-Config-Connector, which observes through the same kubectl path)
 * bound nothing — `describeResources` shelled out to `kubectl get` with no
 * `--context`, so it read whatever cluster `kubectl config current-context`
 * happened to point at. Point `prod` at a dev cluster and every declared
 * resource reads as missing — a wrong-cluster diff that looks like a
 * confident list of deletions.
 *
 * This module is the shared resolver both the k8s and gcp lexicons'
 * `describeResources` call, so they resolve a cluster identity the same way
 * (see `lexicons/k8s/src/config.ts`'s `K8sChantConfig` for the declared
 * shape). It is intentionally provider-agnostic and lives in core (like
 * `./ownership.ts`) rather than in the k8s lexicon package, since gcp's
 * Config Connector observation needs it too without taking a dependency on
 * the k8s lexicon.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** A single environment's cluster binding — see `K8sChantConfig` in the k8s lexicon. */
export interface K8sClusterProfile {
  /** kubectl context name this environment is bound to. */
  context: string;
}

/** Shape of the `k8s` passthrough key in `chant.config.ts` that this resolver reads. */
export interface K8sConfigShape {
  profiles?: Record<string, K8sClusterProfile>;
}

/**
 * Thrown when an environment declares a cluster binding but the ambient
 * kubectl context disagrees with it. Refusing here — instead of silently
 * observing whichever cluster is ambient — is the fix for #1100: a
 * wrong-cluster read reports every declared resource as missing, which #1089
 * then classifies as a confident (and wrong) list of `create` actions.
 */
export class ClusterBindingMismatchError extends Error {
  constructor(
    public readonly environment: string,
    public readonly expectedContext: string,
    public readonly ambientContext: string,
  ) {
    super(
      `k8s: environment "${environment}" is bound to cluster context "${expectedContext}" ` +
        `(k8s.profiles.${environment}.context), but the ambient kubectl context is ` +
        `"${ambientContext}". Refusing to observe — reading the wrong cluster would misreport ` +
        `every declared resource as missing. Run \`kubectl config use-context ${expectedContext}\` ` +
        `to switch, or update the binding in chant.config.ts if "${ambientContext}" is actually correct.`,
    );
    this.name = "ClusterBindingMismatchError";
  }
}

export interface ResolvedClusterTarget {
  /**
   * Explicit `--context` value to pass to every kubectl invocation. Present
   * only when the environment has a declared binding — undefined means
   * "no binding, keep today's ambient-context behavior".
   */
  context?: string;
  /** Where the target came from. */
  source: "bound" | "ambient";
}

/** Reads `kubectl config current-context`. Returns undefined if unset or kubectl fails. */
async function currentAmbientContext(): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync("kubectl config current-context");
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the kubectl context an environment should be observed/applied
 * against, reading `k8s.profiles.<environment>.context` from `chant.config.ts`
 * (the `config` passed in is the passthrough `ChantConfig`, cast loosely since
 * the `k8s` key isn't declared on the core schema — same pattern as
 * `temporal.profiles`).
 *
 * - No binding declared: returns `{ source: "ambient" }` — unchanged
 *   behavior — but logs a visible warning identifying the caller and
 *   environment, so the fallback is never silent (#1100 acceptance).
 * - Binding declared and the ambient context agrees (or ambient can't be
 *   determined): returns `{ context: bound, source: "bound" }`. Callers
 *   should pass this context explicitly on every kubectl invocation rather
 *   than relying on it also being ambient.
 * - Binding declared and the ambient context disagrees: throws
 *   {@link ClusterBindingMismatchError} — a loud refusal instead of quietly
 *   reading the wrong cluster.
 */
export async function resolveClusterTarget(
  config: Record<string, unknown>,
  environment: string,
  lexiconName: string,
): Promise<ResolvedClusterTarget> {
  const k8sConfig = config.k8s as K8sConfigShape | undefined;
  const bound = k8sConfig?.profiles?.[environment]?.context;

  if (!bound) {
    console.warn(
      `[${lexiconName}] no cluster binding for environment "${environment}" ` +
        `(k8s.profiles.${environment}.context in chant.config.ts) — observing whatever kubectl ` +
        `context is ambient. Add a binding to pin this environment to a specific cluster (chant #1100).`,
    );
    return { source: "ambient" };
  }

  const ambient = await currentAmbientContext();
  if (ambient && ambient !== bound) {
    throw new ClusterBindingMismatchError(environment, bound, ambient);
  }

  return { context: bound, source: "bound" };
}
