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
import { build as buildProject } from "../build";
import { resolve as resolvePath } from "node:path";
import type { SerializerResult } from "../serializer";
import type { LiveObservation, IREdge } from "../graph-ir";
import type { ResourceMetadata } from "../lexicon";
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
 * Re-key a normalized observation's entities by `${stack}::${id}` (#1162) so a
 * bare LogicalResourceId shared across stacks (e.g. `vpc`) stays unambiguous
 * once the per-stack results are merged. The declared canvas qualifies the same
 * way (`buildDeclaredPerStack`), so the overlay join lines up. Applies to both
 * the OBSERVED-PRESENT and NOT-OBSERVED maps of the tri-state (#1089).
 */
function qualifyObservation(obs: NormalizedObservation, stackName: string): NormalizedObservation {
  const q = <T>(m: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [`${stackName}::${k}`, v]));
  return { resources: q(obs.resources), unobserved: q(obs.unobserved) };
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
 * called once per stack and the returned observations are merged. A stack entry
 * may be a bare name or `{ name, region?, src? }` (#1162): `src` is built
 * SCOPED so the deployed BARE LogicalResourceIds match (the whole-project build
 * disambiguates colliding names to `UsWest1Src…`, which the live ids never
 * carry), and a scoped stack's observed ids are qualified `${stack}::${id}` so
 * the same bare id in two stacks stays distinct. A bare-string stack keeps its
 * bare ids and the tri-state merge (#57). When `stacks` is absent or empty, behavior is
 * exactly the single call of before (no `stack` key at all), so a single-stack
 * project is unaffected.
 */
export async function observeResources(
  environment: string,
  plugins: ObservationLexicon[],
  buildResult: BuildResult,
  opts?: { owned?: boolean; stacks?: Array<string | { name: string; region?: string; src?: string }> },
): Promise<ObserveResult> {
  const owned = opts?.owned ?? true;
  const stacks = (opts?.stacks ?? []).map((st) => (typeof st === "string" ? { name: st } : st));
  // A stack's `src` (multi-stack, #1162) is built SCOPED to recover that stack's
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
      let observed: NormalizedObservation;
      if (stacks.length > 0) {
        const parts: NormalizedObservation[] = [];
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
          const norm = normalizeObservation(
            await plugin.describeResources({
              environment,
              buildOutput: stackBuildOutput,
              entityNames: stackEntityNames,
              entities: stackEntities,
              owned,
              stack: stack.name,
              region: stack.region,
            }),
          );
          // Qualify ids by stack ONLY for a scoped (`src`) stack (#1162): that
          // is the multi-region case where the SAME bare LogicalResourceId
          // (e.g. `vpc`) exists in every stack, so a bare union would collide.
          // A bare-string stack (#57 loomster) has unique per-component ids and
          // is asked the whole-project entity set, so it keeps the bare-id
          // tri-state merge (present > not-observed > absent) that behold and
          // other consumers read.
          parts.push(stack.src ? qualifyObservation(norm, stack.name) : norm);
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
      // What the estate depends on but does not declare (#1273). Read after the
      // managed resources, because the declared observation is the closure's
      // roots — there is nothing to reference out from until it exists.
      const dependencies = await collectDependencies(plugin, {
        environment,
        entities,
        observed: observed.resources,
        stacks,
      });
      for (const message of dependencies.warnings) warnings.push(message);
      pushObservation(
        observations,
        warnings,
        plugin.name,
        observed,
        environment,
        entityNames.length,
        dependencies,
      );
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

/** Dependencies collected across a lexicon's stacks, plus anything to report. */
interface CollectedDependencies {
  resources: Record<string, ResourceMetadata>;
  edges: IREdge[];
  warnings: string[];
}

const NO_DEPENDENCIES: CollectedDependencies = { resources: {}, edges: [], warnings: [] };

/**
 * Ask a lexicon what its declared estate references but does not manage (#1273).
 *
 * Called once per stack, because the closure roots and the region differ per
 * stack, and merged by key. Dependencies are keyed by physical id and are
 * deliberately NOT stack-qualified: the account's default VPC route table is the
 * same resource whichever stack routes through it, and qualifying it would
 * produce one node per referrer and an edge to each.
 *
 * Best-effort. A lexicon that does not implement the hook, or one whose read
 * fails, contributes nothing — the managed observation is already complete and
 * useful on its own, and failing it because an ambient dependency could not be
 * read would trade a whole answer for a partial one.
 */
async function collectDependencies(
  plugin: ObservationLexicon,
  opts: {
    environment: string;
    entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
    observed: Record<string, ResourceMetadata>;
    stacks: Array<{ name: string; region?: string; src?: string }>;
  },
): Promise<CollectedDependencies> {
  if (!plugin.observeDependencies) return NO_DEPENDENCIES;

  const resources: Record<string, ResourceMetadata> = {};
  const edges: IREdge[] = [];
  const warnings: string[] = [];
  const refs = opts.stacks.length > 0 ? opts.stacks : [{ name: undefined, region: undefined }];

  for (const ref of refs) {
    try {
      const found = await plugin.observeDependencies({
        environment: opts.environment,
        entities: opts.entities,
        observed: opts.observed,
        ...(ref.name ? { stack: ref.name } : {}),
        ...(ref.region ? { region: ref.region } : {}),
      });
      for (const [id, meta] of Object.entries(found.resources)) {
        // Merge referrers rather than overwrite: two stacks routing through the
        // same table is one node reached twice, and the reason it is here is
        // both of them.
        const existing = resources[id];
        resources[id] = existing
          ? { ...existing, referencedBy: [...new Set([...(existing.referencedBy ?? []), ...(meta.referencedBy ?? [])])] }
          : meta;
      }
      edges.push(...(found.edges ?? []));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(
        `${plugin.name}: dependencies not read${ref.name ? ` for stack "${ref.name}"` : ""} — ${message}`,
      );
    }
  }
  return { resources, edges, warnings };
}

/** Record one lexicon's observation, warning once per unobserved entity. */
function pushObservation(
  observations: LiveObservation[],
  warnings: string[],
  lexicon: string,
  observed: NormalizedObservation,
  environment: string,
  declaredCount: number,
  dependencies: CollectedDependencies = NO_DEPENDENCIES,
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
  // Dependencies ride alongside the managed resources so they become nodes, and
  // carry `referencedBy` so every consumer can still tell the two apart.
  const hasDependencies = Object.keys(dependencies.resources).length > 0;
  observations.push({
    lexicon,
    resources: hasDependencies
      ? { ...observed.resources, ...dependencies.resources }
      : observed.resources,
    ...(unobservedNames.length > 0 ? { unobserved: observed.unobserved } : {}),
    ...(dependencies.edges.length > 0 ? { edges: dependencies.edges } : {}),
  });
}
