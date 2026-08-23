/**
 * Deep observation orchestration (#1014) — call one lexicon's
 * `observeResourcesDeep()`, put the declared trees in the same shape, and diff.
 *
 * The sibling of ./observe.ts on the thin path, and it inherits that path's
 * rules: a reader that throws does not vanish, it reports every declared entity
 * NOT-OBSERVED with `read-failed` (#1089); a multi-stack read merges with
 * present > not-observed > absent. A deep read that fails is a hole with a
 * reason, never a thin-but-clean answer.
 *
 * The normalization is applied here, on both sides, with the lexicon's own
 * hooks. The reader already normalized what it returned — that is the contract
 * — but only core can normalize the *declared* tree, and only core knows which
 * paths exist on the other side, which is what
 * {@link import("../deep-observation").DeepNode.counterpart} needs for default
 * subtraction. Re-running the pass over an already-normalized live tree is
 * idempotent for every hook that does not consult `counterpart`.
 */

import type { ObservationLexicon } from "../lexicon";
import {
  deepPathSet,
  normalizeDeepObservation,
  normalizeDeepProperties,
  type DeepNormalizationHooks,
  type DeepResourceObservation,
  type NormalizedDeepObservation,
} from "../deep-observation";
import { unobservedAll, type UnobservedEntity } from "../observation";
import { diffDeep, type DeclaredDeepEntity, type DeepDiffResult } from "./deep-diff";
import type { BaselineLexicon } from "./observation-baseline";

/** Declared entities for one lexicon, in the shape the observe paths pass around. */
export type DeclaredEntities = Map<string, { entityType: string; props: Record<string, unknown> }>;

export interface DeepObserveOptions {
  environment: string;
  buildOutput: string;
  entities: DeclaredEntities;
  /** Deployed stack for a multi-stack project (#932). */
  stack?: string;
  /** Region that stack is deployed in (#1267). Same contract as the thin path
   * (#1261): a multi-region estate reads each stack in its own region, not in
   * whichever one the shell is set to. */
  region?: string;
  /** Component projects deploy one stack per component; read them all and merge. */
  componentStacks?: string[];
  owned?: boolean;
}

/**
 * Merge several deep observations of the same lexicon (the multi-stack read).
 * Precedence matches the thin contract: present > not-observed > absent.
 */
export function mergeDeepObservations(
  parts: Iterable<NormalizedDeepObservation>,
): NormalizedDeepObservation {
  const resources: Record<string, DeepResourceObservation> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  for (const part of parts) {
    Object.assign(resources, part.resources);
    Object.assign(unobserved, part.unobserved);
  }
  for (const name of Object.keys(resources)) delete unobserved[name];
  return { resources, unobserved };
}

/**
 * Read one lexicon's live property trees. Never throws: a thrown reader becomes
 * a NOT-OBSERVED verdict for every declared entity, with the error as the
 * detail, so the caller sees a hole rather than an empty tree that reads as
 * "no properties drifted".
 */
export async function observeDeep(
  plugin: ObservationLexicon,
  opts: DeepObserveOptions,
): Promise<NormalizedDeepObservation> {
  const entityNames = Array.from(opts.entities.keys());
  if (!plugin.observeResourcesDeep) {
    return { resources: {}, unobserved: {} };
  }
  const base = {
    environment: opts.environment,
    buildOutput: opts.buildOutput,
    entityNames,
    entities: opts.entities,
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.owned !== undefined ? { owned: opts.owned } : {}),
  };
  try {
    if (opts.componentStacks && opts.componentStacks.length > 0) {
      const parts: NormalizedDeepObservation[] = [];
      for (const stack of opts.componentStacks) {
        parts.push(normalizeDeepObservation(await plugin.observeResourcesDeep({ ...base, stack })));
      }
      return mergeDeepObservations(parts);
    }
    return normalizeDeepObservation(
      await plugin.observeResourcesDeep({ ...base, ...(opts.stack ? { stack: opts.stack } : {}) }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      resources: {},
      unobserved: unobservedAll(entityNames, "read-failed", message, opts.entities),
    };
  }
}

/**
 * Normalize both sides into the same shape, then diff.
 *
 * Split out from {@link deepDiffForLexicon} so the pure half is testable
 * without a plugin: given declared entities, a live observation and a baseline,
 * this is a deterministic function.
 */
export function diffDeepObservation(
  entities: DeclaredEntities,
  live: NormalizedDeepObservation,
  hooks?: DeepNormalizationHooks,
  baseline?: BaselineLexicon,
): DeepDiffResult {
  const declared: Record<string, DeclaredDeepEntity> = {};
  const normalizedLive: Record<string, DeepResourceObservation> = {};

  for (const [name, entity] of entities) {
    const liveEntity = live.resources[name];
    const declaredRaw = entity.props ?? {};
    const liveRaw = liveEntity?.properties ?? {};
    const declaredPaths = deepPathSet(declaredRaw);
    const livePaths = deepPathSet(liveRaw);

    declared[name] = {
      type: entity.entityType,
      properties: normalizeDeepProperties(declaredRaw, {
        entityType: entity.entityType,
        side: "declared",
        hooks,
        counterpartPaths: livePaths,
      }),
    };
    if (liveEntity) {
      normalizedLive[name] = {
        type: liveEntity.type || entity.entityType,
        ...(liveEntity.physicalId ? { physicalId: liveEntity.physicalId } : {}),
        // Per-path owners (#1189) ride through unchanged; the diff looks them
        // up by the flattened path, so a keyed list element (`[#name]`) has
        // no owner today — its raw index path is what the reader recorded.
        ...(liveEntity.fieldOwners ? { fieldOwners: liveEntity.fieldOwners } : {}),
        properties: normalizeDeepProperties(liveRaw, {
          entityType: liveEntity.type || entity.entityType,
          side: "live",
          hooks,
          counterpartPaths: declaredPaths,
        }),
      };
    }
  }

  // Live entities nobody declared keep their reader-normalized trees — there is
  // no declared side to normalize them against, and `diffDeep` reports them as
  // undeclared entities rather than diffing their properties.
  for (const [name, liveEntity] of Object.entries(live.resources)) {
    if (!normalizedLive[name]) normalizedLive[name] = liveEntity;
  }

  return diffDeep({
    declared,
    live: { resources: normalizedLive, unobserved: live.unobserved },
    baseline,
    hooks,
  });
}

/** Read one lexicon deeply and diff it against source and the accepted baseline. */
export async function deepDiffForLexicon(
  plugin: ObservationLexicon,
  opts: DeepObserveOptions & { baseline?: BaselineLexicon },
): Promise<DeepDiffResult> {
  const live = await observeDeep(plugin, opts);
  return diffDeepObservation(opts.entities, live, plugin.deepNormalizationHooks, opts.baseline);
}
