import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat, sleep } from "@intentius/chant/op";

const execAsync = promisify(exec);

/**
 * waitForReady — block until any operator-backed Kubernetes resource reports
 * ready, driven by a data-only **readiness spec** rather than per-CRD code.
 *
 * Like `waitForArgoSync`, this activity is intentionally **dependency-light**:
 * its signature is primitives + a plain readiness spec, so a Temporal worker
 * loads it without importing the generated CRD declarable surface. It reads the
 * resource via `kubectl get -o json` (injectable for tests) and evaluates the
 * spec's predicates. It generalizes the bespoke `waitForArgoSync` /
 * `waitForStack` waits — see #365.
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

export type ReadinessMatch = ConditionMatch | PathMatch;

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
export const READINESS_OVERRIDES: Record<string, ReadinessSpec> = {
  "argoproj.io/Application": {
    ready: [
      { path: "status.health.status", equals: "Healthy" },
      { path: "status.sync.status", equals: "Synced" },
    ],
    terminal: [{ path: "status.health.status", oneOf: ["Degraded", "Missing"] }],
    observedGeneration: false,
  },
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

function isCondition(m: ReadinessMatch): m is ConditionMatch {
  return (m as ConditionMatch).conditionType !== undefined;
}

function matchCondition(obj: unknown, m: ConditionMatch): boolean {
  const conds = getPath(obj, "status.conditions");
  if (!Array.isArray(conds)) return false;
  const c = conds.find((x) => x && typeof x === "object" && (x as Record<string, unknown>).type === m.conditionType);
  return !!c && String((c as Record<string, unknown>).status) === (m.status ?? "True");
}

function matchPath(obj: unknown, m: PathMatch): boolean {
  const v = getPath(obj, m.path);
  if (m.equals !== undefined) return v === m.equals;
  if (m.oneOf !== undefined) return m.oneOf.includes(v as string | number);
  return v !== undefined && v !== null;
}

function matches(obj: unknown, m: ReadinessMatch): boolean {
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
  /** kubectl context. */
  context?: string;
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

/** Read the resource via `kubectl get -o json`. */
async function fetchViaKubectl(args: WaitForReadyArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const ns = args.namespace ? `-n ${args.namespace}` : "";
  const ctx = args.context ? `--context ${args.context}` : "";
  const { stdout } = await execAsync(`kubectl get ${args.kind} ${args.name} ${ns} ${ctx} -o json`, { signal });
  return JSON.parse(stdout) as Record<string, unknown>;
}

export const defaultResourceFetcher: ResourceFetcher = (args, signal) => fetchViaKubectl(args, signal);

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
  fetcher: ResourceFetcher = defaultResourceFetcher,
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
