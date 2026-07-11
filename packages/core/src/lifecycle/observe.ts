/**
 * Live observation without persistence — call each plugin's `describeResources()`
 * for an environment and collect the results as `LiveObservation[]`, ready to
 * project into the graph IR (`buildLiveGraphIr`, ../graph-ir.ts) for
 * `chant graph --live`.
 *
 * This is the read half of what `takeSnapshot` (./snapshot.ts) does before it
 * validates + writes to git: same per-plugin build-output/entities assembly, no
 * side effects. Snapshotting keeps its own copy for now; a future refactor can
 * fold both onto this primitive.
 */
import type { ObservationLexicon, ResourceMetadata } from "../lexicon";
import type { BuildResult } from "../build";
import type { SerializerResult } from "../serializer";
import type { LiveObservation } from "../graph-ir";

export interface ObserveResult {
  observations: LiveObservation[];
  warnings: string[];
  errors: string[];
}

/**
 * Query every plugin that implements `describeResources` for its resources in
 * `environment`. `owned` (default true for the managed-only diagram, epic #776)
 * restricts to resources carrying chant's ownership marker; a lexicon with no
 * marker channel logs and returns everything (its own contract). Plugins that
 * throw are collected into `errors` and skipped — one failing lexicon never
 * sinks the whole graph.
 */
export async function observeResources(
  environment: string,
  plugins: ObservationLexicon[],
  buildResult: BuildResult,
  opts?: { owned?: boolean },
): Promise<ObserveResult> {
  const owned = opts?.owned ?? true;
  const observations: LiveObservation[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const plugin of plugins) {
    if (!plugin.describeResources) continue;

    // Serialized build output + declared entities for this lexicon — the scope
    // describeResources needs to know what to look for.
    const rawOutput = buildResult.outputs.get(plugin.name);
    const buildOutput =
      rawOutput === undefined
        ? ""
        : typeof rawOutput === "string"
          ? rawOutput
          : (rawOutput as SerializerResult).primary;

    const entityNames: string[] = [];
    const entities = new Map<string, { entityType: string; props: Record<string, unknown> }>();
    for (const [name, entity] of buildResult.entities) {
      if (entity.lexicon !== plugin.name) continue;
      entityNames.push(name);
      entities.set(name, {
        entityType: entity.entityType,
        props: ("props" in entity && entity.props != null ? entity.props : {}) as Record<string, unknown>,
      });
    }

    try {
      const resources: Record<string, ResourceMetadata> = await plugin.describeResources({
        environment,
        buildOutput,
        entityNames,
        entities,
        owned,
      });
      if (Object.keys(resources).length > 0) {
        observations.push({ lexicon: plugin.name, resources });
      }
    } catch (err) {
      errors.push(`${plugin.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { observations, warnings, errors };
}
