/**
 * Build-time parameters from workspace flags (#4024, decided in #4016).
 *
 * A member of a workspace may have flag records: records of a kind with a
 * `flag` block, each naming the member, one of its declared build
 * parameters and a value per environment (`workspace/flags.ts`). A build
 * for an environment (`chant build --env <env>`, `chant run --components
 * --env <env>`, and each environment a release cut compiles) reads them, and
 * a flag-backed parameter takes the flag's value for that environment,
 * recorded as `source: "flag:<name>"` on `BuildResult.buildParams` and on the
 * release target's `params`.
 *
 * The precedence rule: where the environment has a gate, `--param`,
 * `--params-file` and the parameter's env var can't set a flag-backed
 * parameter, and the build refuses. An environment has a gate when a
 * component enabled in it declares a gate step, the same test `components
 * promote --release` uses to bind a release gate. The test runs only when one
 * of those sources did set a flag-backed parameter, since it imports the
 * member's components; a project with no components has no gate.
 *
 * Level 0 pays one upward `existsSync` walk here and nothing more. Workspace
 * code is imported only once a declaration is found (#2525 rule 5, pinned by
 * #2526's goldens).
 */

import { findWorkspaceRoot } from "./project-root";
import { flagGateRefusal, type BuildParamFlags, type BuildParamsConfig } from "./build-params";
import type { BuildParamProvenance } from "./provenance";
import { echoBuildParams, resolveCliBuildParams, type CliBuildParamsArgs, type CliBuildParamsResolution } from "./cli/build-params-cli";
import { formatError } from "./cli/format";

/** The flags backing parameters of the member at `projectDir` in `env`, or why they can't be read. `flags` is undefined outside a workspace, without an environment, or when no flag names the member. */
export async function loadBuildParamFlags(projectDir: string, env: string | undefined): Promise<{ flags: BuildParamFlags | undefined; errors: string[] }> {
  if (!env) return { flags: undefined, errors: [] };
  const found = findWorkspaceRoot(projectDir);
  if (!found) return { flags: undefined, errors: [] };
  const { memberFlagBindings } = await import("./workspace/flags-read");
  try {
    const bindings = await memberFlagBindings(found.dir, projectDir, env);
    if (!bindings) return { flags: undefined, errors: [] };
    if (bindings.errors.length > 0) return { flags: undefined, errors: bindings.errors };
    if (Object.keys(bindings.byParam).length === 0) return { flags: undefined, errors: [] };
    return { flags: { env, byParam: bindings.byParam }, errors: [] };
  } catch (err) {
    const { WorkspaceReadError } = await import("./workspace/declaration");
    const { RecordReadError } = await import("./workspace/records");
    if (err instanceof WorkspaceReadError || err instanceof RecordReadError) {
      return { flags: undefined, errors: [`the workspace's flag records can't be read, so this build can't tell which parameters they set: ${err.message}`] };
    }
    throw err;
  }
}

/** The parameters a flag backs that `--param`, `--params-file` or an env var set instead. */
export function overriddenFlagParams(provenance: readonly BuildParamProvenance[], flags: BuildParamFlags | undefined): BuildParamProvenance[] {
  if (!flags) return [];
  return provenance.filter((p) => flags.byParam[p.name] !== undefined && (p.source === "cli" || p.source === "params-file" || p.source === "env"));
}

/**
 * The gates the member's components declare in the environment the process
 * builds for (`CHANT_ENV`), with the parameters as resolved, or why the
 * components can't be read. Only components enabled under those parameters
 * count.
 */
export async function environmentGates(projectDir: string, provenance: BuildParamProvenance[]): Promise<{ gates: string[] } | { error: string }> {
  const { discoverComponents } = await import("./components/discover");
  const { withoutDisabled } = await import("./components/cli-support");
  const { gateNamesOf } = await import("./components/release-gate");
  try {
    const discovered = await discoverComponents(projectDir, { buildParams: provenance });
    if (discovered.errors.length > 0) return { error: discovered.errors.map((e) => e.message).join("; ") };
    const all = [...discovered.components.values()].map((d) => d.component);
    const plain = all.map((c) => ({ name: c.name, dependsOn: c.dependsOn, deploy: c.deploy as never }));
    return { gates: gateNamesOf(withoutDisabled(all, plain)) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the build parameters of the project at `projectDir` for `env`,
 * with the workspace's flags, as `resolveCliBuildParams` does without them.
 * Refuses when a flag record can't be read, and when `--param`,
 * `--params-file` or an env var sets a flag-backed parameter in an
 * environment with a gate. Prints the summary line only on success.
 */
export async function resolveFlaggedBuildParams(
  projectDir: string,
  buildParamsConfig: BuildParamsConfig | undefined,
  args: CliBuildParamsArgs,
  env: string | undefined,
): Promise<CliBuildParamsResolution> {
  const loaded = await loadBuildParamFlags(projectDir, env);
  if (loaded.errors.length > 0) {
    return { success: false, provenance: [], errors: loaded.errors.map((message) => formatError({ message })) };
  }
  const { flags } = loaded;
  const resolution = resolveCliBuildParams(buildParamsConfig, { ...args, ...(flags ? { flags } : {}), echo: false });
  if (!resolution.success || !flags) {
    if (resolution.success && args.echo !== false) echoBuildParams(resolution.provenance, args.verbose);
    return resolution;
  }
  const overridden = overriddenFlagParams(resolution.provenance, flags);
  if (overridden.length > 0) {
    const found = await environmentGates(projectDir, resolution.provenance);
    if ("error" in found) {
      return {
        success: false,
        provenance: [],
        errors: [
          formatError({
            message:
              `${overridden.map((p) => `"${p.name}"`).join(", ")} ${overridden.length === 1 ? "is" : "are"} backed by a flag and set by ${[...new Set(overridden.map((p) => p.source))].join(", ")}, ` +
              `and whether "${flags.env}" has a gate can't be told, because its components can't be read: ${found.error}`,
          }),
        ],
      };
    }
    if (found.gates.length > 0) {
      const around = (p: BuildParamProvenance): string =>
        p.source === "cli" ? "--param" : p.source === "params-file" ? "--params-file" : `the env var ${buildParamsConfig?.[p.name]?.env ?? "(unknown)"}`;
      return {
        success: false,
        provenance: [],
        errors: overridden.map((p) =>
          formatError({ message: `${flagGateRefusal(p.name, flags.byParam[p.name].flag, flags.env, around(p))} (gates: ${found.gates.join(", ")})` }),
        ),
      };
    }
  }
  if (args.echo !== false) echoBuildParams(resolution.provenance, args.verbose);
  return resolution;
}
