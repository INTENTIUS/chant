/**
 * `grafanaApply`, the Op activity for the Grafana API applier (#2948), and
 * `toApplyResult`, its projection onto core's apply envelope (#1446).
 *
 * It reads a build's output (the index the serializer writes as its primary
 * output, and the dashboard files beside it), binds the environment's
 * Grafana the way observe and export do (`grafana.profiles.<env>`, else
 * `GRAFANA_URL`; ../../api/bind.ts), and hands the plan to `applyGrafana`
 * (../../api/apply.ts), which holds the API decisions.
 *
 * The ownership marker is the project's: `ownership.stack` and
 * `ownership.env` from `chant.config.ts`, or `stack`/`ownershipEnv` passed
 * in. Without a stack the apply still runs, stamping only the managed-by
 * label, and a prune declines (as `not-prunable`) rather than delete
 * another stack's dashboards.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChantConfig } from "@intentius/chant/config";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import {
  applyResult,
  notAttemptedAll,
  type AppliedResource,
  type ApplyResult,
  type NotAttemptedResource,
} from "@intentius/chant/apply";
import { bindGrafana, GrafanaBindingError, type BindOptions } from "../../api/bind";
import type { GrafanaHttp } from "../../api/client";
import { applyGrafana, parseDashboardFile, planFromDashboards, planRefs, type BuiltDashboardInput, type GrafanaApplyOutcome } from "../../api/apply";

export type { GrafanaApplyOutcome } from "../../api/apply";

export interface GrafanaApplyArgs {
  /**
   * The build's primary output: the index the grafana serializer writes
   * (`chant build -o dist/grafana.json`). The dashboard files it lists are
   * read from the same directory. A combined multi-lexicon output works too;
   * its `grafana` key is used.
   */
  indexPath: string;
  /** The chant environment, which selects `grafana.profiles.<environment>`. */
  environment?: string;
  /**
   * Delete this project's dashboards and folders that the build no longer
   * declares: only those carrying its ownership marker, stack and env.
   * Destructive, so off by default.
   */
  prune?: boolean;
  /** Ownership stack. Default: `ownership.stack` in `chant.config.ts`. */
  stack?: string;
  /** Ownership env. Default: `ownership.env` in `chant.config.ts` (a literal; a `{ param }` reference needs this). */
  ownershipEnv?: string;
  /** Project directory for `chant.config.ts`. Default: the working directory. */
  cwd?: string;
}

/** What a test (or an embedding caller) may inject instead of the project's config, the process env and `fetch`. */
export interface GrafanaApplyDeps {
  http?: GrafanaHttp;
  config?: Pick<ChantConfig, "grafana" | "ownership">;
  env?: Record<string, string | undefined>;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The dashboards a build wrote, read from its index and the files beside
 * it. Pure but for the file reads.
 */
export function readBuiltDashboards(indexPath: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): BuiltDashboardInput[] {
  const raw = parseDashboardFile(read(indexPath), indexPath);
  const index = isObject(raw.grafana) && Array.isArray(raw.grafana.dashboards) ? raw.grafana : raw;
  if (!Array.isArray(index.dashboards)) throw new Error(`grafana apply: ${indexPath} is not a grafana build index (it has no "dashboards" list)`);
  const dir = dirname(indexPath);
  return index.dashboards.map((entry, i) => {
    if (!isObject(entry) || typeof entry.file !== "string") throw new Error(`grafana apply: ${indexPath} dashboards[${i}] names no file`);
    const file = join(dir, entry.file);
    const json = parseDashboardFile(read(file), file);
    return { json, ...(typeof entry.folder === "string" && entry.folder !== "" ? { folder: entry.folder } : {}) };
  });
}

async function loadConfig(cwd: string): Promise<Pick<ChantConfig, "grafana" | "ownership"> | undefined> {
  try {
    const { loadChantConfig } = await import("@intentius/chant/config");
    return (await loadChantConfig(cwd)).config;
  } catch {
    return undefined;
  }
}

/** The marker to stamp and prune by: the arguments, else the project's `ownership` config. */
export function resolveMarker(args: Pick<GrafanaApplyArgs, "stack" | "ownershipEnv">, config: Pick<ChantConfig, "ownership"> | undefined): OwnershipMarker | undefined {
  const o = config?.ownership;
  const configured = o && o.enabled !== false ? o : undefined;
  const stack = args.stack ?? configured?.stack;
  if (!stack) return undefined;
  const env = args.ownershipEnv ?? (typeof configured?.env === "string" ? configured.env : undefined);
  if (env === undefined && configured?.env !== undefined) {
    throw new Error("grafana apply: ownership.env is a build parameter reference, which an apply cannot resolve; pass ownershipEnv");
  }
  return { stack, ...(env ? { env } : {}) };
}

/**
 * Apply a grafana build to the environment's Grafana over its HTTP API.
 * Dashboards and folders get chant's ownership labels; with `prune`, this
 * project's dashboards and folders the build no longer has are deleted.
 * A target that cannot be bound returns every resource as not attempted,
 * with the binding's reason.
 */
export async function grafanaApply(args: GrafanaApplyArgs, signal?: AbortSignal, deps: GrafanaApplyDeps = {}): Promise<GrafanaApplyOutcome> {
  const plan = planFromDashboards(readBuiltDashboards(args.indexPath));
  const config = deps.config ?? (await loadConfig(args.cwd ?? process.cwd()));
  const marker = resolveMarker(args, config);
  const bind: BindOptions = {
    ...(args.environment !== undefined ? { environment: args.environment } : {}),
    config: config ?? {},
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.http ? { http: deps.http } : {}),
  };
  let client;
  try {
    client = await bindGrafana(bind);
  } catch (err) {
    if (!(err instanceof GrafanaBindingError)) throw err;
    return {
      target: "",
      api: "",
      applied: [],
      pruned: [],
      notAttempted: [
        ...plan.unsupported.map((u) => ({ kind: u.kind, name: u.name, reason: "unsupported-kind" as const, detail: u.detail })),
        ...notAttemptedAll(
          planRefs(plan).filter((r) => !plan.unsupported.some((u) => u.kind === r.kind && u.name === r.name)),
          err.unresolved.reason,
          err.unresolved.detail,
        ),
      ],
      notPrunable: [],
    };
  }
  const outcome = await applyGrafana(client, plan, { ...(marker ? { marker } : {}), ...(args.prune ? { prune: true } : {}), ...(signal ? { signal } : {}) });
  for (const a of outcome.applied) console.log(`${a.action}: ${a.kind}/${a.name} (${outcome.target})`);
  for (const p of outcome.pruned) console.log(`pruned: ${p.kind}/${p.name} (${outcome.target})`);
  for (const n of outcome.notAttempted) console.log(`not attempted: ${n.kind}/${n.name}: ${n.reason}${n.detail ? ` (${n.detail})` : ""}`);
  for (const n of outcome.notPrunable) console.log(`prune: ${n.kind} not considered: ${n.detail}`);
  return outcome;
}

/**
 * Project a grafana apply outcome onto core's apply envelope. The outcome
 * keeps what the envelope has no room for (the request path, the API
 * version, the binding's source); a kind the prune could not consider has no
 * single resource name, so it is reported as `<kind>/*`, `not-prunable`,
 * as the gcp applier does.
 */
export function toApplyResult(outcome: GrafanaApplyOutcome): ApplyResult {
  const applied: AppliedResource[] = outcome.applied.map((a) => ({ kind: a.kind, name: a.name, action: a.action, physicalId: a.address }));
  const notAttempted: NotAttemptedResource[] = [
    ...outcome.notAttempted.map((n) => ({ kind: n.kind, name: n.name, reason: n.reason, ...(n.detail ? { detail: n.detail } : {}) })),
    ...outcome.notPrunable.map((n) => ({ kind: n.kind, name: "*", reason: "not-prunable" as const, detail: n.detail })),
  ];
  return applyResult(applied, outcome.pruned.map((p) => ({ kind: p.kind, name: p.name, deleted: p.deleted })), notAttempted);
}
