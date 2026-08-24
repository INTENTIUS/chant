/**
 * `envTeardown` — the durable form of `chant lifecycle teardown <env> --yes`
 * (#1222).
 *
 * Wraps core's {@link executeTeardown}: enumerate the live resources whose
 * ownership marker carries this project's `ownership.stack` + the requested
 * environment, delete them through each lexicon's `executeTeardown`
 * capability, run core's one bounded retry pass, and fail the activity loudly
 * when any candidate is still `failed` afterwards. Selection is marker-scoped
 * by construction — the same engine the CLI verb drives, reached in-process
 * rather than through a shell.
 *
 * The guards are the CLI's guards, unchanged:
 * - an environment the project does not declare is refused;
 * - a project with no `ownership.stack` is refused — teardown has nothing to
 *   select on;
 * - a production-like environment name (`prod`, `production`, `prod-eu`, ...)
 *   is refused unless the step's args carry an explicit `confirmProd: true`.
 *   An Op is non-interactive, so there is no re-type-the-name prompt to fall
 *   back to — the confirmation must be authored into the Op.
 *
 * All three refusals throw before any live read, so a refused teardown
 * touches nothing at all. They are configuration errors, not transient ones —
 * a Temporal retry cannot make `prod` stop looking like production.
 *
 * Distinct from {@link chantTeardown} (`npm run teardown`), which runs
 * whatever script a project wired under that name. This activity is
 * product-agnostic: it imports core only, and core reaches each product
 * through the lexicons the project configures.
 */

import { resolve } from "node:path";
import { loadChantConfig, resolveOwnershipStack, type ChantConfig } from "@intentius/chant/config";
import { unknownEnvError, isProdLikeEnvironment } from "@intentius/chant/env";
import { applyLiveEndpoint } from "@intentius/chant/live-endpoint";
import { executeTeardown, type TeardownReport } from "@intentius/chant/lifecycle/teardown";
import type { ObservationLexicon } from "@intentius/chant/lexicon";

export interface EnvTeardownArgs {
  /** The environment to tear down — the marker env core selects on. */
  env: string;
  /**
   * Required (as an explicit `true`) when `env` looks production-like.
   * The Op's counterpart of the CLI's `--confirm-prod`: activities never
   * prompt, so the confirmation is authored, reviewed, and versioned with
   * the Op instead.
   */
  confirmProd?: boolean;
  /** Path to the chant project (where chant.config.ts lives). Default: the worker's cwd. */
  path?: string;
}

/** What a completed (fully successful) teardown reports back to the workflow. */
export interface EnvTeardownResult {
  environment: string;
  /** The ownership stack everything was selected on. */
  stack: string;
  deleted: number;
  /** Deliberately refused by a lexicon, with the reason in the report. */
  notPrunable: number;
  /** Planned candidates whose lexicon implements no execution yet. */
  skipped: number;
  /** Kinds that could not be read (#1089) — the plan was incomplete, not clean. */
  holes: number;
  /** The full per-candidate report core produced. */
  report: TeardownReport;
}

/** Injectable seams for testing — production loads both from the project. */
export interface EnvTeardownDeps {
  /** Pre-loaded project config (skips reading chant.config.ts). */
  config?: ChantConfig;
  /** Pre-loaded lexicon plugins (skips resolving + importing lexicon packages). */
  plugins?: ObservationLexicon[];
}

/**
 * Load the project's lexicon plugins through core's own resolution: the
 * `lexicons` list in chant.config, falling back to source-file detection.
 * A dynamic import so this module does not pull the whole CLI surface in at
 * load time — the registry imports every activity module eagerly.
 */
async function loadProjectPlugins(projectPath: string): Promise<ObservationLexicon[]> {
  const { loadPlugins, resolveProjectLexicons } = await import("@intentius/chant/cli/plugins");
  return loadPlugins(await resolveProjectLexicons(projectPath));
}

/**
 * Tear down one environment's marker-owned resources through the core
 * teardown engine. Uses the `longInfra` profile — deletion waits on the
 * target's own pace. Safe to retry: the engine re-plans from live markers on
 * every run, and a resource already gone is simply no longer a candidate.
 */
export async function envTeardown(
  args: EnvTeardownArgs,
  _signal?: AbortSignal,
  deps?: EnvTeardownDeps,
): Promise<EnvTeardownResult> {
  const projectPath = resolve(args.path ?? ".");
  const config = deps?.config ?? (await loadChantConfig(projectPath)).config;

  // Refuse an env the project does not declare — a typo here is the
  // difference between tearing down `dev` and tearing down `prod`.
  const envErr = unknownEnvError(args.env, config.environments);
  if (envErr) throw new Error(`envTeardown: ${envErr}`);

  // Teardown selects on the ownership marker; a project that stamps none has
  // nothing to key on, and "delete what looks like mine" is not a fallback.
  const stack = resolveOwnershipStack(config);
  if (stack === undefined) {
    throw new Error(
      "envTeardown: this project declares no ownership.stack — teardown is marker-scoped and has nothing to select on. " +
        'Set `ownership: { stack: "<name>" }` in chant.config.ts and deploy, so resources carry the marker teardown keys on.',
    );
  }

  // The prod guard (#1222). Checked before any live read, so a refused
  // teardown touches nothing at all.
  if (isProdLikeEnvironment(args.env) && args.confirmProd !== true) {
    throw new Error(
      `envTeardown: "${args.env}" looks like a production environment — ` +
        "add `confirmProd: true` to the envTeardown step's args to tear it down from an Op.",
    );
  }

  const plugins = deps?.plugins ?? (await loadProjectPlugins(projectPath));

  // #1166 — teardown is a live read and a live write, so an environment's
  // declared endpoint applies here too, unless the ambient shell already set it.
  const reading = plugins.filter((p) => p.teardownOwned || p.describeResources || p.executeTeardown);
  const endpoint = applyLiveEndpoint(config.environments, args.env, reading);
  if (endpoint.notice) console.log(endpoint.notice);

  let report: TeardownReport;
  try {
    report = await executeTeardown({ environment: args.env, stack, plugins });
  } finally {
    endpoint.restore();
  }

  const count = (outcome: string) => report.outcomes.filter((o) => o.outcome === outcome).length;
  const deleted = count("deleted");
  const failed = report.outcomes.filter((o) => o.outcome === "failed");
  const notPrunable = count("not-prunable");
  const skipped = count("skipped");

  console.log(
    `envTeardown ${args.env} (stack ${stack}): ${deleted} deleted, ${failed.length} failed, ` +
      `${notPrunable} not-prunable, ${skipped} skipped, ${report.plan.holes.length} hole(s)`,
  );

  // Failures that survived core's bounded retry pass fail the activity —
  // silence is never success, and the workflow decides what a failed
  // teardown means for the run.
  if (failed.length > 0) {
    const names = failed.map((o) => `${o.lexicon}/${o.name}${o.detail ? ` (${o.detail})` : ""}`).join(", ");
    throw new Error(
      `envTeardown: ${failed.length} of ${report.outcomes.length} candidate(s) still failed after the retry pass: ${names}`,
    );
  }

  return {
    environment: args.env,
    stack,
    deleted,
    notPrunable,
    skipped,
    holes: report.plan.holes.length,
    report,
  };
}
