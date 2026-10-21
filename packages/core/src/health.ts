/**
 * Runtime health (#4177): whether a declared thing is up, read separately from
 * drift.
 *
 * The observation family answers what is deployed (`describeResources`), what
 * its properties are (`observeResourcesDeep`) and what it would do
 * (`predictBehaviour`). None of them says whether a service is serving. A
 * lexicon that can read that implements {@link HealthLexicon.observeHealth}
 * for the types it names in `healthTypes`, and `chant lifecycle health` reports
 * the answers in the {@link HEALTH_SCHEMA} shape.
 *
 * The verdicts follow #1089's rule. Every entity the caller asks about lands in
 * exactly one place: `entities` (read, with a state), `unobserved` (the read
 * failed, a hole with a reason) or `absent` (the provider says it is not
 * deployed). A failed read is never `unhealthy`: `unhealthy` is something the
 * provider said.
 *
 * Routing is not modelled. A consumer that wants rotation (a latency record
 * whose health check is unhealthy is out of rotation) derives it from the
 * graph's edges and these states.
 */

import type { UnobservedEntity, UnobservedReason } from "./observation";
import { unobservedAll } from "./observation";

/** The versioned shape `chant lifecycle health --json` prints. The JSON Schema is `./health.schema.json`. */
export const HEALTH_SCHEMA = "chant-health/v1";

/** The `$id` of `./health.schema.json`, which the package exports as `@intentius/chant/health.schema.json`. */
export const HEALTH_SCHEMA_ID = "https://intentius.io/chant/schemas/health/v1/health.schema.json";

/**
 * `healthy` and `unhealthy` are what the provider reported. `unknown` means the
 * read succeeded and the provider's answer does not decide either way (a
 * deployment still rolling, a service scaled to zero, a condition pending).
 */
export type HealthState = "healthy" | "unhealthy" | "unknown";

export interface HealthEntry {
  /** Entity type, e.g. `AWS::ECS::Service`. */
  type: string;
  state: HealthState;
  /** One short line saying why, in the provider's terms. */
  detail: string;
  /** When chant read it (ISO 8601). */
  observedAt: string;
  /** When the provider last checked or changed the state, when it says (ISO 8601). */
  checkedAt?: string;
}

/** What one lexicon's health read returns. */
export interface HealthReadResult {
  /** Read, keyed by chant entity name, which is the graph's node id. */
  entities: Record<string, HealthEntry>;
  /** Could not be read. Never folded into `unhealthy`. */
  unobserved: Record<string, UnobservedEntity>;
  /** The provider says these are not deployed. */
  absent: string[];
}

/** The options core passes a lexicon's health read. They mirror `observeResourcesDeep`'s. */
export interface HealthReadOptions {
  environment: string;
  buildOutput: string;
  /** Only entities whose type is in the lexicon's `healthTypes`. */
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  stack?: string;
  region?: string;
}

/** The two plugin members a lexicon implements to answer a health read. */
export interface HealthLexicon {
  name: string;
  /** Entity types {@link observeHealth} can read. Data, so core picks the entities without calling the reader. */
  healthTypes?: readonly string[];
  observeHealth?(options: HealthReadOptions): Promise<HealthReadResult>;
}

/**
 * The entities of one lexicon a health read applies to: those whose type the
 * lexicon names in `healthTypes`.
 */
export function healthApplicable(
  plugin: HealthLexicon,
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> {
  const types = new Set(plugin.healthTypes ?? []);
  const out = new Map<string, { entityType: string; props: Record<string, unknown> }>();
  for (const [name, entity] of entities) if (types.has(entity.entityType)) out.set(name, entity);
  return out;
}

/**
 * Run one lexicon's health read. Never throws: a thrown reader reports every
 * applicable entity `read-failed`. The result is made total, so an entity the
 * reader forgot comes back `unobserved` rather than missing.
 */
export async function observeHealthFor(
  plugin: HealthLexicon,
  options: HealthReadOptions,
): Promise<HealthReadResult> {
  const names = [...options.entities.keys()];
  if (names.length === 0) return { entities: {}, unobserved: {}, absent: [] };
  if (!plugin.observeHealth) {
    return {
      entities: {},
      unobserved: unobservedAll(names, "unsupported-kind", `${plugin.name} has no health read`, options.entities),
      absent: [],
    };
  }
  let result: HealthReadResult;
  try {
    result = await plugin.observeHealth(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { entities: {}, unobserved: unobservedAll(names, "read-failed", message, options.entities), absent: [] };
  }
  return totalHealth(names, result, options.entities);
}

/**
 * Put every asked-about name in exactly one of the three places. A name in
 * `entities` wins over the others, then `absent`, then `unobserved`; a name in
 * none of them becomes `read-failed`.
 */
export function totalHealth(
  names: string[],
  result: HealthReadResult,
  types?: Map<string, { entityType: string }>,
): HealthReadResult {
  const entities: Record<string, HealthEntry> = {};
  const unobserved: Record<string, UnobservedEntity> = {};
  const absentSet = new Set(result.absent ?? []);
  const absent: string[] = [];
  for (const name of names) {
    const entry = result.entities?.[name];
    if (entry) entities[name] = entry;
    else if (absentSet.has(name)) absent.push(name);
    else if (result.unobserved?.[name]) unobserved[name] = result.unobserved[name];
    else Object.assign(unobserved, unobservedAll([name], "read-failed", "the health read returned no answer for this entity", types));
  }
  return { entities, unobserved, absent };
}

/** Counts across a health read, for the summary line and `--json`. */
export interface HealthSummary {
  healthy: number;
  unhealthy: number;
  unknown: number;
  unobserved: number;
  absent: number;
}

export function summarizeHealth(results: Iterable<HealthReadResult>): HealthSummary {
  const summary: HealthSummary = { healthy: 0, unhealthy: 0, unknown: 0, unobserved: 0, absent: 0 };
  for (const r of results) {
    for (const entry of Object.values(r.entities)) summary[entry.state]++;
    summary.unobserved += Object.keys(r.unobserved).length;
    summary.absent += r.absent.length;
  }
  return summary;
}

/** A health entry, for a reader building its result. */
export function healthEntry(
  type: string,
  state: HealthState,
  detail: string,
  observedAt: string,
  checkedAt?: string,
): HealthEntry {
  return { type, state, detail, observedAt, ...(checkedAt ? { checkedAt } : {}) };
}

/** A hole, for a reader building its result. */
export function healthHole(type: string, reason: UnobservedReason, detail: string): UnobservedEntity {
  return { type, reason, detail };
}
