/**
 * How a live fountain record is matched to the declaration it came from, and
 * who owns it (#2128).
 *
 * Environments, vaults and agents are easy: each is a named record on its own
 * REST collection, and fountain upserts by that name, so the serializer's
 * `metadata.name` is both the declaration's identity and the read's lookup key.
 * The three team-side kinds are not.
 *
 * - A **teammate** is an agent bound to the reserved `fountain:team` channel.
 *   `GET /api/team` renders one row per teammate with the name the roster shows
 *   — the serializer's key — and the agent embedded whole.
 * - A **schedule** hangs off a teammate: the route carries the agent as a path
 *   parameter (`POST /api/team/{agent_id}/schedules`), and `name` is optional
 *   and only unique within one teammate. So identity is the pair, and matching
 *   a live schedule needs the roster to turn its `agent_id` back into the
 *   teammate name the declaration wrote.
 * - A **webhook** has no name at all. Its `url` is what an author writes and
 *   what fountain reconciles by, so the url is the key.
 *
 * ## Ownership
 *
 * The `managed-by: chant` marker lives in a resource's `metadata` map, and only
 * environments, vaults and agents have one. A teammate and a schedule are
 * layered on an agent, so ownership is **inherited** from the agent behind them
 * — chant's marker on the agent covers the teammate that is that agent and
 * every schedule on its thread. A webhook is layered on nothing: it carries no
 * metadata upstream, so its verdict is `unknown`, never a guess. `unknown`
 * never becomes a delete, which is the whole reason the contract has the value.
 */

import { isChantOwned, type FountainHttp } from "./op/activities/fountain-apply";
import { propsOf } from "./entity-props";
import {
  ENVIRONMENT_TYPE,
  VAULT_TYPE,
  AGENT_TYPE,
  TEAMMATE_TYPE,
  SCHEDULE_TYPE,
  WEBHOOK_TYPE,
} from "./deep-observe-hooks";

/** The list endpoint each declarable kind is read from. */
export const KIND_PATHS: Record<string, string> = {
  [ENVIRONMENT_TYPE]: "environments",
  [VAULT_TYPE]: "vaults",
  [AGENT_TYPE]: "agents",
  [TEAMMATE_TYPE]: "team",
  [SCHEDULE_TYPE]: "team/schedules",
  [WEBHOOK_TYPE]: "webhooks",
};

/** Ownership verdicts, as `ResourceMetadata.ownership` spells them. */
export type Ownership = "owned" | "foreign" | "unknown";

/** One live record, with the handful of fields identity and ownership read by name. */
export interface LiveRecord extends Record<string, unknown> {
  id?: string;
  name?: string;
  url?: string;
  agent_id?: string;
  metadata?: Record<string, unknown>;
}

export interface DeclaredEntityProps {
  entityType: string;
  props: Record<string, unknown>;
}

/**
 * Joins the two halves of a composite key. NUL, because it cannot occur in a
 * fountain name and so cannot make two different pairs collide on one string.
 */
export const KEY_SEPARATOR = "\u0000";

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

/**
 * The key a declared entity is looked up under. `undefined` means the
 * declaration does not resolve to an identity at all — a schedule whose
 * `teammate` reference names nothing, a webhook with no url — which a reader
 * must report as a failed read rather than an absence.
 */
export function declaredKey(
  entityType: string,
  entityName: string,
  props: Record<string, unknown>,
  index: Map<Record<string, unknown>, string>,
): string | undefined {
  if (entityType === WEBHOOK_TYPE) {
    return typeof props.url === "string" && props.url.length > 0 ? props.url : undefined;
  }
  if (entityType === SCHEDULE_TYPE) {
    const teammate = referencedName(props.teammate, index);
    if (!teammate) return undefined;
    return `${teammate}${KEY_SEPARATOR}${effectiveName(entityName, props)}`;
  }
  return effectiveName(entityName, props);
}

/**
 * The key a live record is indexed under, in the same vocabulary
 * {@link declaredKey} produces. `roster` maps `agent_id` to the teammate name,
 * which only a schedule needs.
 */
export function liveKey(
  entityType: string,
  record: LiveRecord,
  roster: ReadonlyMap<string, LiveRecord>,
): string | undefined {
  if (entityType === WEBHOOK_TYPE) {
    return typeof record.url === "string" && record.url.length > 0 ? record.url : undefined;
  }
  if (entityType === SCHEDULE_TYPE) {
    const teammate = roster.get(String(record.agent_id))?.name;
    if (typeof teammate !== "string") return undefined;
    return `${teammate}${KEY_SEPARATOR}${typeof record.name === "string" ? record.name : ""}`;
  }
  return typeof record.name === "string" && record.name.length > 0 ? record.name : undefined;
}

/** The agent a teammate or a schedule inherits its ownership from, if the roster knows it. */
function agentBehind(
  entityType: string,
  record: LiveRecord,
  roster: ReadonlyMap<string, LiveRecord>,
): { metadata?: unknown } | undefined {
  if (entityType === TEAMMATE_TYPE && record.agent && typeof record.agent === "object") {
    return record.agent as { metadata?: unknown };
  }
  const teammate = roster.get(String(record.agent_id));
  const agent = teammate?.agent;
  return agent && typeof agent === "object" ? (agent as { metadata?: unknown }) : undefined;
}

/** Live ownership verdict for one record. See the module doc for the inheritance rule. */
export function ownershipOf(
  entityType: string,
  record: LiveRecord,
  roster: ReadonlyMap<string, LiveRecord>,
): Ownership {
  if (entityType === WEBHOOK_TYPE) return "unknown";
  if (entityType === TEAMMATE_TYPE || entityType === SCHEDULE_TYPE) {
    const agent = agentBehind(entityType, record, roster);
    if (!agent) return "unknown";
    return isChantOwned(agent) ? "owned" : "foreign";
  }
  return isChantOwned(record) ? "owned" : "foreign";
}

/** Why a kind's ownership verdict came out `unknown`, for a `filtered` detail line. */
export function ownershipGap(entityType: string): string {
  if (entityType === WEBHOOK_TYPE) {
    return "fountain stores no metadata on a webhook endpoint, so chant has no ownership marker to read";
  }
  return "the agent behind it is not on the team roster, so there is no marker to inherit";
}

const NO_ROSTER: ReadonlyMap<string, LiveRecord> = new Map();

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
  private rosterPending?: Promise<Map<string, LiveRecord>>;

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

  /** The team roster by `agent_id` — the join a schedule's identity and ownership need. */
  roster(): Promise<Map<string, LiveRecord>> {
    if (!this.rosterPending) {
      this.rosterPending = (async () => {
        const rows = await this.raw(TEAMMATE_TYPE);
        const byAgent = new Map<string, LiveRecord>();
        for (const row of rows) {
          if (typeof row.agent_id === "string") byAgent.set(row.agent_id, row);
        }
        return byAgent;
      })();
    }
    return this.rosterPending;
  }

  /** Records of a kind, indexed by the key a declaration is looked up under. */
  byKey(entityType: string): Promise<Map<string, LiveRecord>> {
    const cached = this.keyed.get(entityType);
    if (cached) return cached;

    const pending = (async () => {
      const rows = await this.raw(entityType);
      const roster = this.needsRoster(entityType) ? await this.roster() : NO_ROSTER;
      const byKey = new Map<string, LiveRecord>();
      for (const row of rows) {
        const key = liveKey(entityType, row, roster);
        if (key !== undefined) byKey.set(key, row);
      }
      return byKey;
    })();

    this.keyed.set(entityType, pending);
    return pending;
  }

  /**
   * The roster, for a kind whose identity or ownership joins through it, and an
   * empty one otherwise — so reading an environment never fetches the team.
   */
  async rosterFor(entityType: string): Promise<ReadonlyMap<string, LiveRecord>> {
    return entityType === SCHEDULE_TYPE || entityType === TEAMMATE_TYPE ? this.roster() : NO_ROSTER;
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

  private needsRoster(entityType: string): boolean {
    return entityType === SCHEDULE_TYPE;
  }
}
