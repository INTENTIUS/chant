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
import { build as buildProject } from "../build";
import { resolve as resolvePath } from "node:path";
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
 *
 * `stacks` (#57) is for a multi-stack, per-component project (e.g. loomster)
 * where there is no single stack named after the environment — AWS's
 * single-stack convention (`lexicons/aws/src/plugin.ts`'s `describeResources`,
 * absent an explicit `stack`) queries a stack that simply doesn't exist there,
 * so the single-call path always observes zero nodes. When `stacks` is
 * present and non-empty, each observing plugin's `describeResources` is
 * called once per stack (same `environment`/`entities`/`entityNames`, only
 * `stack` varies) and the returned resource maps are unioned — a resource
 * appears under whichever stack contains its logical id. When `stacks` is
 * absent or empty, behavior is exactly the single call of before (no `stack`
 * key at all), so a single-stack project is unaffected.
 */
export async function observeResources(
  environment: string,
  plugins: ObservationLexicon[],
  buildResult: BuildResult,
  opts?: { owned?: boolean; stacks?: Array<string | { name: string; region?: string; src?: string }> },
): Promise<ObserveResult> {
  const owned = opts?.owned ?? true;
  const stacks = (opts?.stacks ?? []).map((st) => (typeof st === "string" ? { name: st } : st));
  // A stack's `src` (multi-stack, #1162) is built SCOPED to get that stack's
  // BARE entity names — the names it actually deploys. Matching deployed bare
  // LogicalResourceIds against the whole-project build's DISAMBIGUATED names
  // (UsWest1Src…) misses every colliding resource. Cached per src.
  const serializers = plugins.map((p) => p.serializer);
  const scopedBuildCache = new Map<string, BuildResult>();
  const scopedBuild = async (src: string): Promise<BuildResult> => {
    const key = resolvePath(src);
    let r = scopedBuildCache.get(key);
    if (!r) {
      r = await buildProject(key, serializers);
      scopedBuildCache.set(key, r);
    }
    return r;
  };
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
      let resources: Record<string, ResourceMetadata>;
      if (stacks.length > 0) {
        resources = {};
        for (const stack of stacks) {
          // Use this stack's scoped build (bare entity names) when it has a src,
          // so describeResources matches the deployed bare LogicalResourceIds.
          let stackEntityNames = entityNames;
          let stackBuildOutput = buildOutput;
          let stackEntities = entities;
          if (stack.src) {
            const sb = await scopedBuild(stack.src);
            stackEntityNames = [];
            stackEntities = new Map();
            for (const [name, entity] of sb.entities) {
              if (entity.lexicon !== plugin.name) continue;
              stackEntityNames.push(name);
              stackEntities.set(name, {
                entityType: entity.entityType,
                props: ("props" in entity && entity.props != null ? entity.props : {}) as Record<string, unknown>,
              });
            }
            const raw = sb.outputs.get(plugin.name);
            stackBuildOutput = raw === undefined ? "" : typeof raw === "string" ? raw : (raw as SerializerResult).primary;
          }
          const perStack = await plugin.describeResources({
            environment,
            buildOutput: stackBuildOutput,
            entityNames: stackEntityNames,
            entities: stackEntities,
            owned,
            stack: stack.name,
            region: stack.region,
          });
          // Stack-qualify each logical id (#1162): the same bare LogicalResourceId
          // (e.g. `vpc`) can appear in multiple stacks, so key observed nodes by
          // `${stack}::${logicalId}`. The declared side qualifies identically, so
          // the overlay join is unambiguous. A single stack qualifies too, for a
          // stable id the declared graph can match.
          for (const [logicalId, meta] of Object.entries(perStack)) {
            resources[`${stack.name}::${logicalId}`] = meta;
          }
        }
      } else {
        resources = await plugin.describeResources({
          environment,
          buildOutput,
          entityNames,
          entities,
          owned,
        });
      }
      if (Object.keys(resources).length > 0) {
        observations.push({ lexicon: plugin.name, resources });
      }
    } catch (err) {
      errors.push(`${plugin.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { observations, warnings, errors };
}
