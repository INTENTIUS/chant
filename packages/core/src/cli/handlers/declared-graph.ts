import { dirname } from "node:path";
import { mergeBuildRootEntities } from "../../build";
import { loadChantConfigUpward, type ChantConfig } from "../../config";
import type { Declarable } from "../../declarable";
import { applyLexiconGraphEdges, type GraphIR, type LexiconGraphEdges } from "../../graph-ir";
import type { BuildRootContributor, LexiconPlugin } from "../../lexicon";
import { formatError, formatWarning } from "../format";
import { collectBuildRootContributors, loadPlugins, resolveProjectLexicons } from "../plugins";
import type { CommandContext } from "../registry";

/**
 * The pieces of the declared graph that `chant graph` and `chant search` both
 * read (#1626, #4365, #4368). They live here, once, so the two commands answer
 * over the same entity set and the same edges: search drifted from graph once
 * already, answering `(no matches)` over a `terraform.roots` project graph drew
 * in full, because it never ran the build-root contributors.
 */

/**
 * The build-root contributors this invocation's project configures (#1626):
 * a `terraform.roots` root's blocks, a `k8s.kustomize.roots` root's rendered
 * objects. The same closures `chant build` and the lifecycle handlers hand to
 * `BuildOptions.buildRoots`, bound here for the discover-based paths, which
 * never run `build()` and so never ran the hook.
 *
 * Neither command is `requiresPlugins` (Op/source-graph modes must work
 * without a lexicon), so plugins are loaded here when `ctx.plugins` is empty.
 * Rooted at the config's own directory, like `cli/commands/build.ts`: a
 * relative root resolves against where it was declared, not against a
 * sourceDir-scoped path. A project that fails to load plugins degrades to no
 * contributors with a warning rather than failing modes that never needed
 * plugins at all.
 */
export async function declaredBuildRootContributors(
  ctx: CommandContext,
  projectPath: string,
): Promise<BuildRootContributor[]> {
  const { config, configPath } = await loadChantConfigUpward(projectPath).catch(
    () => ({ config: {} as ChantConfig, configPath: undefined }),
  );
  let plugins = ctx.plugins;
  if (plugins.length === 0) {
    try {
      plugins = await loadPlugins(await resolveProjectLexicons(projectPath));
    } catch (err) {
      console.error(formatWarning({
        message: `could not load the project's lexicons — build-root entities (terraform and kustomize roots) will be missing from the graph (${err instanceof Error ? err.message : String(err)})`,
      }));
      return [];
    }
  }
  return collectBuildRootContributors(
    plugins,
    config as unknown as Record<string, unknown>,
    configPath ? dirname(configPath) : projectPath,
  );
}

/**
 * Merge build-root contributions into a discovered entity set: the exact
 * merge `build()` performs (one implementation: `mergeBuildRootEntities`,
 * ../../build.ts), with its warnings and errors printed. Returns false when a
 * contributor failed or a name collided; the caller stops, because a graph
 * missing the entities the build would refuse over must not be answered from
 * as if complete.
 */
export async function mergeDeclaredBuildRoots(
  entities: Map<string, Declarable>,
  contributors: BuildRootContributor[],
): Promise<boolean> {
  if (contributors.length === 0) return true;
  const merged = await mergeBuildRootEntities(entities, contributors);
  for (const w of merged.warnings) console.error(formatWarning({ message: w }));
  if (merged.errors.length > 0) {
    for (const message of merged.errors) console.error(formatError({ message }));
    return false;
  }
  return true;
}

/**
 * Add the edges the lexicons' `graphEdges` hooks resolve (#3910): CI
 * dependencies written as strings (`needs`, `uses:`, `trigger:`, `include:`,
 * `extends`), which the AttrRef walk in `buildGraphIr` cannot see. A hook that
 * throws costs its own edges and a warning, not the graph.
 */
export function withLexiconEdges(ir: GraphIR, plugins: readonly LexiconPlugin[], entities: Map<string, Declarable>): GraphIR {
  const reports: LexiconGraphEdges[] = [];
  for (const p of plugins) {
    if (!p.graphEdges) continue;
    try {
      const report = p.graphEdges(entities);
      if (report) reports.push(report);
    } catch (err) {
      console.error(formatWarning({ message: `the ${p.name} lexicon's graphEdges failed (${err instanceof Error ? err.message : String(err)}); its edges are left out` }));
    }
  }
  return reports.length === 0 ? ir : applyLexiconGraphEdges(ir, reports);
}
