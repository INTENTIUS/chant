/**
 * How a live fountain record is matched to the declaration it came from, and
 * who owns it (#2128).
 *
 * Environments, vaults and agents are each a named record on its own REST
 * collection, and fountain upserts by that name, so the serializer's
 * `metadata.name` is both the declaration's identity and the read's lookup key.
 * The team-side kinds, whose identity joined through the team roster or a
 * webhook url, went with Managoat's removal of them (managoat/managoat#2793).
 *
 * ## Ownership
 *
 * The `managed-by: chant` marker lives in a resource's `metadata` map, which
 * every kind left has, so a record is `owned` or `foreign`, never a guess.
 */

import { isChantOwned, type FountainHttp } from "./op/activities/fountain-apply";
import { propsOf } from "./entity-props";
import { ENVIRONMENT_TYPE, VAULT_TYPE, AGENT_TYPE } from "./deep-observe-hooks";

/** The list endpoint each declarable kind is read from. */
export const KIND_PATHS: Record<string, string> = {
  [ENVIRONMENT_TYPE]: "environments",
  [VAULT_TYPE]: "vaults",
  [AGENT_TYPE]: "agents",
};

/** Ownership verdicts, as `ResourceMetadata.ownership` spells them. */
export type Ownership = "owned" | "foreign";

/** One live record, with the handful of fields identity and ownership read by name. */
export interface LiveRecord extends Record<string, unknown> {
  id?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface DeclaredEntityProps {
  entityType: string;
  props: Record<string, unknown>;
}

/**
 * The name fountain reconciles this entity by — the declared `name` when there
 * is one, the chant export name otherwise. Same rule the serializer applies
 * when it writes `metadata.name`, and the two must not disagree or a clean
 * apply would read back as absent.
 */
export function effectiveName(entityName: string, props: Record<string, unknown>): string {
  return typeof props.name === "string" && props.name.length > 0 ? props.name : entityName;
}

/**
 * Index of authored props object → the fountain name of the entity that
 * declared it, so a typed reference can be resolved to a name even when the
 * referenced declaration carries no `name` of its own and takes the export
 * name instead.
 *
 * Keyed on object identity because that is the only thing the two sides share:
 * core hands `describeResources` the entity's own `props` object, and a typed
 * reference prop holds the referenced *instance*, whose `.props` is that same
 * object. A plain-object fixture yields a fresh record per read, so it falls
 * through to the `name` prop below — which is what a fixture should carry.
 */
export function nameIndex(entities: Map<string, DeclaredEntityProps>): Map<Record<string, unknown>, string> {
  const index = new Map<Record<string, unknown>, string>();
  for (const [entityName, entity] of entities) {
    index.set(entity.props, effectiveName(entityName, entity.props));
  }
  return index;
}

/** The fountain name a typed reference prop points at, or undefined when it resolves to nothing. */
export function referencedName(
  value: unknown,
  index: Map<Record<string, unknown>, string>,
): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  const props = propsOf(value);
  const declared = index.get(props);
  if (declared) return declared;
  return typeof props.name === "string" && props.name.length > 0 ? props.name : undefined;
}

/** The key a live record is indexed under: its name, as {@link effectiveName} spells the declared side. */
export function liveKey(record: LiveRecord): string | undefined {
  return typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
}

/** Live ownership verdict for one record: chant's marker in its metadata, or not. */
export function ownershipOf(record: LiveRecord): Ownership {
  return isChantOwned(record) ? "owned" : "foreign";
}

/**
 * One list per kind, shared by every entity of that kind — including a failure,
 * so a failed list gives the same verdict to every entity of the kind without a
 * second request. The in-flight promise is what is cached: the observer harness
 * reads entities concurrently, and caching only settled results would let
 * simultaneous reads each fire their own list.
 */
export class FountainLists {
  private readonly rows = new Map<string, Promise<LiveRecord[]>>();
  private readonly keyed = new Map<string, Promise<Map<string, LiveRecord>>>();

  constructor(private readonly http: FountainHttp) {}

  /** Every record of a kind, in the order fountain returned them. */
  raw(entityType: string): Promise<LiveRecord[]> {
    const cached = this.rows.get(entityType);
    if (cached) return cached;

    const path = KIND_PATHS[entityType];
    const pending = (async () => {
      const { status, json } = await this.http("GET", `/api/${path}`);
      if (status !== 200) throw new Error(`list ${path} returned ${status}`);
      return (json as { data?: LiveRecord[] })?.data ?? [];
    })();

    this.rows.set(entityType, pending);
    return pending;
  }

  /** Records of a kind, indexed by the key a declaration is looked up under. */
  byKey(entityType: string): Promise<Map<string, LiveRecord>> {
    const cached = this.keyed.get(entityType);
    if (cached) return cached;

    const pending = (async () => {
      const rows = await this.raw(entityType);
      const byKey = new Map<string, LiveRecord>();
      for (const row of rows) {
        const key = liveKey(row);
        if (key !== undefined) byKey.set(key, row);
      }
      return byKey;
    })();

    this.keyed.set(entityType, pending);
    return pending;
  }

  /** Resource name by id, for a kind whose references arrive as ids. */
  async nameById(entityType: string): Promise<Map<string, string>> {
    const rows = await this.raw(entityType);
    const byId = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.id === "string" && typeof row.name === "string") byId.set(row.id, row.name);
    }
    return byId;
  }
}
