import { realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { bundleDriver } from "./bundle";
import { generateConfigDriverSource } from "./driver";
import { formatConfigWireOffenders, type ConfigWireOffender } from "./config-wire";
import { forkSandboxed } from "./fork";
import { ENV_VAR } from "../../env";

/**
 * chant #1113 — evaluates a project's `chant.config.ts` inside the same
 * sandboxed child `--sandbox` already uses for run-fallback source, and brings
 * back plain JSON.
 *
 * This closes the residual chant #1093 documented and #1113 filed: `loadConfig`
 * imported the project's own `chant.config.ts` into the CLI process, so a
 * hostile repo's config executed with full CLI trust even under `--sandbox`.
 * The config is project-authored code like any other file in the repo; the
 * only reason it was ever treated differently is that the CLI has to read it
 * before it knows anything else about the project.
 *
 * Deliberately the same machinery, not a parallel one:
 *  - `./bundle.ts` bundles the generated driver (`./driver.ts`'s
 *    `generateConfigDriverSource`) with esbuild, so the child needs no runtime
 *    module resolution and no TypeScript loader.
 *  - `./fork.ts` spawns it with the identical `--permission` profile
 *    `runFallbackFilesSandboxed` uses — one function, so the two cannot drift.
 *  - `./child-errors.ts` classifies whatever it throws, so a permission denial
 *    names the config file instead of leaking `ERR_ACCESS_DENIED`.
 *
 * The one deliberate difference from the run-fallback child is `CHANT_ENV`.
 * `../../cli/main.ts` sets it from `--env` *before* loading the config,
 * specifically because a config may branch on the environment; dropping it
 * would silently produce a different configuration under `--sandbox` than
 * without. It is a value the user typed on the command line, not an ambient
 * secret, so forwarding exactly that one key — and nothing else from
 * `process.env` — keeps the scrub meaningful while keeping `--env` honest.
 */

/** How long to wait for the config child. A config is one small module; anything approaching this is hung, not slow. */
const CONFIG_CHILD_TIMEOUT_MS = 60_000;

interface ConfigChildResponse {
  kind: "chant-config";
  ok: boolean;
  config?: unknown;
  offenders?: ConfigWireOffender[];
  error?: { name: string; file: string; message: string; type: string };
}

function isConfigChildResponse(value: unknown): value is ConfigChildResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "chant-config" &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

export interface SandboxConfigResult {
  /** The evaluated configuration, as plain JSON. Interpreted (default/config/namespace selection already applied in the child; Zod validation still to come) by `../../config.ts`'s `normalizeConfig`, in the parent, unchanged. */
  config: unknown;
  /** esbuild bundling wall-clock time. */
  bundleMs: number;
  /** Bundle size in bytes. */
  bundleBytes: number;
}

/**
 * Evaluate `configPath` in a sandboxed child and return its configuration as
 * plain data.
 *
 * Throws — rather than degrading to an in-process import or to defaults — when
 * the config cannot be evaluated inside the boundary or cannot cross it as
 * JSON. Under `--sandbox` a config that "almost" loaded is not a safe thing to
 * proceed with, and quietly falling back would give away the property the flag
 * exists to provide.
 *
 * @param configPath - Absolute path to the project's `chant.config.ts`.
 * @param projectRoot - Directory the child is granted `--allow-fs-read` for
 *   (the config's own project root, i.e. `findProjectConfig`'s `dir`).
 */
export async function evaluateConfigSandboxed(
  configPath: string,
  projectRoot: string,
): Promise<SandboxConfigResult> {
  const driverSource = generateConfigDriverSource(configPath);
  const { bundlePath, bundleDir, externalReadPaths, durationMs, bytes } = await bundleDriver(driverSource);

  try {
    let projectRealpath: string;
    try {
      projectRealpath = realpathSync(resolve(projectRoot));
    } catch {
      projectRealpath = resolve(projectRoot);
    }

    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    // See the module doc: the one forwarded variable, and only when set.
    const activeEnv = process.env[ENV_VAR];
    if (activeEnv) env[ENV_VAR] = activeEnv;

    const response = await forkSandboxed(
      {
        bundlePath,
        bundleDir,
        projectRealpath,
        externalReadPaths,
        env,
        timeoutMs: CONFIG_CHILD_TIMEOUT_MS,
        label: `sandboxed evaluation of ${configPath}`,
        // chant #1148 — the config's own console.log/error no longer goes
        // nowhere; see `./fork.ts`'s `outputPrefix` doc.
        outputPrefix: "[sandbox:config]",
      },
      isConfigChildResponse,
    );

    if (!response.ok) {
      if (response.offenders && response.offenders.length > 0) {
        throw new Error(formatConfigWireOffenders(configPath, response.offenders));
      }
      throw new Error(
        response.error?.message
          ? `Failed to evaluate ${configPath} inside the --sandbox boundary: ${response.error.message}`
          : `Failed to evaluate ${configPath} inside the --sandbox boundary`,
      );
    }

    return { config: response.config ?? {}, bundleMs: durationMs, bundleBytes: bytes };
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}
