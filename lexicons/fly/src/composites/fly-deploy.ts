/**
 * fly deploy Op (#744) — the integration proof: `boot → build → flyApply → wait
 * → teardown` on the local executor. The peer of the aws/gcp deploy Ops in
 * `examples/local-cloud-trio`, for a single cloud.
 *
 * The phases compose modeled activities, no raw shell:
 *   Emulator  boot mudflaps (the Fly Machines API fake) via `flapsUp`
 *   Build     run the project's `build:fly` npm script → the serialized plan
 *   Apply     `flyApply` the plan straight to flaps (creates App + Machine and
 *             waits each machine to `started` via `/wait`)
 *   Verify    GET the app's machines and assert one reached `started`
 *   Teardown  stop and remove the mudflaps container via `flapsDown`
 *
 * The activity steps are the generic `activity(fn, args)` builder tagged with
 * the exported activity function names the fly lexicon contributes
 * (`flapsUp`/`flapsDown`/`flyApply` from `src/op/activities`). The core activity
 * registry resolves them by name when a project lists the `fly` lexicon, so
 * these typed builders give `gcpApply()`-style DX without a core change.
 *
 * D3 (local vs real Fly): the Apply step's flaps endpoint defaults to local
 * mudflaps (`http://localhost:4280`). Pass `endpoint: null` to drop the override
 * and let `flyApply` fall through to `FLY_FLAPS_BASE_URL` / real Fly (with a
 * `FLY_API_TOKEN`).
 */

import { Op, phase, build, activity, httpCheck } from "@intentius/chant/op";
import type { OpResource } from "@intentius/chant/op";
import type { ActivityStep } from "@intentius/chant/op";

/** The local mudflaps endpoint the deploy Op targets by default. */
export const LOCAL_FLAPS_ENDPOINT = "http://localhost:4280";

/** Options accepted by the mudflaps lifecycle step builders. */
export interface FlapsStepOpts {
  /** Container name. Default: `chant-mudflaps`. */
  name?: string;
  /** Host port mapped to the emulator's `:4280`. Default: `4280`. */
  port?: number;
  /** Image. Default: the pinned mudflaps image (`MUDFLAPS_IMAGE`, from the flapsUp activity). */
  image?: string;
  /** Readiness timeout in ms. */
  timeoutMs?: number;
  /** Health poll interval in ms. */
  intervalMs?: number;
  /** Activity profile override. */
  profile?: ActivityStep["profile"];
}

/**
 * Boot a local mudflaps (Fly Machines API emulator) in Docker and point the
 * apply step at it — the typed twin of `flociGcpUp` for flaps. Resolves to the
 * `flapsUp` activity (#740). Defaults to the `longInfra` profile (the image may
 * pull); override via `opts.profile`.
 */
export const flapsUp = (opts?: FlapsStepOpts): ActivityStep => {
  const { profile, ...args } = opts ?? {};
  return activity("flapsUp", args as Record<string, unknown>, profile ?? "longInfra");
};

/** Stop and remove the local mudflaps container. Resolves to the `flapsDown` activity. Defaults to the `fastIdempotent` profile (override via `opts.profile`). */
export const flapsDown = (opts?: FlapsStepOpts): ActivityStep => {
  const { profile, ...args } = opts ?? {};
  return activity("flapsDown", args as Record<string, unknown>, profile ?? "fastIdempotent");
};

/** Options for the flaps apply step (mirror `FlyApplyArgs`, minus `planPath`). */
export interface FlyApplyStepOpts {
  /** flaps endpoint override (D3). Default: `FLY_FLAPS_BASE_URL` env, else real Fly. */
  endpoint?: string;
  /** Bearer token for real Fly. Default: `FLY_API_TOKEN`. mudflaps ignores it. */
  token?: string;
  /** Prune declared-then-removed resources (D2). Destructive — off by default. */
  prune?: boolean;
  /** Wait-loop tuning (mainly for tests). */
  wait?: Record<string, unknown>;
  /** Activity profile override. */
  profile?: ActivityStep["profile"];
}

/**
 * Apply the serialized flaps plan straight to the Machines API — the typed twin
 * of `gcpApply` for fly. Resolves to the `flyApply` activity (#739): create
 * App + Machine, wait each machine to `started`, prune owned-only when asked.
 * Defaults to the `longInfra` profile (override via `opts.profile`).
 */
export const flyApplyStep = (planPath: string, opts?: FlyApplyStepOpts): ActivityStep => {
  const { profile, ...rest } = opts ?? {};
  return activity("flyApply", { planPath, ...(rest as Record<string, unknown>) }, profile ?? "longInfra");
};

/** Options for {@link flyDeploy}. */
export interface FlyDeployOpts {
  /** Op name (the `chant run <name>` target). Default: `fly`. */
  name?: string;
  /** Op overview line. */
  overview?: string;
  /** Temporal task queue (unused by the local executor). Default: `local-fly`. */
  taskQueue?: string;
  /** Directory the `build:fly` script and plan path are relative to. Default: `.`. */
  path?: string;
  /** npm build script to run. Default: `build:fly`. */
  buildScript?: string;
  /** Path to the serialized flaps plan the build writes. Default: `dist/fly.json`. */
  planPath?: string;
  /**
   * flaps endpoint the apply + verify steps target (D3). Defaults to local
   * mudflaps ({@link LOCAL_FLAPS_ENDPOINT}). Pass `null` to drop the override so
   * `flyApply` targets real Fly via `FLY_FLAPS_BASE_URL` / a `FLY_API_TOKEN`.
   */
  endpoint?: string | null;
  /**
   * App name for the Verify step. When set (with a local `endpoint`), the Op GETs
   * the app's machines and asserts one reached `started`. Omitted → no Verify
   * step (the Apply step still waits each machine to `started`).
   */
  app?: string;
  /** Prune declared-then-removed resources on apply (D2). Off by default. */
  prune?: boolean;
  /** Wait-loop tuning passed through to `flyApply` (mainly for tests). */
  wait?: Record<string, unknown>;
}

/**
 * Build a fly deploy Op: boot mudflaps, build the plan, apply App + Machine,
 * verify the machine reached `started`, tear the emulator down. See the module
 * docstring for the phase layout and the D3 endpoint story.
 */
export function flyDeploy(opts: FlyDeployOpts = {}): InstanceType<typeof OpResource> {
  const path = opts.path ?? ".";
  const planPath = opts.planPath ?? "dist/fly.json";
  const endpoint = opts.endpoint === undefined ? LOCAL_FLAPS_ENDPOINT : opts.endpoint;

  const applyOpts: FlyApplyStepOpts = {
    ...(endpoint ? { endpoint } : {}),
    ...(opts.prune ? { prune: true } : {}),
    ...(opts.wait ? { wait: opts.wait } : {}),
  };

  const phases = [
    phase("Emulator", [flapsUp()]),
    phase("Build", [build(path, { script: opts.buildScript ?? "build:fly" })]),
    phase("Apply", [flyApplyStep(planPath, applyOpts)]),
  ];

  // Verify only makes sense against a reachable local endpoint: mudflaps needs
  // no auth, so a plain GET of the app's machines can assert `started`. Against
  // real Fly (no endpoint) the flaps API needs a bearer token httpCheck can't
  // carry, so the Apply step's own `/wait` is the verification there.
  if (endpoint && opts.app) {
    phases.push(
      phase("Verify", [
        httpCheck(`${endpoint}/v1/apps/${opts.app}/machines`, {
          contains: "started",
          retries: 15,
          intervalMs: 2000,
        }),
      ]),
    );
  }

  phases.push(phase("Teardown", [flapsDown()]));

  return Op({
    name: opts.name ?? "fly",
    overview: opts.overview ?? "Fly: App + Machine → mudflaps (direct flaps apply), local, no account",
    taskQueue: opts.taskQueue ?? "local-fly",
    phases,
  });
}
