/**
 * render deploy Op — `build → renderApply [→ verify]` on the local executor.
 * The peer of `flyDeploy`, for a platform with no local emulator: it targets a
 * real Render workspace with a `RENDER_API_KEY`.
 *
 * The phases compose modeled activities, no raw shell:
 *   Build    run the project's `build:render` npm script → the serialized plan
 *   Apply    `renderApply` the plan straight to the Render Public API (creates
 *            or PATCHes each resource by name, waits each created service's
 *            deploy to `live`, prunes owned-only when asked)
 *   Verify   optional: GET a public URL and assert on its body
 *
 * The activity steps are the generic `activity(fn, args)` builder tagged with
 * the exported activity function names the render lexicon contributes
 * (`renderApply`/`renderDelete` from `src/op/activities`). The core activity
 * registry resolves them by name when a project lists the `render` lexicon.
 */

import { Op, phase, build, activity, httpCheck } from "@intentius/chant/op";
import type { OpResource } from "@intentius/chant/op";
import type { ActivityStep } from "@intentius/chant/op";

/** Options for the render apply step (mirror `RenderApplyArgs`, minus `planPath`). */
export interface RenderApplyStepOpts {
  /** API base URL override. Default: `RENDER_API_BASE_URL` env, else api.render.com. */
  endpoint?: string;
  /** Bearer token. Default: `RENDER_API_KEY`. */
  token?: string;
  /** Workspace id for `$owner` markers. Default: `RENDER_OWNER_ID`, else the sole visible owner. */
  ownerId?: string;
  /** Prune chant-owned services/env groups the plan no longer declares. Destructive — off by default. */
  prune?: boolean;
  /** Deploy wait tuning. */
  wait?: Record<string, unknown>;
  /** Activity profile override. */
  profile?: ActivityStep["profile"];
}

/**
 * Apply the serialized render plan straight to the Render Public API — the
 * typed twin of `flyApplyStep`. Resolves to the `renderApply` activity.
 * Defaults to the `longInfra` profile (a first deploy builds and can take
 * minutes); override via `opts.profile`.
 */
export const renderApplyStep = (planPath: string, opts?: RenderApplyStepOpts): ActivityStep => {
  const { profile, ...rest } = opts ?? {};
  return activity("renderApply", { planPath, ...(rest as Record<string, unknown>) }, profile ?? "longInfra");
};

/**
 * Delete everything the plan declares, in reverse order — the teardown twin.
 * Resolves to the `renderDelete` activity.
 */
export const renderDeleteStep = (planPath: string, opts?: RenderApplyStepOpts): ActivityStep => {
  const { profile, ...rest } = opts ?? {};
  return activity("renderDelete", { planPath, ...(rest as Record<string, unknown>) }, profile ?? "longInfra");
};

/** Options for {@link renderDeploy}. */
export interface RenderDeployOpts {
  /** Op name (the `chant run <name>` target). Default: `render`. */
  name?: string;
  /** Op overview line. */
  overview?: string;
  /** Temporal task queue (unused by the local executor). Default: `local-render`. */
  taskQueue?: string;
  /** Directory the `build:render` script and plan path are relative to. Default: `.`. */
  path?: string;
  /** npm build script to run. Default: `build:render`. */
  buildScript?: string;
  /** Path to the serialized render plan the build writes. Default: `dist/render.json`. */
  planPath?: string;
  /** API base URL override (a local stand-in). Default: real Render via `RENDER_API_BASE_URL` / `RENDER_API_KEY`. */
  endpoint?: string;
  /** Workspace id. Default: `RENDER_OWNER_ID`, else the sole visible owner. */
  ownerId?: string;
  /** Prune declared-then-removed owned resources on apply. Off by default. */
  prune?: boolean;
  /** Deploy wait tuning passed through to `renderApply`. */
  wait?: Record<string, unknown>;
  /**
   * A public URL to GET after apply, with the text it must contain. When set,
   * the Op adds a Verify phase. Omitted → no Verify (the Apply step still
   * waits each created service's deploy to `live`).
   */
  verify?: { url: string; contains?: string; retries?: number; intervalMs?: number };
  /** Add a Teardown phase that deletes what the plan declares. Off by default. */
  teardown?: boolean;
}

/**
 * Build a render deploy Op: build the plan, apply it to the workspace, verify
 * a URL when asked, tear down when asked. See the module docstring.
 */
export function renderDeploy(opts: RenderDeployOpts = {}): InstanceType<typeof OpResource> {
  const path = opts.path ?? ".";
  const planPath = opts.planPath ?? "dist/render.json";

  const applyOpts: RenderApplyStepOpts = {
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
    ...(opts.prune ? { prune: true } : {}),
    ...(opts.wait ? { wait: opts.wait } : {}),
  };

  const phases = [
    phase("Build", [build(path, { script: opts.buildScript ?? "build:render" })]),
    phase("Apply", [renderApplyStep(planPath, applyOpts)]),
  ];

  if (opts.verify) {
    phases.push(
      phase("Verify", [
        httpCheck(opts.verify.url, {
          ...(opts.verify.contains ? { contains: opts.verify.contains } : {}),
          retries: opts.verify.retries ?? 30,
          intervalMs: opts.verify.intervalMs ?? 5000,
        }),
      ]),
    );
  }

  if (opts.teardown) {
    phases.push(phase("Teardown", [renderDeleteStep(planPath, applyOpts)]));
  }

  return Op({
    name: opts.name ?? "render",
    overview: opts.overview ?? "Render: build the plan, apply it to the workspace over the Public API, verify",
    taskQueue: opts.taskQueue ?? "local-render",
    phases,
  });
}
