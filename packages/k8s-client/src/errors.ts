/**
 * Typed failures — chant #1074.
 *
 * The kubectl path this client replaces reported failures as a non-zero exit
 * plus a line of English on stderr, which every caller then had to pattern
 * match (`classifyKubectlFailure` in core is that pattern matcher). The API
 * server already sends a machine-readable `Status` object with a numeric code
 * and a `reason` enum; these errors carry it through instead of re-deriving it
 * from prose.
 */

/** The `Status` object a Kubernetes API server returns on a failed request. */
export interface K8sStatus {
  kind?: string;
  apiVersion?: string;
  status?: string;
  message?: string;
  /** e.g. "NotFound", "Forbidden", "Unauthorized", "Conflict", "AlreadyExists". */
  reason?: string;
  code?: number;
  details?: unknown;
}

/**
 * The API server answered, and the answer was a failure. `statusCode` and
 * `reason` come from the response, not from parsing text.
 */
export class K8sApiError extends Error {
  /**
   * Which cluster the failing read actually talked to, e.g.
   * `context "k3d-fountain-local" (bound by k8s.profiles.local.context)`.
   * Stamped by the client that issued the request (chant #1488) — a
   * `read-failed` that does not name the cluster it read cost an afternoon on
   * a laptop with two k3d clusters, so the failure carries it from birth.
   */
  contextNote?: string;

  constructor(
    public readonly statusCode: number,
    public readonly reason: string | undefined,
    public readonly apiMessage: string,
    /** What was being addressed, e.g. `apps/v1 Deployment prod/web`. */
    public readonly target?: string,
    public readonly status?: K8sStatus,
  ) {
    super(
      `${target ? `${target}: ` : ""}${apiMessage || "request failed"} ` +
        `(HTTP ${statusCode}${reason ? `, ${reason}` : ""})`,
    );
    this.name = "K8sApiError";
  }

  /** The object is not there. The only failure that establishes absence. */
  get notFound(): boolean {
    return this.statusCode === 404 || this.reason === "NotFound";
  }

  /** RBAC denied the read. Proves nothing about whether the object exists. */
  get forbidden(): boolean {
    return this.statusCode === 403 || this.reason === "Forbidden";
  }

  /** No usable credentials for this cluster. */
  get unauthorized(): boolean {
    return this.statusCode === 401 || this.reason === "Unauthorized";
  }

  /**
   * Server-side-apply field-ownership conflict. `./conflict.ts`'s
   * {@link import("./conflict").FieldManagerConflictError} is the presented
   * form (chant #1075); this predicate still answers for both.
   */
  get conflict(): boolean {
    return this.statusCode === 409 || this.reason === "Conflict";
  }

  /**
   * Build from a raw response body, which is a `Status` on every well-behaved
   * Kubernetes error and occasionally plain text from a proxy in front of one.
   */
  static fromResponse(statusCode: number, body: string, target?: string): K8sApiError {
    let status: K8sStatus | undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && (parsed as K8sStatus).kind === "Status") {
        status = parsed as K8sStatus;
      }
    } catch {
      /* not JSON — a proxy or ingress error page */
    }
    const message = status?.message ?? firstLine(body) ?? "";
    return new K8sApiError(statusCode, status?.reason, message, target, status);
  }
}

/**
 * The request never reached an API server — DNS, TCP, TLS, proxy, or an
 * aborted signal. Distinct from {@link K8sApiError} because "I could not
 * connect" and "the server said no" are different observations.
 */
export class K8sTransportError extends Error {
  /** Which cluster context the failed request was aimed at — see {@link K8sApiError.contextNote}. */
  contextNote?: string;

  constructor(
    message: string,
    public readonly target?: string,
    options?: { cause?: unknown },
  ) {
    super(target ? `${target}: ${message}` : message);
    this.name = "K8sTransportError";
    if (options && "cause" in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * `@kubernetes/client-node` is not installed. It is an ordinary dependency of
 * this package, so this only happens when the package tree was pruned
 * (`npm install --omit=optional`, a slimmed container image). Named separately
 * so the k8s lexicon can tell a missing dependency from a broken cluster.
 */
export class K8sClientUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "the Kubernetes API client is unavailable — @kubernetes/client-node could not be loaded. " +
        "Install it with `npm i @intentius/chant-k8s-client` (it is an optional dependency of " +
        "@intentius/chant-lexicon-k8s, so `--omit=optional` installs skip it).",
    );
    this.name = "K8sClientUnavailableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * The kubeconfig names an exec credential plugin that is not on the allowlist.
 *
 * An exec plugin is an arbitrary binary named in a file chant did not write,
 * run with the CLI's privileges. EKS/AKS/GKE all need one, so refusing them
 * outright would make this client useless on managed clusters — but executing
 * whatever the file names is not a default worth having either.
 */
export class ExecCredentialNotAllowedError extends Error {
  constructor(
    public readonly command: string,
    public readonly allowed: readonly string[],
  ) {
    super(
      `k8s: the kubeconfig for this context authenticates with the exec credential plugin ` +
        `"${command}", which is not on chant's allowlist (${allowed.join(", ")}). ` +
        `An exec plugin is an arbitrary binary named in a file chant did not write. ` +
        `If "${command}" is expected, add it to k8s.execCredentialPlugins in chant.config.ts.`,
    );
    this.name = "ExecCredentialNotAllowedError";
  }
}

/**
 * chant's own field-manager identity is unusable (chant #1075) — almost always
 * because `ownership.stack` is too long or carries whitespace. Raised where the
 * name is derived, before any request, so the config key can be named instead
 * of the failure arriving as a 400 from a cluster.
 */
export class FieldManagerError extends Error {
  constructor(message: string) {
    super(`k8s: ${message}`);
    this.name = "FieldManagerError";
  }
}

/** The kubeconfig could not be read, or names no usable cluster/context. */
export class KubeConfigError extends Error {
  constructor(message: string) {
    super(`k8s: ${message}`);
    this.name = "KubeConfigError";
  }
}

/**
 * The cluster's own discovery does not serve this kind. Distinct from a 404 on
 * an instance: no instance of an unserved kind can exist, which is a real
 * absence rather than an unread hole.
 */
export class UnknownResourceError extends Error {
  constructor(
    public readonly selectorText: string,
    message?: string,
  ) {
    super(message ?? `k8s: the cluster's API discovery reports no resource matching "${selectorText}"`);
    this.name = "UnknownResourceError";
  }
}

function firstLine(text: string, max = 300): string | undefined {
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim();
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}
