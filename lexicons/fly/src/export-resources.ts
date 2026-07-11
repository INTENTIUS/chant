/**
 * Live export for the fly lexicon — implements `LexiconPlugin.exportResources()`
 * so `chant import --from <fly-env>` regenerates existing Fly apps and machines
 * as chant TypeScript.
 *
 * Reads live flaps state and hands it to the pure `./import/live-export`
 * helpers, which strip server-written fields to the authored shape and map it to
 * import IR via `FlyParser`. Endpoint + auth reuse the applier verbatim
 * (`resolveEndpoint` / `defaultFlyHttp` → FLY_FLAPS_BASE_URL / FLY_API_TOKEN),
 * and the machine listing reuses the applier's `listMachines`, so export reads
 * the same target `flyApply` writes and `describeResources` observes.
 *
 * Which apps are exported: an app named by the selector, else `FLY_APP_NAME`,
 * else every app in the org (`GET /v1/apps?org_slug=<FLY_ORG>`). All flaps I/O
 * lives here; cleaning and IR-building are pure in `./import/live-export`.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import {
  resolveEndpoint,
  defaultFlyHttp,
  listMachines,
  type FlyHttp,
  type ApplyCtx,
} from "./op/activities/fly-apply";
import { buildExportFromApp } from "./import/live-export";

const DEFAULT_ORG = "personal";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function orgSlug(): string {
  return process.env.FLY_ORG || process.env.FLY_ORG_SLUG || DEFAULT_ORG;
}

/** Resolve which apps to export: selector name → FLY_APP_NAME → org listing. */
async function resolveApps(
  ctx: ApplyCtx,
  selector: ResourceSelector | undefined,
  http: FlyHttp,
  signal?: AbortSignal,
): Promise<string[]> {
  if (selector?.name) return [selector.name];
  if (process.env.FLY_APP_NAME) return [process.env.FLY_APP_NAME];

  const res = await http(
    "GET",
    `${ctx.base}/v1/apps?org_slug=${encodeURIComponent(orgSlug())}`,
    undefined,
    undefined,
    signal,
  );
  if (res.status >= 300) return [];
  const body = parseJson(res.text);
  const apps = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { apps?: unknown[] }).apps)
      ? (body as { apps: unknown[] }).apps
      : [];
  return apps
    .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === "string");
}

export async function exportResources(
  options: {
    environment: string;
    selector?: ResourceSelector;
    owned?: boolean;
    verbatim?: boolean;
  },
  http: FlyHttp = defaultFlyHttp(),
  signal?: AbortSignal,
): Promise<ExportedTemplate> {
  const ctx: ApplyCtx = { base: resolveEndpoint({}) };
  const apps = await resolveApps(ctx, options.selector, http, signal);
  if (apps.length === 0) return { resources: [], parameters: [] };

  // The app-boundary log fires at most once per call, only under `owned`, when
  // the marker-less app type is reached (mirrors describe-resources).
  let loggedBoundary = false;
  const onBoundaryInference = (): void => {
    if (loggedBoundary) return;
    loggedBoundary = true;
    console.warn(
      "[fly] apps carry no per-resource ownership marker — ownership is inferred at the app boundary (#741/#743); only apps with a chant-managed machine are exported under --owned",
    );
  };

  const resources: ExportedTemplate["resources"] = [];
  for (const app of apps) {
    const appRes = await http(
      "GET",
      `${ctx.base}/v1/apps/${encodeURIComponent(app)}`,
      undefined,
      undefined,
      signal,
    );
    const appBody = appRes.status === 200 ? parseJson(appRes.text) : undefined;
    const appObj =
      appBody && typeof appBody === "object" && !Array.isArray(appBody)
        ? (appBody as Record<string, unknown>)
        : { name: app };

    const machines = await listMachines(ctx, app, http, signal);

    const ir = buildExportFromApp(appObj, machines, {
      verbatim: options.verbatim,
      selector: options.selector,
      owned: options.owned,
      onBoundaryInference,
    });
    resources.push(...ir.resources);
  }

  return { resources, parameters: [] };
}
