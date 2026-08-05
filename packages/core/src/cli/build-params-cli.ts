import { readFileSync } from "fs";
import { resolve } from "path";
import { resolveBuildParams, type BuildParamsConfig } from "../build-params";
import type { BuildParamProvenance } from "../provenance";
import { formatError, formatInfo } from "./format";

/**
 * Shared CLI-layer wiring for chant #1064's build-time parameters, factored
 * out (chant #1108) so every command that discovers project source before
 * running it resolves `chant.config.ts`'s declared `buildParams` the exact
 * same way: `chant build` (`../commands/build.ts`'s `buildCommand`), the
 * component deploy driver (`./handlers/run.ts`'s `chant run --components`
 * local + `--temporal` paths), and generate mode (`./handlers/build.ts`'s
 * `chant build --components --generate <lexicon>`).
 *
 * Before #1108, only `buildCommand` ran this sequence — `chant run
 * --components` never resolved `--param`/`--params-file`/a declared `env`
 * mapping at all, so a `*.component.ts` file reading `params.<name>`
 * (`@intentius/chant/params`) always saw `{}`, no matter what a CI job
 * exported into the environment. See ../build-params.ts's module doc for the
 * full precedence rules this wraps.
 */

/** Parse repeated `--param name=value` flags into a flat `{ name: value }` record — the raw (unvalidated) strings {@link resolveCliBuildParams} resolves against a project's declared `buildParams`. `undefined` when no `--param` flag was given, matching `resolveBuildParams`'s "no cli input" shape. */
export function parseParamFlags(entries?: string[]): Record<string, string> | undefined {
  if (!entries?.length) return undefined;
  return Object.fromEntries(
    entries.map((entry) => {
      const eq = entry.indexOf("=");
      return eq === -1 ? [entry, ""] : [entry.slice(0, eq), entry.slice(eq + 1)];
    }),
  );
}

/** Inputs {@link resolveCliBuildParams} needs from a parsed CLI invocation — the `--param`/`--params-file` half of {@link resolveBuildParams}'s `BuildParamsInput` (the `env` half is always `process.env`, resolved internally). */
export interface CliBuildParamsArgs {
  /** Already-parsed `--param name=value` flags (see {@link parseParamFlags}), or the CLI's already-typed `Record<string,string>` (`chant build`'s own flag parsing does this itself — see `./handlers/build.ts`). */
  cli?: Record<string, string>;
  /** `--params-file <path>` — a JSON file of `{ "name": value }` values, read and parsed here. */
  paramsFile?: string;
}

export interface CliBuildParamsResolution {
  success: boolean;
  /** Every successfully resolved parameter. Empty when the project declares none, or when `success` is `false`. */
  provenance: BuildParamProvenance[];
  /** `formatError`-wrapped messages, ready to print as-is. Empty when `success` is `true`. */
  errors: string[];
}

/**
 * Resolve this invocation's declared build-time parameters (`chant.config.ts`'s
 * `buildParams`) against `args`/the process environment, and log each
 * resolved value — the identical resolution + logging sequence `chant build`
 * runs (`../commands/build.ts`'s `buildCommand`), factored out so every other
 * command that discovers project source runs it too (chant #1108).
 *
 * A resolution failure (an unknown `--param`/`--params-file` name, a missing
 * required value, a type/enum mismatch, or an unreadable `--params-file`) is
 * returned as `{ success: false, errors }` — never thrown — so the caller can
 * print each message and exit non-zero exactly like a build error, matching
 * chant #1064's acceptance criterion that this never surfaces as a thrown
 * error from inside user source.
 *
 * On success, every resolved parameter is logged via `console.error` as
 * `[param] <name> = <value> (<source>)` — unconditional, not gated on
 * `--verbose`, so a build's environment-varying inputs are always visible,
 * the same way #1022's fold decisions are.
 */
export function resolveCliBuildParams(
  buildParamsConfig: BuildParamsConfig | undefined,
  args: CliBuildParamsArgs,
): CliBuildParamsResolution {
  const errors: string[] = [];

  let fromFile: Record<string, unknown> | undefined;
  if (args.paramsFile) {
    try {
      fromFile = JSON.parse(readFileSync(resolve(args.paramsFile), "utf-8"));
    } catch (err) {
      errors.push(
        formatError({
          message: `Failed to read/parse --params-file "${args.paramsFile}": ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
    }
  }

  const resolution = resolveBuildParams(buildParamsConfig, {
    cli: args.cli,
    fromFile,
    env: process.env,
  });
  for (const message of resolution.errors) {
    errors.push(formatError({ message }));
  }

  if (errors.length > 0) {
    return { success: false, provenance: [], errors };
  }

  for (const p of resolution.provenance) {
    console.error(formatInfo(`[param] ${p.name} = ${JSON.stringify(p.value)} (${p.source})`));
  }

  return { success: true, provenance: resolution.provenance, errors: [] };
}

/**
 * Resolve a command's declared build-time parameters, the same way `chant
 * build` does, so a `build()`/`discover()` on the declared side sees the values
 * the source will actually read.
 *
 * Every command that reads declared source needs this and only `chant build`
 * had it. `chant graph` was fixed in #1483; the lifecycle family — `diff`,
 * `snapshot`, `plan`, and `components status --live` — built the declared side
 * on parameter *defaults* while the live side was whatever is really deployed.
 *
 * For a project whose parameters choose which resources *exist* that is not a
 * near miss. `chant lifecycle diff dev --live` on kubemicrovm-ops returned
 * byte-identical output at `KMV_TIER=minimal` and `KMV_TIER=prod-ha`, and
 * reported the tier label itself as drift — `minimal → prod-ha`, declared
 * against live — which is the comparison announcing it is against the wrong
 * declaration.
 *
 * Returns `undefined` when resolution failed, having printed why: the caller
 * should stop rather than compare against source that will not build.
 */
export async function commandBuildParams(
  buildParamsConfig: BuildParamsConfig | undefined,
  args: { param?: string[]; paramsFile?: string },
): Promise<BuildParamProvenance[] | undefined> {
  const resolution = resolveCliBuildParams(buildParamsConfig, {
    cli: parseParamFlags(args.param),
    paramsFile: args.paramsFile,
  });
  if (!resolution.success) {
    for (const message of resolution.errors) console.error(message);
    return undefined;
  }
  return resolution.provenance;
}
