import { safeHeartbeat, sleep } from "@intentius/chant/op";
import { defaultK8sConnector, type K8sConnector } from "../../api/connect";

/**
 * waitForReady — block until any operator-backed Kubernetes resource reports
 * ready, driven by a data-only **readiness spec** rather than per-CRD code.
 *
 * Like `waitForArgoSync`, this activity is intentionally **dependency-light**:
 * its signature is primitives + a plain readiness spec, so a Temporal worker
 * loads it without importing the generated CRD declarable surface. It reads the
 * resource and evaluates the spec's predicates. It generalizes the bespoke
 * `waitForArgoSync` / `waitForStack` waits — see #365.
 *
 * chant #1074 moved the read from `kubectl get -o json` to the typed API
 * client, so a worker image needs no `kubectl` binary. The signature is
 * unchanged — `kind` is still whatever `kubectl get` accepts, because that is
 * what every existing caller passes, and the client resolves it through the
 * cluster's own API discovery exactly as kubectl does: plural, then singular,
 * then kind, then short name, with anything after the first dot read as the
 * API group.
 */

// ── Readiness spec (plain data — no generated-type imports) ──────────

/** Match a Kubernetes-style `status.conditions[]` entry by `type`. */
export interface ConditionMatch {
  conditionType: string;
  /** Required `status` of that condition (default "True"). */
  status?: string;
}

/** Match a value at a dot-path into the fetched object. */
export interface PathMatch {
  /** e.g. "status.health.status". */
  path: string;
  /** Holds when the value strictly equals this. */
  equals?: string | number | boolean;
  /** Holds when the value is one of these. */
  oneOf?: Array<string | number>;
  // With neither `equals` nor `oneOf`, holds when the value is present (non-null).
}

/**
 * Match a `status.conditions[]` entry by `type` AND its `reason` (#1549).
 * The dot-path walk can't index into a conditions array, and the Flux
 * toolkit's failure signal is exactly `conditions[type=Ready].reason` — a
 * wedge like `BuildFailed` keeps `Ready=False` forever while the generic
 * poll waits out its whole timeout. `status` defaults to "False": a reason
 * on a True condition is progress vocabulary, not a wedge.
 */
export interface ConditionReasonMatch {
  conditionType: string;
  /** Required `status` of the condition (default "False"). */
  status?: string;
  /** Holds when the condition's `reason` is one of these. */
  reasonOneOf: string[];
}

export type ReadinessMatch = ConditionMatch | PathMatch | ConditionReasonMatch;

export interface ReadinessSpec {
  /** All must hold for the resource to be ready. */
  ready: ReadinessMatch[];
  /** If any holds, fail fast — the resource will not become ready. */
  terminal?: ReadinessMatch[];
  /**
   * Also require `status.observedGeneration >= metadata.generation` when both
   * are present. Default true — most operators set `observedGeneration`.
   */
  observedGeneration?: boolean;
}

/**
 * The generic default (kstatus-style): a `Ready` condition of `True` and
 * `observedGeneration` caught up. Covers cert-manager, Gateway API, KubeRay,
 * and the CockroachDB operator.
 */
export const DEFAULT_READINESS: ReadinessSpec = {
  ready: [{ conditionType: "Ready", status: "True" }],
  observedGeneration: true,
};

/**
 * Per-resource overrides keyed by `"<group>/<kind>"`. Argo's `Application`
 * reports `health`/`sync`, not a `Ready` condition — the case that proves the
 * override is necessary (#365).
 */
/**
 * Flux toolkit wedge reasons (#1549): a `Ready=False` with one of these
 * `reason`s does not heal by waiting — a bad build, a failed install, an
 * unreachable or invalid source. The toolkit is kstatus-conformant, so the
 * READY half of every entry below is just the default; the value added is
 * failing fast instead of polling out the full timeout.
 */
const FLUX_TERMINAL = (reasons: string[]): ReadinessSpec => ({
  ready: [{ conditionType: "Ready", status: "True" }],
  terminal: [{ conditionType: "Ready", reasonOneOf: reasons }],
  observedGeneration: true,
});

export const READINESS_OVERRIDES: Record<string, ReadinessSpec> = {
  "argoproj.io/Application": {
    ready: [
      { path: "status.health.status", equals: "Healthy" },
      { path: "status.sync.status", equals: "Synced" },
    ],
    terminal: [{ path: "status.health.status", oneOf: ["Degraded", "Missing"] }],
    observedGeneration: false,
  },
  "kustomize.toolkit.fluxcd.io/Kustomization": FLUX_TERMINAL([
    "BuildFailed",
    "HealthCheckFailed",
    "ReconciliationFailed",
    "ArtifactFailed",
    "PruneFailed",
  ]),
  "helm.toolkit.fluxcd.io/HelmRelease": FLUX_TERMINAL([
    "InstallFailed",
    "UpgradeFailed",
    "RollbackFailed",
    "UninstallFailed",
    "ArtifactFailed",
    "ChartPullError",
  ]),
  "source.toolkit.fluxcd.io/GitRepository": FLUX_TERMINAL([
    "AuthenticationFailed",
    "GitOperationFailed",
    "URLInvalid",
    "StorageOperationFailed",
  ]),
  "source.toolkit.fluxcd.io/OCIRepository": FLUX_TERMINAL([
    "AuthenticationFailed",
    "OCIPullFailed",
    "URLInvalid",
    "StorageOperationFailed",
  ]),
  "source.toolkit.fluxcd.io/HelmChart": FLUX_TERMINAL([
    "ChartPullError",
    "ChartPackageError",
    "StorageOperationFailed",
  ]),
};

/** Resolve the readiness spec for a resource: registry override, else default. */
export function readinessFor(group: string | undefined, kind: string): ReadinessSpec {
  return READINESS_OVERRIDES[`${group ?? ""}/${kind}`] ?? DEFAULT_READINESS;
}

// ── Predicate evaluation ────────────────────────────────────────────

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

function isConditionReason(m: ReadinessMatch): m is ConditionReasonMatch {
  return (m as ConditionReasonMatch).reasonOneOf !== undefined;
}

function isCondition(m: ReadinessMatch): m is ConditionMatch {
  return (m as ConditionMatch).conditionType !== undefined && !isConditionReason(m);
}

function findCondition(obj: unknown, conditionType: string): Record<string, unknown> | undefined {
  const conds = getPath(obj, "status.conditions");
  if (!Array.isArray(conds)) return undefined;
  return conds.find((x) => x && typeof x === "object" && (x as Record<string, unknown>).type === conditionType) as
    | Record<string, unknown>
    | undefined;
}

function matchCondition(obj: unknown, m: ConditionMatch): boolean {
  const c = findCondition(obj, m.conditionType);
  return !!c && String(c.status) === (m.status ?? "True");
}

function matchConditionReason(obj: unknown, m: ConditionReasonMatch): boolean {
  const c = findCondition(obj, m.conditionType);
  if (!c || String(c.status) !== (m.status ?? "False")) return false;
  return typeof c.reason === "string" && m.reasonOneOf.includes(c.reason);
}

function matchPath(obj: unknown, m: PathMatch): boolean {
  const v = getPath(obj, m.path);
  if (m.equals !== undefined) return v === m.equals;
  if (m.oneOf !== undefined) return m.oneOf.includes(v as string | number);
  return v !== undefined && v !== null;
}

function matches(obj: unknown, m: ReadinessMatch): boolean {
  if (isConditionReason(m)) return matchConditionReason(obj, m);
  return isCondition(m) ? matchCondition(obj, m) : matchPath(obj, m);
}

function observedGenerationReady(obj: unknown): boolean {
  const gen = getPath(obj, "metadata.generation");
  const obs = getPath(obj, "status.observedGeneration");
  if (typeof gen === "number" && typeof obs === "number") return obs >= gen;
  return true; // absent on either side → don't block
}

/** True when every `ready` predicate holds (and observedGeneration is caught up). */
export function isReady(obj: unknown, spec: ReadinessSpec): boolean {
  if (spec.observedGeneration !== false && !observedGenerationReady(obj)) return false;
  return spec.ready.every((m) => matches(obj, m));
}

/** The first matching `terminal` predicate, if any — the resource is wedged. */
export function firstTerminal(obj: unknown, spec: ReadinessSpec): ReadinessMatch | undefined {
  return spec.terminal?.find((m) => matches(obj, m));
}

// ── Activity ────────────────────────────────────────────────────────

/** Thrown when the resource reaches a terminal state. Mark non-retryable. */
export class ReadinessFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessFailedError";
  }
}

export interface WaitForReadyArgs {
  /** Resource kind/type as `kubectl get` accepts it (e.g. "certificate", "raycluster.ray.io"). */
  kind: string;
  /** Resource name. */
  name: string;
  /** Namespace (omit for cluster-scoped). */
  namespace?: string;
  /**
   * kubectl context. To target the same cluster the read path
   * (`describeResources`) resolved for an environment — chant #1100 —
   * resolve it with `resolveClusterTarget` from `./index.ts` and pass
   * `.context` through.
   */
  context?: string;
  /**
   * chant environment, used to resolve `k8s.profiles.<env>.context` when no
   * explicit `context` is given. Optional and additive.
   */
  environment?: string;
  /** API group, used to pick a readiness override when `spec` is not given. */
  group?: string;
  /** Explicit readiness spec — wins over the registry/default. */
  spec?: ReadinessSpec;
  /** Poll interval in ms (default 15000). Heartbeats every poll. */
  intervalMs?: number;
}

/** Pluggable resource reader — overridden in tests with a fake. */
export type ResourceFetcher = (
  args: WaitForReadyArgs,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/**
 * Read the resource through the typed API client.
 *
 * A client is built once per `waitForReady` call and reused for every poll, so
 * a 20-minute wait does not re-parse the kubeconfig or re-invoke an exec
 * credential plugin on each iteration — and neither does it re-run discovery,
 * which the client caches per API version.
 */
export function apiResourceFetcher(connect: K8sConnector = defaultK8sConnector): ResourceFetcher {
  let connection: ReturnType<K8sConnector> | undefined;
  let resolved: { apiVersion: string; kind: string } | undefined;

  return async (args, signal) => {
    connection ??= connect({
      ...(args.environment !== undefined ? { environment: args.environment } : {}),
      ...(args.context !== undefined ? { context: args.context } : {}),
    });
    const { client } = await connection;

    if (!resolved) {
      const info = await client.resolve(
        { resource: args.kind, ...(args.group ? { group: args.group } : {}) },
        signal,
      );
      if (!info) {
        throw new Error(
          `waitForReady: the cluster's API discovery reports no resource matching "${args.kind}"` +
            `${args.group ? ` in group "${args.group}"` : ""} — nothing to wait for`,
        );
      }
      resolved = { apiVersion: info.apiVersion, kind: info.kind };
    }

    return (await client.read(
      {
        apiVersion: resolved.apiVersion,
        kind: resolved.kind,
        name: args.name,
        ...(args.namespace ? { namespace: args.namespace } : {}),
      },
      { signal },
    )) as Record<string, unknown>;
  };
}

/**
 * The production reader. Each call builds its own fetcher, so nothing is
 * shared between two unrelated waits; a single `waitForReady` passes one
 * fetcher through all of its polls, which is where the caching matters.
 */
export const defaultResourceFetcher: ResourceFetcher = (args, signal) => apiResourceFetcher()(args, signal);

/**
 * Poll until the resource satisfies its readiness spec. Throws
 * `ReadinessFailedError` on a terminal state. Heartbeats every poll so the
 * `k8sWait` profile's 60s heartbeat timeout never trips.
 *
 * @param fetcher injectable reader (defaults to kubectl). Tests pass a fake to
 *   drive not-ready → ready / terminal transitions.
 */
export async function waitForReady(
  args: WaitForReadyArgs,
  signal?: AbortSignal,
  fetcher: ResourceFetcher = apiResourceFetcher(),
): Promise<Record<string, unknown>> {
  const spec = args.spec ?? readinessFor(args.group, args.kind);
  const interval = args.intervalMs ?? 15_000;
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw new Error("waitForReady aborted");
    attempt++;

    const obj = await fetcher(args, signal);
    safeHeartbeat({ step: "waitForReady", kind: args.kind, name: args.name, attempt });

    const term = firstTerminal(obj, spec);
    if (term) {
      throw new ReadinessFailedError(
        `${args.kind}/${args.name} reached a terminal state (${JSON.stringify(term)}) — it will not become ready without intervention.`,
      );
    }

    if (isReady(obj, spec)) return obj;

    await sleep(interval, signal);
  }
}
