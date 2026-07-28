/**
 * Typed API failure → the observation tri-state (chant #1089, #1074).
 *
 * `classifyKubectlFailure` in core does this by matching English on stderr,
 * because that was all `kubectl` gave it. The API server has always sent a
 * `Status` object with a numeric code and a `reason` enum; the typed client
 * carries it through, so classification here reads fields rather than
 * searching for substrings. The verdicts are deliberately the same ones the
 * kubectl path produced — this replaces the evidence, not the contract.
 *
 * The one that reads as a surprise, and is not: **a kind the cluster does not
 * serve is an absence, not a hole.** No instance of an unserved kind can exist
 * there, and the usual cause is a CRD the very plan being computed has not
 * applied yet. Calling it NOT-OBSERVED would suppress the create that is
 * genuinely needed. That is core's existing rule (`classifyKubectlFailure`
 * treats "the server doesn't have a resource type" as absent) and it survives
 * the move intact.
 *
 * Errors are discriminated by `name`, not `instanceof`. The client is an
 * optional dependency reached through a dynamic import, so this module must
 * not carry a static value import of it — and `name` is set explicitly by
 * every one of its error classes, which also makes the classification survive
 * a duplicated copy of the package in a consumer's tree.
 */

import type { UnobservedReason } from "@intentius/chant/lexicon";

/** What a failed read actually proved. Mirrors core's `KubectlReadOutcome`. */
export type K8sReadOutcome =
  /** The API server answered and the object is not there. Safe to plan a create. */
  | { kind: "absent" }
  /** The read proved nothing about the object's existence. */
  | { kind: "unobserved"; reason: UnobservedReason; detail: string };

/** The client's error names, as its classes stamp them. */
const NAMES = {
  api: "K8sApiError",
  transport: "K8sTransportError",
  unavailable: "K8sClientUnavailableError",
  execRefused: "ExecCredentialNotAllowedError",
  kubeconfig: "KubeConfigError",
  unknownResource: "UnknownResourceError",
} as const;

interface ErrorLike {
  name?: string;
  message?: string;
  statusCode?: number;
  reason?: string;
}

function shapeOf(err: unknown): ErrorLike {
  return (typeof err === "object" && err !== null ? err : {}) as ErrorLike;
}

/** Classify a failure from the typed client into the observation tri-state. */
export function classifyApiFailure(err: unknown): K8sReadOutcome {
  const e = shapeOf(err);

  switch (e.name) {
    // The cluster's discovery does not serve this kind, so no instance of it
    // exists here. A real absence — see the module comment.
    case NAMES.unknownResource:
      return { kind: "absent" };

    case NAMES.api: {
      const code = e.statusCode;
      if (code === 404 || e.reason === "NotFound") return { kind: "absent" };
      if (code === 401 || code === 403 || e.reason === "Unauthorized" || e.reason === "Forbidden") {
        return { kind: "unobserved", reason: "no-credentials", detail: detailOf(err) };
      }
      return { kind: "unobserved", reason: "read-failed", detail: detailOf(err) };
    }

    // Never reached an API server: DNS, TCP, TLS, proxy, abort. Says nothing
    // about what is running there. Same verdict the kubectl path gave
    // "unable to connect to the server".
    case NAMES.transport:
      return { kind: "unobserved", reason: "no-binding", detail: detailOf(err) };

    // No usable kubeconfig / cluster / context for this environment.
    case NAMES.kubeconfig:
      return { kind: "unobserved", reason: "no-binding", detail: detailOf(err) };

    // The credential path itself was refused, so nothing was ever authorized.
    case NAMES.execRefused:
      return { kind: "unobserved", reason: "no-credentials", detail: detailOf(err) };

    // The client package is not installed — chant could not look, which is a
    // hole and emphatically not an empty cluster.
    case NAMES.unavailable:
      return { kind: "unobserved", reason: "read-failed", detail: detailOf(err) };

    default:
      return { kind: "unobserved", reason: "read-failed", detail: detailOf(err) };
  }
}

/**
 * Whether a failure kills the whole observation rather than one entity. A
 * refused binding, a missing client package and a rejected credential plugin
 * are all true of every entity, so they propagate and core marks the lot
 * NOT-OBSERVED with one reason instead of repeating the same failure N times.
 */
export function isWholeLexiconFailure(err: unknown): boolean {
  const name = shapeOf(err).name;
  return name === NAMES.kubeconfig || name === NAMES.execRefused || name === NAMES.unavailable;
}

/**
 * A dynamic import of the optional client package that failed to resolve looks
 * like an ordinary module error. Recognizing it lets `describeResources` report
 * a missing dependency as a missing dependency rather than as a broken cluster.
 */
export function isMissingClientPackage(err: unknown): boolean {
  const e = shapeOf(err) as ErrorLike & { code?: string };
  if (e.name === NAMES.unavailable) return true;
  if (e.code !== "ERR_MODULE_NOT_FOUND" && e.code !== "MODULE_NOT_FOUND") return false;
  return (e.message ?? "").includes("@intentius/chant-k8s-client") || (e.message ?? "").includes("@kubernetes/client-node");
}

/** The message a missing client package should produce. */
export const MISSING_CLIENT_DETAIL =
  "the Kubernetes API client is not installed — run `npm i @intentius/chant-k8s-client` " +
  "(it is an optional dependency of @intentius/chant-lexicon-k8s, so `--omit=optional` installs skip it)";

function detailOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? text.trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
