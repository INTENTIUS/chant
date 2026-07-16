import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readinessFor, waitForReady, ReadinessFailedError, type ResourceFetcher } from "./wait-for-ready";

const execAsync = promisify(exec);

/**
 * waitForArgoSync — block until an Argo CD Application reports
 * `health=Healthy && sync=Synced`.
 *
 * As of #957 this is a thin wrapper over the generic `waitForReady`: the
 * Healthy/Synced ready condition and the Degraded/Missing terminal condition
 * live in the shared readiness registry (`argoproj.io/Application`), so there is
 * a single poll loop. This activity keeps its own status **fetchers** because
 * Argo exposes a REST API that `kubectl` can't cover; it adapts them into a
 * `ResourceFetcher` for `waitForReady`.
 *
 * It stays **dependency-light** — primitives-only signature (app name /
 * namespace / server), no generated Argo CRD types — so a Temporal worker loads
 * it cheaply.
 */

export interface WaitForArgoSyncArgs {
  /** Argo Application name. */
  appName: string;
  /** Namespace the Application object lives in (default "argocd"). */
  namespace?: string;
  /**
   * Argo CD API base URL (e.g. https://argocd.example.com). When set, status is
   * read from the REST API instead of kubectl. Pass `authToken` with it.
   */
  server?: string;
  /** Bearer token for the Argo CD REST API (used with `server`). */
  authToken?: string;
  /** Skip TLS verification for the REST API (default false). */
  insecure?: boolean;
  /** kubectl context (used when `server` is not set). */
  context?: string;
  /** Poll interval in ms (default 15000). Heartbeats every poll. */
  intervalMs?: number;
}

/** The two status fields the activity gates on. */
export interface ArgoAppStatus {
  /** Application health: Healthy | Progressing | Degraded | Missing | Suspended | Unknown. */
  health: string;
  /** Sync status: Synced | OutOfSync | Unknown. */
  sync: string;
}

/** Pluggable status reader — overridden in tests with a faked Argo API. */
export type ArgoStatusFetcher = (
  args: WaitForArgoSyncArgs,
  signal?: AbortSignal,
) => Promise<ArgoAppStatus>;

/** Error thrown when the Application reaches a terminal unhealthy state. */
export class ArgoSyncFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgoSyncFailedError";
  }
}

/** Read status via the Argo CD REST API. */
async function fetchViaApi(args: WaitForArgoSyncArgs, signal?: AbortSignal): Promise<ArgoAppStatus> {
  const base = args.server!.replace(/\/$/, "");
  const ns = args.namespace ?? "argocd";
  const url = `${base}/api/v1/applications/${encodeURIComponent(args.appName)}?appNamespace=${encodeURIComponent(ns)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (args.authToken) headers.Authorization = `Bearer ${args.authToken}`;

  // Honor `insecure` without importing https Agent types — Node respects this
  // env toggle for the duration of the call.
  const prevTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) {
      throw new Error(`Argo CD API returned ${res.status} for application "${args.appName}"`);
    }
    const body = (await res.json()) as { status?: { health?: { status?: string }; sync?: { status?: string } } };
    return {
      health: body.status?.health?.status ?? "Unknown",
      sync: body.status?.sync?.status ?? "Unknown",
    };
  } finally {
    if (args.insecure) {
      if (prevTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsReject;
    }
  }
}

/** Read status via `kubectl get application -o json`. */
async function fetchViaKubectl(args: WaitForArgoSyncArgs, signal?: AbortSignal): Promise<ArgoAppStatus> {
  const ns = args.namespace ?? "argocd";
  const ctx = args.context ? `--context ${args.context}` : "";
  const cmd =
    `kubectl get application ${args.appName} -n ${ns} ${ctx} ` +
    `-o jsonpath='{.status.health.status}|{.status.sync.status}'`;
  const { stdout } = await execAsync(cmd, { signal });
  const [health = "Unknown", sync = "Unknown"] = stdout.trim().replace(/^'|'$/g, "").split("|");
  return { health: health || "Unknown", sync: sync || "Unknown" };
}

/** Default fetcher: REST API when `server` is set, else kubectl. */
export const defaultArgoStatusFetcher: ArgoStatusFetcher = (args, signal) =>
  args.server ? fetchViaApi(args, signal) : fetchViaKubectl(args, signal);

/**
 * Poll until the Application is Healthy and Synced. Throws
 * `ArgoSyncFailedError` if it reaches a terminal unhealthy state (Degraded /
 * Missing).
 *
 * Delegates the poll loop, heartbeat, and ready/terminal evaluation to the
 * generic `waitForReady` using the shared `argoproj.io/Application` readiness
 * spec. The Argo `ArgoStatusFetcher` is adapted into a `ResourceFetcher` that
 * shapes `{health, sync}` into the `status.health.status` / `status.sync.status`
 * paths the spec reads — so the REST-API path is preserved.
 *
 * @param fetcher injectable status reader (defaults to kubectl/REST). Tests pass
 *   a fake to drive Healthy/Progressing/Degraded transitions.
 */
export async function waitForArgoSync(
  args: WaitForArgoSyncArgs,
  signal?: AbortSignal,
  fetcher: ArgoStatusFetcher = defaultArgoStatusFetcher,
): Promise<ArgoAppStatus> {
  const spec = readinessFor("argoproj.io", "Application");

  // Adapt the Argo status fetcher into the object shape the spec's paths read.
  const resourceFetcher: ResourceFetcher = async (_a, s) => {
    const status = await fetcher(args, s);
    return { status: { health: { status: status.health }, sync: { status: status.sync } } };
  };

  try {
    const obj = await waitForReady(
      {
        kind: "application",
        name: args.appName,
        namespace: args.namespace ?? "argocd",
        group: "argoproj.io",
        spec,
        intervalMs: args.intervalMs ?? 15_000,
      },
      signal,
      resourceFetcher,
    );
    const status = (obj as { status: { health: { status: string }; sync: { status: string } } }).status;
    return { health: status.health.status, sync: status.sync.status };
  } catch (err) {
    // Preserve the Argo-specific error type (the argoSync profile marks it
    // non-retryable) while reusing the generic terminal detection.
    if (err instanceof ReadinessFailedError) {
      throw new ArgoSyncFailedError(
        `Argo Application "${args.appName}" reached a terminal unhealthy state (Degraded / Missing) — it will not become Healthy without intervention.`,
      );
    }
    throw err;
  }
}
