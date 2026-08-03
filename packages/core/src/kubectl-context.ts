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
import type { UnobservedReason } from "./observation";

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

/**
 * How the resolver learns which context is ambient. The default shells
 * `kubectl config current-context`; the k8s lexicon's typed API client
 * (chant #1074) supplies one that reads the parsed kubeconfig instead, so a
 * client that never needs the `kubectl` binary does not acquire a dependency
 * on it just to check the binding. Both answer the same question, so the
 * refusal semantics below are identical either way.
 */
export type AmbientContextReader = () => Promise<string | undefined>;

/** Reads `kubectl config current-context`. Returns undefined if unset or kubectl fails. */
const currentAmbientContext: AmbientContextReader = async () => {
  try {
    const { stdout } = await execAsync("kubectl config current-context");
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

/** Options for {@link resolveClusterTarget}. */
export interface ResolveClusterTargetOptions {
  /**
   * Override how the ambient context is read. Defaults to
   * `kubectl config current-context`.
   */
  ambientContext?: AmbientContextReader;
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
  options: ResolveClusterTargetOptions = {},
): Promise<ResolvedClusterTarget> {
  // #1344 — the k8s lexicon declares this namespace and core validates it at
  // load, so the shape is checked rather than asserted. `K8sConfigShape` stays
  // as core's local description for the case where the lexicon is absent.
  const k8sConfig = (config as { k8s?: K8sConfigShape }).k8s;
  const bound = k8sConfig?.profiles?.[environment]?.context;

  if (!bound) {
    console.warn(
      `[${lexiconName}] no cluster binding for environment "${environment}" ` +
        `(k8s.profiles.${environment}.context in chant.config.ts) — observing whatever kubectl ` +
        `context is ambient. Add a binding to pin this environment to a specific cluster (chant #1100).`,
    );
    return { source: "ambient" };
  }

  const ambient = await (options.ambientContext ?? currentAmbientContext)();
  if (ambient && ambient !== bound) {
    throw new ClusterBindingMismatchError(environment, bound, ambient);
  }

  return { context: bound, source: "bound" };
}

// ── kubectl read outcomes (#1089) ───────────────────────────────────────────

/**
 * What a failed `kubectl get` actually proved. Shared by the k8s and gcp
 * lexicons, which read through the same kubectl path and used to collapse every
 * non-zero exit into "not there" — so an expired token, a downed API server, or
 * an uninstalled CRD all classified as `create`.
 */
export type KubectlReadOutcome =
  /** The API server answered and the object is not there. Safe to plan a create. */
  | { kind: "absent" }
  /** The read proved nothing about the object's existence. */
  | { kind: "unobserved"; reason: UnobservedReason; detail: string };

/** Pull whatever the child process actually said out of an exec rejection. */
function execErrorText(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (stderr) return stderr;
    if (typeof e.message === "string") return e.message.trim();
  }
  return String(err);
}

/** Collapse kubectl's noise to one line for a plan/diff entry. */
function firstLine(text: string, max = 200): string {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * Classify a `kubectl get` failure into the observation tri-state (#1089).
 *
 * Only a genuine `NotFound` from the API server — or a kind the server does not
 * serve at all, where no instance can exist — establishes absence. Auth,
 * connectivity, and unresolvable contexts establish nothing, and must reach the
 * change set as NOT-OBSERVED rather than as an empty result.
 */
export function classifyKubectlFailure(err: unknown): KubectlReadOutcome {
  const text = execErrorText(err);
  const lower = text.toLowerCase();

  // The object was looked for and is not there.
  if (lower.includes("notfound") || /error from server \(notfound\)/.test(lower) || lower.includes("not found")) {
    return { kind: "absent" };
  }
  // The cluster serves no such kind, so no instance of it can exist there. The
  // usual cause is a CRD this same plan has not applied yet — a real absence,
  // and the case a create is for.
  if (
    lower.includes("the server doesn't have a resource type") ||
    lower.includes("the server could not find the requested resource")
  ) {
    return { kind: "absent" };
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("you must be logged in") ||
    lower.includes("invalid bearer token") ||
    lower.includes("credentials")
  ) {
    return { kind: "unobserved", reason: "no-credentials", detail: firstLine(text) };
  }
  if (
    lower.includes("unable to connect to the server") ||
    lower.includes("connection refused") ||
    lower.includes("no configuration has been provided") ||
    lower.includes("did you specify the right host or port") ||
    lower.includes("context was not found") ||
    /context ".*" does not exist/.test(lower) ||
    lower.includes("no such host") ||
    lower.includes("i/o timeout")
  ) {
    return { kind: "unobserved", reason: "no-binding", detail: firstLine(text) };
  }
  return { kind: "unobserved", reason: "read-failed", detail: firstLine(text) };
}
