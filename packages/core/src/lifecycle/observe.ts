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
import type { ObservationLexicon } from "../lexicon";
import type { BuildResult } from "../build";
import type { SerializerResult } from "../serializer";
import type { LiveObservation } from "../graph-ir";
import {
  mergeObservations,
  normalizeObservation,
  unobservedAll,
  formatUnobserved,
  type NormalizedObservation,
} from "../observation";
import { zeroResourcesWarning } from "../live-endpoint";

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
 * throw are collected into `errors` — one failing lexicon never sinks the whole
 * graph — and every entity they were asked about is recorded as NOT-OBSERVED
 * (`read-failed`, #1089) rather than dropped, so a failed read is visibly a
 * hole instead of a silent absence.
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
  opts?: { owned?: boolean; stacks?: string[] },
): Promise<ObserveResult> {
  const owned = opts?.owned ?? true;
  const stacks = opts?.stacks ?? [];
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
      let observed: NormalizedObservation;
      if (stacks.length > 0) {
        const parts: NormalizedObservation[] = [];
        for (const stack of stacks) {
          parts.push(
            normalizeObservation(
              await plugin.describeResources({
                environment,
                buildOutput,
                entityNames,
                entities,
                owned,
                stack,
              }),
            ),
          );
        }
        observed = mergeObservations(parts);
      } else {
        observed = normalizeObservation(
          await plugin.describeResources({
            environment,
            buildOutput,
            entityNames,
            entities,
            owned,
          }),
        );
      }
      pushObservation(observations, warnings, plugin.name, observed, environment, entityNames.length);
    } catch (err) {
      // A thrown read is the whole-lexicon failure: every declared entity is
      // NOT-OBSERVED, not absent (#1089). Emitting nothing here is what made a
      // failed read look like "none of these exist" to every consumer.
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${plugin.name}: ${message}`);
      pushObservation(
        observations,
        warnings,
        plugin.name,
        {
          resources: {},
          unobserved: unobservedAll(entityNames, "read-failed", message, entities),
        },
        environment,
        entityNames.length,
      );
    }
  }

  return { observations, warnings, errors };
}

/** Record one lexicon's observation, warning once per unobserved entity. */
function pushObservation(
  observations: LiveObservation[],
  warnings: string[],
  lexicon: string,
  observed: NormalizedObservation,
  environment: string,
  declaredCount: number,
): void {
  const hasResources = Object.keys(observed.resources).length > 0;
  const unobservedNames = Object.keys(observed.unobserved);
  for (const name of unobservedNames) {
    warnings.push(`${lexicon}: not observed — ${formatUnobserved(name, observed.unobserved[name])}`);
  }
  if (!hasResources && unobservedNames.length === 0) {
    // #1166 — this is exactly the "wrong endpoint" shape (AWS's
    // stackDoesNotExist branch returns an empty map with no #1089 hole): a
    // declared entity list with nothing observed and nothing explained.
    // Previously this fell straight through with neither an observation nor a
    // warning — silently indistinguishable from "nothing is deployed yet".
    const notice = zeroResourcesWarning(lexicon, environment, declaredCount, observed);
    if (notice) warnings.push(notice);
    return;
  }
  observations.push({
    lexicon,
    resources: observed.resources,
    ...(unobservedNames.length > 0 ? { unobserved: observed.unobserved } : {}),
  });
}
