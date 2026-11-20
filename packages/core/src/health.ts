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
import { NEXT_RELEASE } from "./release-floors";

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
  /**
   * Each entity's id as an engine recorded it (#5338): a terraform root's
   * state, a pulumi stack's export. Set when core reads health for an
   * engine's resources through the provider lexicon that knows the type. A
   * reader then takes the id from here in place of its own deploy records
   * (aws's CloudFormation stack, azure's resource group), and an entity with
   * no id here is absent.
   */
  physicalIds?: Readonly<Record<string, string>>;
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

/**
 * One engine resource a provider lexicon reads health for (#5338): a
 * terraform `aws_ecs_service` is the aws lexicon's `AWS::ECS::Service`.
 */
export interface HealthTarget {
  /** The provider lexicon whose `observeHealth` reads it, e.g. `aws`. */
  lexicon: string;
  /** That lexicon's health type, one of its `healthTypes`. */
  type: string;
  /** The engine's own resource type, e.g. `aws_ecs_service` or `aws:ecs/service:Service`. */
  engineType: string;
  /** The id the engine recorded for it. */
  physicalId: string;
}

/**
 * What an engine lexicon's {@link EngineHealthLexicon.healthTargets} returns:
 * each entity of a covered type in exactly one of `targets`, `unobserved` or
 * `absent`. Entities of other types are left out, as a provider lexicon
 * leaves out the types missing from its `healthTypes`.
 */
export interface HealthTargetsResult {
  targets: Record<string, HealthTarget>;
  unobserved: Record<string, UnobservedEntity>;
  absent: string[];
}

/**
 * An engine lexicon (terraform, pulumi) answers health through the provider
 * lexicons (#5338). It maps its resource types onto their health types and
 * reads each resource's id from its own records; core hands the ids to the
 * provider's `observeHealth`.
 */
export interface EngineHealthLexicon {
  name: string;
  healthTargets?(options: HealthReadOptions): Promise<HealthTargetsResult>;
}

/** The first chant whose `lifecycle health` reads a terraform root's or pulumi stack's resources through the provider lexicons, with `healthTargets` and `HealthReadOptions.physicalIds` (#5338). */
export const ENGINE_HEALTH_FLOOR = NEXT_RELEASE;

/**
 * Health for an engine lexicon's entities (#5338): its `healthTargets`, then
 * each target read by its provider lexicon with the engine's id. Never
 * throws. A provider that is not installed, or whose health read does not
 * cover the type, leaves the target `unsupported-kind`. A thrown
 * `healthTargets` comes back as `error`, with no entries.
 */
export async function observeEngineHealth(
  engine: EngineHealthLexicon,
  options: HealthReadOptions,
  provider: (lexicon: string) => Promise<HealthLexicon | undefined>,
): Promise<{ result: HealthReadResult; error?: string }> {
  const empty: HealthReadResult = { entities: {}, unobserved: {}, absent: [] };
  if (!engine.healthTargets || options.entities.size === 0) return { result: empty };
  let found: HealthTargetsResult;
  try {
    found = await engine.healthTargets(options);
  } catch (err) {
    return { result: empty, error: err instanceof Error ? err.message : String(err) };
  }
  const entities: Record<string, HealthEntry> = {};
  const unobserved: Record<string, UnobservedEntity> = { ...(found.unobserved ?? {}) };
  const absent: string[] = [...(found.absent ?? [])];

  const byLexicon = new Map<string, Array<[string, HealthTarget]>>();
  for (const [name, target] of Object.entries(found.targets ?? {})) {
    const list = byLexicon.get(target.lexicon) ?? [];
    list.push([name, target]);
    byLexicon.set(target.lexicon, list);
  }
  for (const [lexicon, list] of byLexicon) {
    const reader = await provider(lexicon).catch(() => undefined);
    const covered = new Set(reader?.healthTypes ?? []);
    const read = new Map<string, { entityType: string; props: Record<string, unknown> }>();
    const physicalIds: Record<string, string> = {};
    for (const [name, target] of list) {
      if (!reader?.observeHealth || !covered.has(target.type)) {
        unobserved[name] = {
          type: target.type,
          reason: "unsupported-kind",
          detail: reader
            ? `the ${lexicon} lexicon has no health read for ${target.type}`
            : `${target.engineType} is read by the ${lexicon} lexicon, which is not installed`,
        };
        continue;
      }
      read.set(name, { entityType: target.type, props: {} });
      physicalIds[name] = target.physicalId;
    }
    if (read.size === 0 || !reader) continue;
    const r = await observeHealthFor(reader, { ...options, buildOutput: "", entities: read, physicalIds });
    Object.assign(entities, r.entities);
    Object.assign(unobserved, r.unobserved);
    absent.push(...r.absent);
  }
  return { result: { entities, unobserved, absent } };
}
