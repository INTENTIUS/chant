import { exec } from "node:child_process";
import { promisify } from "node:util";
import { safeHeartbeat } from "./heartbeat";
import { sleep } from "./util";

const execAsync = promisify(exec);

/**
 * waitForArgoSync — block until an Argo CD Application reports
 * `health=Healthy && sync=Synced`.
 *
 * This activity is intentionally **dependency-free**: it must not import the k8s
 * lexicon or its generated Argo CRD types. Its signature is primitives-only
 * (app name / namespace / server). It reads the Application's status either via
 * `kubectl get application` (default) or the Argo CD REST API (when `server` is
 * given), so Temporal can gate procedural steps on a declarative apply that Argo
 * owns.
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

/** Health states that will never become Healthy without intervention. */
const TERMINAL_UNHEALTHY = new Set(["Degraded", "Missing"]);

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
 * Missing). Heartbeats every poll so the `argoSync` profile's 60s heartbeat
 * timeout never trips.
 *
 * @param fetcher injectable status reader (defaults to kubectl/REST). Tests pass
 *   a fake to drive Healthy/Progressing/Degraded transitions.
 */
export async function waitForArgoSync(
  args: WaitForArgoSyncArgs,
  signal?: AbortSignal,
  fetcher: ArgoStatusFetcher = defaultArgoStatusFetcher,
): Promise<ArgoAppStatus> {
  const interval = args.intervalMs ?? 15_000;
  let attempt = 0;

  while (true) {
    if (signal?.aborted) throw new Error("waitForArgoSync aborted");
    attempt++;

    const status = await fetcher(args, signal);
    safeHeartbeat({ step: "waitForArgoSync", app: args.appName, attempt, ...status });

    if (TERMINAL_UNHEALTHY.has(status.health)) {
      throw new ArgoSyncFailedError(
        `Argo Application "${args.appName}" is ${status.health} (sync=${status.sync}) — it will not become Healthy without intervention.`,
      );
    }

    if (status.health === "Healthy" && status.sync === "Synced") {
      return status;
    }

    await sleep(interval, signal);
  }
}
