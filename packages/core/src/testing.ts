/**
 * `@intentius/chant/testing` (#1224) — the live-stack test harness.
 *
 * A vitest suite deploys a real instance of its project once, asserts against
 * it, and tears it down — emulator-locally on a dev machine, real-cloud in CI,
 * with the same suite text. One call composes machinery that already exists:
 *
 * - **build** — the same programmatic path `chant build` takes: config
 *   resolution (`buildParams` + the ownership marker) mirrored from the CLI,
 *   then `build()` over the project's own serializers.
 * - **apply** — an additive `nativeApply` per built lexicon output, run
 *   in-process through the local Op executor (`runOpLocally`). `deleteMode`
 *   is `"never"`: a test deploy creates and updates, nothing else.
 * - **destroy** — #1222's marker-scoped teardown (`executeTeardown`), called
 *   in-process for exactly this suite's environment. Stateless by design:
 *   a crashed suite's environment is recovered by calling destroy again (or
 *   `chant lifecycle teardown <env> --yes`).
 *
 * ## Isolation
 *
 * Every deploy targets its own environment: `test-<suite>-<nonce>` by default
 * ({@link testEnvName}), so parallel CI jobs never collide. The environment
 * is the teardown key — everything the deploy stamps carries the ownership
 * marker `{ stack, env }`, and `destroy()` selects on that identity and
 * nothing else. A project that declares `environments` must legalize the
 * dynamic names with a pattern entry (#1221):
 *
 * ```ts
 * environments: ["dev", "prod", { name: "test-*", endpoint: "http://localhost:4566" }]
 * ```
 *
 * ## Emulators
 *
 * The harness is emulator-aware the same way `--live` reads are (#1166): the
 * target environment's declared `endpoint` is injected into each lexicon's
 * ambient endpoint variable (`AWS_ENDPOINT_URL`, …) for the apply and the
 * teardown — unless the variable is already set. Ambient always wins, so the
 * env vars `chant emulator up --json` reports (#920) take precedence when
 * exported, and a CI job pointing the identical suite at a real account just
 * leaves both unset.
 */

import { basename, join, resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "./build";
import type { Declarable } from "./declarable";
import type { SerializerResult } from "./serializer";
import {
  loadChantConfigUpward,
  resolveOwnershipStack,
  type ChantConfig,
} from "./config";
import { resolveBuildParams, type BuildParamValue } from "./build-params";
import { ENV_VAR, unknownEnvError } from "./env";
import { applyLiveEndpoint } from "./live-endpoint";
import { loadPlugins, resolveProjectLexicons, collectBuildRootContributors } from "./cli/plugins";
import type { LexiconPlugin } from "./lexicon";
import type { OwnershipMarker } from "./ownership";
import { runOpLocally } from "./op/local-executor";
import { loadActivities, loadProfiles, type ActivityFn, type ActivityProfile } from "./op/activity-registry";
import type { OpConfig, ActivityStep } from "./op/types";
import { executeTeardown, type TeardownReport } from "./lifecycle/teardown";

/**
 * Which `nativeApply` target deploys each lexicon's built output. Only these
 * lexicons have a native apply mechanism; an output from any other lexicon
 * (helm values, a CI pipeline file, …) is returned to the caller but not
 * applied — deploying it is not what a live-stack test means by "deploy".
 */
const APPLY_TARGETS: Record<string, string> = {
  aws: "cloudformation",
  k8s: "kubectl",
  azure: "arm",
  gcp: "gcp",
  fly: "fly",
};

export interface DeployStackOptions {
  /** The chant project directory (where the infra source lives). */
  dir: string;
  /**
   * Explicit environment name. Overrides the default `test-<suite>-<nonce>`
   * derivation — for a shared long-lived test environment, or a test that
   * needs a deterministic name. Must be legal for the project's declared
   * `environments`, exactly as `--env` would be.
   */
  env?: string;
  /**
   * Suite name folded into the default environment name. Defaults to the
   * project directory's basename.
   */
  suite?: string;
  /** Build parameters, exactly as `--param name=value` flags would supply them. */
  params?: Record<string, BuildParamValue>;
  /**
   * Loaded lexicon plugins. Defaults to loading the project's own declared/
   * detected lexicons — pass this only to substitute test doubles.
   */
  plugins?: LexiconPlugin[];
  /** Activity implementations for the apply. Defaults to the real registry. */
  activities?: Map<string, ActivityFn>;
  /** Activity profiles (timeouts/retries). Defaults to the lexicon-declared table. */
  profiles?: Record<string, ActivityProfile>;
  /**
   * Extra lexicon-name → `nativeApply` target entries, merged over the
   * built-in map (aws → cloudformation, k8s → kubectl, azure → arm,
   * gcp → gcp, fly → fly). A seam for tests and out-of-tree lexicons.
   */
  applyTargets?: Record<string, string>;
}

/** The handle a suite holds between `beforeAll` and `afterAll`. */
export interface DeployedStack {
  /** The built outputs, keyed by lexicon — what was deployed. */
  outputs: Map<string, string | SerializerResult>;
  /** The discovered entities, keyed by name. */
  entities: Map<string, Declarable>;
  /** The environment this deploy targeted — the teardown key. */
  env: string;
  /**
   * Tear down everything carrying this suite's marker `{ stack, env }`.
   * Throws {@link TeardownIncompleteError} when any candidate failed to
   * delete or the plan had holes — an environment that cannot be called
   * clean is a test failure, never a silent leak. Safe to call again:
   * teardown is stateless, and a second call over a clean environment
   * plans nothing.
   */
  destroy(): Promise<TeardownReport>;
}

/**
 * Thrown by {@link DeployedStack.destroy} when the environment cannot be
 * called clean: candidates still `failed` after the retry pass, or the plan
 * had holes (#1089 — parts of the estate could not be read, so "nothing
 * left" would be a claim about what was readable, not about the environment).
 * Carries the full report for diagnosis.
 */
export class TeardownIncompleteError extends Error {
  constructor(public readonly report: TeardownReport) {
    const failed = report.outcomes.filter((o) => o.outcome === "failed");
    const parts: string[] = [];
    if (failed.length > 0) {
      parts.push(
        `${failed.length} candidate(s) failed to delete: ` +
          failed.map((o) => `${o.lexicon}/${o.name}${o.detail ? ` (${o.detail})` : ""}`).join(", "),
      );
    }
    if (report.plan.holes.length > 0) {
      parts.push(
        `${report.plan.holes.length} hole(s) — resources chant may own but could not read: ` +
          report.plan.holes.map((h) => `${h.lexicon}/${h.name} (${h.reason})`).join(", "),
      );
    }
    super(`teardown of "${report.environment}" is incomplete — ${parts.join("; ")}`);
    this.name = "TeardownIncompleteError";
  }
}

/**
 * The default environment name for one suite run: `test-<suite>-<nonce>`.
 * The `test-` prefix is what a project's `"test-*"` pattern entry (#1221)
 * legalizes; the nonce keeps parallel CI jobs of the same suite apart.
 */
export function testEnvName(suite: string): string {
  const slug =
    suite
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "suite";
  const nonce = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `test-${slug}-${nonce}`;
}

/** JSON output starts with a brace/bracket; everything else is written as YAML. */
function outputExtension(content: string): string {
  const head = content.trimStart();
  return head.startsWith("{") || head.startsWith("[") ? ".json" : ".yaml";
}

/**
 * Write each lexicon's built output to a scratch directory and return the
 * primary file path per lexicon. Secondary files (a multi-file serializer
 * result) land beside the primary under their own names.
 */
function writeOutputs(outputs: Map<string, string | SerializerResult>, env: string): Map<string, string> {
  const dir = mkdtempSync(join(tmpdir(), `chant-testing-${env}-`));
  const paths = new Map<string, string>();
  for (const [lexicon, output] of outputs) {
    const primary = typeof output === "string" ? output : output.primary;
    const path = join(dir, `${lexicon}${outputExtension(primary)}`);
    writeFileSync(path, primary);
    if (typeof output !== "string" && output.files) {
      for (const [name, content] of Object.entries(output.files)) {
        writeFileSync(join(dir, basename(name)), content);
      }
    }
    paths.set(lexicon, path);
  }
  return paths;
}

/**
 * Deploy a live instance of the project in `dir` for one test suite.
 *
 * Build (the CLI's own config resolution: `buildParams`, ownership marker,
 * build roots) + additive apply (one `nativeApply` per built output with a
 * native mechanism, via the local Op executor). Returns the handle the suite
 * holds: outputs, entities, the environment name, and `destroy`.
 *
 * The ownership marker stamped on every resource is `{ stack: ownership.stack,
 * env: <this deploy's environment> }` — the marker env always follows the
 * suite environment, whatever `ownership.env` in config says, because the
 * marker is the only thing `destroy()` selects on. A project with no
 * `ownership.stack` is refused up front: a deploy that stamps nothing is a
 * deploy nothing can sweep.
 *
 * Failures are thrown, never returned: build errors, unresolved parameters,
 * an illegal environment name, and a failed apply (the local executor's
 * `OpRunFailure`) all reject the returned promise.
 */
export async function deployStack(options: DeployStackOptions): Promise<DeployedStack> {
  const dir = resolve(options.dir);
  const { config, configPath } = await loadChantConfigUpward(dir);

  const env = options.env ?? testEnvName(options.suite ?? basename(dir));
  const envError = unknownEnvError(env, config.environments);
  if (envError) {
    throw new Error(
      `${envError} The harness derives per-run environment names — declare a "test-*" pattern entry ` +
        `in chant.config.ts's environments to legalize them (#1221).`,
    );
  }

  const stack = resolveOwnershipStack(config);
  if (stack === undefined) {
    throw new Error(
      `${dir}: this project declares no ownership.stack — the harness's destroy() is marker-scoped ` +
        `and would have nothing to select on. Set ownership: { stack: "<name>" } in chant.config.ts.`,
    );
  }
  const marker: OwnershipMarker = { stack, env };

  const plugins = options.plugins ?? (await loadPlugins(await resolveProjectLexicons(dir)));

  // Build parameters, resolved as `chant build --param ...` resolves them.
  // A project whose config maps `env` to a build parameter gets this deploy's
  // environment automatically, unless the caller passed one explicitly.
  const cli: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.params ?? {})) cli[name] = String(value);
  if (config.buildParams && "env" in config.buildParams && !("env" in cli)) cli.env = env;
  const resolution = resolveBuildParams(config.buildParams, { cli, env: process.env });
  if (resolution.errors.length > 0) {
    throw new Error(`${dir}: build parameters did not resolve —\n  ${resolution.errors.join("\n  ")}`);
  }

  const projectRoot = configPath ? resolve(configPath, "..") : dir;
  const configRecord = config as unknown as Record<string, unknown>;

  // Env-aware source branches on env() (#505) during discovery — scope the
  // variable to the build and restore whatever the shell had.
  const priorEnv = process.env[ENV_VAR];
  let result;
  try {
    process.env[ENV_VAR] = env;
    result = await build(dir, plugins.map((p) => p.serializer), undefined, {
      ownership: marker,
      config: configRecord,
      lexicons: plugins.map((p) => p.name),
      intrinsics: plugins.flatMap((p) => p.intrinsics?.() ?? []),
      buildParams: resolution.provenance,
      buildRoots: collectBuildRootContributors(plugins, configRecord, projectRoot),
    });
  } finally {
    if (priorEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = priorEnv;
  }
  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => e.message);
    throw new Error(`${dir}: build failed —\n  ${messages.join("\n  ")}`);
  }

  // One additive apply step per built output with a native mechanism.
  const targets = { ...APPLY_TARGETS, ...options.applyTargets };
  const paths = writeOutputs(result.outputs, env);
  const steps: ActivityStep[] = [];
  for (const [lexicon, path] of paths) {
    const target = targets[lexicon];
    if (!target) continue;
    steps.push({
      kind: "activity",
      fn: "nativeApply",
      args: { target, env, output: path, deleteMode: "never" },
      profile: "longInfra",
    });
  }
  if (steps.length === 0) {
    throw new Error(
      `${dir}: nothing to deploy — no built output has a native apply target ` +
        `(built: ${[...result.outputs.keys()].join(", ") || "none"}; targets exist for: ${Object.keys(targets).join(", ")}).`,
    );
  }
  const op: OpConfig = {
    name: `deploy-${env}`,
    overview: `test harness deploy of ${dir} into ${env}`,
    phases: [{ name: "Deploy", steps }],
  };

  const activities = options.activities ?? (await loadActivities(plugins.map((p) => p.name)));
  const profiles = options.profiles ?? (await loadProfiles());

  // The environment's declared endpoint (#1166) applies to the deploy the way
  // it applies to a --live read — and ambient always wins, so exported
  // `chant emulator up --json` vars take precedence.
  const applied = applyLiveEndpoint(config.environments, env, plugins);
  try {
    await runOpLocally(op, activities, profiles);
  } finally {
    applied.restore();
  }

  const destroy = async (): Promise<TeardownReport> => {
    const endpointForTeardown = applyLiveEndpoint(config.environments, env, plugins);
    let report: TeardownReport;
    try {
      report = await executeTeardown({ environment: env, stack, plugins });
    } finally {
      endpointForTeardown.restore();
    }
    const failed = report.outcomes.some((o) => o.outcome === "failed");
    if (failed || report.plan.holes.length > 0) throw new TeardownIncompleteError(report);
    return report;
  };

  return { outputs: result.outputs, entities: result.entities, env, destroy };
}
