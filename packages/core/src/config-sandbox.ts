import { dirname } from "node:path";
import { importConfigModule, requireConfigModule, type ConfigModuleNamespace } from "./config-import";

/**
 * chant #1113 — decides WHERE a project's `chant.config.ts` is evaluated.
 *
 * `chant.config.ts` is project-authored code. Every other piece of project
 * source moved behind the `--sandbox` boundary in chant #1045 (run-fallback
 * files) and #1093 (composite factories, constructors, intrinsic tags), and
 * both PRs had to document the config file as a remaining hole: the CLI reads
 * its configuration by importing it, in-process, before it knows anything else
 * about the project. This module closes it.
 *
 * ## Why an armed process mode rather than a threaded option
 *
 * Config is loaded from a dozen call sites (`../cli/main.ts` before command
 * dispatch, `./cli/plugins.ts`'s `resolveProjectLexicons`,
 * `./cli/commands/build.ts`, `./lint/policy.ts`, every lifecycle handler …).
 * Threading a `sandbox` option to each one is fail-OPEN: miss a site and
 * project code executes in the CLI process with nothing to notice it. Arming
 * the process once, from the `--sandbox` flag, before any config load happens,
 * is fail-CLOSED — a call site that nobody remembered still routes through the
 * child.
 *
 * ## The bootstrap limit, stated plainly
 *
 * `chant.config.ts`'s own `build.sandbox: true` **cannot** sandbox its own
 * evaluation. Reading that field requires evaluating the file, so by the time
 * chant knows the project asked for sandboxing, the project's code has already
 * run. Only `--sandbox` on the command line — known from `parseArgs`, before
 * any config is touched — arms this. `chant build` warns when sandboxing was
 * enabled by config alone, rather than letting the difference stay invisible.
 * (A `chant.config.json` project has no such limit: JSON is data, parsed and
 * never executed, so `build.sandbox: true` there is fully honest.)
 *
 * ## Memoization
 *
 * Armed loads are memoized per config path for the life of the process. That
 * is not an optimization detail with a semantic cost: the unarmed path is
 * already memoized by Node's own ESM registry (`await import()` evaluates a
 * given config file once per process, so `chant build --watch` has never
 * re-read a config mid-session either). Matching that keeps the two paths
 * behaviorally identical while keeping a build to one bundle+fork instead of
 * one per call site.
 */

/** Whether this process must evaluate project configs inside the sandbox boundary. */
let armed = false;

/** Armed-mode results, keyed by absolute config path. See the module doc on why this matches unarmed behavior rather than diverging from it. */
const memo = new Map<string, unknown>();

/**
 * Arm sandboxed config evaluation for the rest of this process. Called from
 * `../cli/main.ts` immediately after `parseArgs`, when `--sandbox` was passed
 * — before the first config load. Idempotent; there is deliberately no
 * disarm, because a security mode that can be turned off partway through a
 * process is not one.
 */
export function armSandboxConfigEvaluation(): void {
  armed = true;
}

/** Whether {@link armSandboxConfigEvaluation} has been called. */
export function isSandboxConfigEvaluationArmed(): boolean {
  return armed;
}

/**
 * Test-only reset. Vitest gives each test file its own module registry, so
 * this exists for suites that arm and disarm within one file.
 */
export function resetSandboxConfigEvaluationForTests(): void {
  armed = false;
  memo.clear();
}

/**
 * The export a config module's configuration lives on: an explicit `default`,
 * a named `config`, else the module namespace itself (a config authored as a
 * set of top-level named exports). Applied identically on both sides of the
 * boundary — in the child by `./discovery/sandbox/driver.ts`'s config driver,
 * here for the in-process path — so `--sandbox` changes only where the file is
 * evaluated, never how its result is read.
 */
export function selectConfigExport(namespace: ConfigModuleNamespace): unknown {
  return namespace.default ?? namespace.config ?? namespace;
}

/**
 * Evaluate a project's `chant.config.ts` and return its configuration object,
 * pre-`normalizeConfig`. Sandboxed when armed, in-process otherwise.
 *
 * @param configPath - Absolute path to the config file.
 * @param projectRoot - Directory to grant the sandboxed child read access to;
 *   defaults to the config file's own directory.
 */
export async function evaluateProjectConfig(
  configPath: string,
  projectRoot: string = dirname(configPath),
): Promise<unknown> {
  if (!armed) {
    return selectConfigExport(await importConfigModule(configPath));
  }

  if (memo.has(configPath)) return memo.get(configPath);

  // Dynamic, not static, for the same reason `./discovery/index.ts` imports
  // `./sandbox/run` dynamically: this pulls in `esbuild`, a large CJS package
  // no unsandboxed build should pay to load.
  const { evaluateConfigSandboxed } = await import("./discovery/sandbox/config-run");
  const { config } = await evaluateConfigSandboxed(configPath, projectRoot);
  memo.set(configPath, config);
  return config;
}

/**
 * Synchronous counterpart for `./lint/config.ts`'s `loadConfig` (`chant lint`
 * is a sync pipeline and predates the async loader).
 *
 * When armed, this cannot spawn a child — so it uses the result of an earlier
 * armed load of the same file, and refuses if there isn't one. In practice
 * there always is: `../cli/main.ts` loads the project config before dispatching
 * to any command. Refusing rather than falling back to an in-process `require`
 * is the point — a sync call site is exactly where a boundary would otherwise
 * be lost by accident.
 */
export function evaluateProjectConfigSync(configPath: string, dir: string): unknown {
  if (!armed) {
    return selectConfigExport(requireConfigModule(configPath, dir));
  }

  if (memo.has(configPath)) return memo.get(configPath);

  throw new Error(
    `Cannot read ${configPath} synchronously under --sandbox: it has not yet been evaluated inside the boundary, and evaluating it here would run project code in the chant process. This is a chant bug — the project config should have been loaded before this point.`,
  );
}
