/**
 * One drift record across engines (#4450, #4451).
 *
 * Drift had four vocabularies for one question: the converge observers'
 * `in-sync | drifted | unknown` (`./lifecycle/symptoms.ts`), component
 * status's `reconciled | unrecorded | stale | drifted | unknown`
 * (`./lifecycle/status.ts`), the graph overlay's tones, and the live diff's
 * buckets (`./lifecycle/live-diff.ts`). A renderer colouring a terraform, a
 * choudoufu and a chant member side by side had to know all four, and behold
 * read choudoufu's documents itself. This module is the one shape they all
 * become: a {@link DriftRecord} per resource instance, and a
 * {@link DriftDocument} (`drift: "v1"`) that holds them. Its schema is
 * `./workspace/drift.schema.json`, `$id` {@link DRIFT_SCHEMA_ID}.
 *
 * A record says which read answered (`read`) and what it found (`status`).
 * The two travel together because they are different claims: a `state` read
 * says what the last apply recorded and can never say the account matches,
 * so {@link driftRecord} refuses a state read whose status is anything but
 * `recorded`, `pending` or `not-observed`. Every record goes through that
 * constructor, so the rule holds for every adapter, and for a document read
 * back with {@link parseDriftDocument}.
 *
 * `not-observed` is never absence. It always carries a reason from the
 * observation contract's closed list (`./observation.ts`), and
 * `not-reached` is the reason a stream gives an address it expected and
 * never heard about ({@link driftSettle}).
 *
 * ## Redaction
 *
 * An attribute the planner marked sensitive keeps its path and loses both
 * values (`sensitive: true`), as the change set spells it
 * (`./change-set.ts`). A second pass redacts any path with a segment
 * {@link isSensitiveKey} names, whatever the planner said, so an engine
 * that marks nothing still never ships a `password` value. Values are
 * optional: a card needs only the names.
 *
 * ## Not digest-bound
 *
 * A drift read authorizes nothing and goes stale on the next read, so a
 * record is ephemeral. {@link driftDocumentDigest} exists for one case, a
 * WatchOp writing its document into its own run ledger as evidence, and
 * leaves out `observedAt` and `evidence`, which change on every read.
 *
 * ## Adapters
 *
 * The chant ones are here: `lifecycle diff --live` ({@link liveDiffDriftRecords}),
 * deep observe ({@link deepDiffDriftRecords}, {@link mergeDeepDrift}) and
 * component status ({@link componentStatusDriftRecords}). The terraform and
 * choudoufu ones live in the terraform lexicon's `drift-record` subpath,
 * beside its readers, and the Pulumi one (`refresh --preview-only`, #4453)
 * in the pulumi lexicon's.
 *
 * ## The graph and the rollup
 *
 * A record's `node` and `instanceOf` come from the change set's own rule
 * (`graphNodeFor`, #4454), and a block's status from core's one rollup
 * (`rollupInstances`) over {@link DRIFT_INSTANCE_ROLLUP}. Neither is
 * written a second time here.
 *
 * ## The import graph
 *
 * This module ships in the change-set bundle (`change-set-bundle.test.ts`,
 * #3421): at run time it imports the plan digest, the observation
 * contract's reason list, the change-set graph's node rule, the instance
 * rollup and the sensitive-key list, and types only otherwise.
 */

import { graphNodeFor, type ChangeSetGraphNodes } from "./change-set-graph";
import type { ChangeSetPlanner } from "./change-set";
import { rollupInstances } from "./instance-nodes";
import { computePlanDigest } from "./lifecycle/plan-digest";
import type { DeepDiffResult } from "./lifecycle/deep-diff";
import type { LiveDiffResult } from "./lifecycle/live-diff";
import type { ComponentStatusRow } from "./lifecycle/status";
import { isUnobservedReason, type UnobservedReason } from "./observation";
import { isSensitiveKey } from "./sensitive-key";

/** The schema a drift document names in `$schema`. */
export const DRIFT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/drift/v1/drift.schema.json";

/** The document's version. */
export const DRIFT_VERSION = "v1";

/**
 * Which engine read the resource: a change-set planner (`pulumi` among them
 * since #4453), or plunge, which has no planner of its own. A plunge
 * address is a Pulumi URN, so a plunge record is placed on the graph by the
 * `pulumi` planner's rule ({@link driftPlanner}).
 */
export type DriftEngine = ChangeSetPlanner | "plunge";

/** The planner whose node rule places an engine's records: plunge's URNs go by `pulumi`'s (#4453). */
export function driftPlanner(engine: DriftEngine): ChangeSetPlanner {
  return engine === "plunge" ? "pulumi" : engine;
}

const DRIFT_ENGINE_WITNESS: Record<DriftEngine, true> = {
  terraform: true,
  tofu: true,
  choudoufu: true,
  chant: true,
  warden: true,
  sql: true,
  pulumi: true,
  plunge: true,
};

/** Every engine, in the order the schema lists them. */
export const DRIFT_ENGINES = Object.keys(DRIFT_ENGINE_WITNESS) as readonly DriftEngine[];

/**
 * Which read answered.
 *
 * - `state` — the engine's state file: what the last apply recorded.
 * - `plan` — a plan: what the next apply would do, after a refresh.
 * - `refresh` — a refresh preview (Pulumi's `refresh --preview-only`).
 * - `live-read` — chant's own read of the provider.
 * - `ownership` — an ownership read (choudoufu's `live-plan` and `live-ls`),
 *   which says who holds each object and not what its attributes are.
 */
export type DriftRead = "state" | "plan" | "refresh" | "live-read" | "ownership";

const DRIFT_READ_WITNESS: Record<DriftRead, true> = { state: true, plan: true, refresh: true, "live-read": true, ownership: true };

/** Every read, in the order the schema lists them. */
export const DRIFT_READS = Object.keys(DRIFT_READ_WITNESS) as readonly DriftRead[];

/**
 * What the read found.
 *
 * - `in-sync` — present, and nothing the read compares differs.
 * - `drifted` — present, and something differs; `attributes` says what.
 * - `pending` — declared and confirmed absent, never deployed.
 * - `missing` — recorded or deployed, and now gone.
 * - `unclaimed` — something live sits at a declared identity and does not
 *   carry this member's marker: adoptable, or held by someone else.
 * - `undeclared` — live or recorded, and the member does not declare it.
 * - `runtime` — live, undeclared, and expected: a controller's child.
 * - `recorded` — in the engine's state. The only presence a state read gives.
 * - `not-observed` — the read could not say; `unobserved` says why.
 */
export type DriftStatus =
  | "in-sync"
  | "drifted"
  | "pending"
  | "missing"
  | "unclaimed"
  | "undeclared"
  | "runtime"
  | "recorded"
  | "not-observed";

const DRIFT_STATUS_WITNESS: Record<DriftStatus, true> = {
  "in-sync": true,
  drifted: true,
  pending: true,
  missing: true,
  unclaimed: true,
  undeclared: true,
  runtime: true,
  recorded: true,
  "not-observed": true,
};

/** Every status, in the order the schema lists them. */
export const DRIFT_STATUSES = Object.keys(DRIFT_STATUS_WITNESS) as readonly DriftStatus[];

/** The only statuses a `state` read may give. It never says in-sync or drifted. */
export const STATE_READ_STATUSES: readonly DriftStatus[] = ["recorded", "pending", "not-observed"];

/** Who an ownership facet says holds the object. */
export type DriftOwnershipVerdict = "owned" | "foreign" | "adoptable" | "unknown";

const OWNERSHIP_VERDICT_WITNESS: Record<DriftOwnershipVerdict, true> = { owned: true, foreign: true, adoptable: true, unknown: true };

/** Every ownership verdict. */
export const DRIFT_OWNERSHIP_VERDICTS = Object.keys(OWNERSHIP_VERDICT_WITNESS) as readonly DriftOwnershipVerdict[];

/** What the ownership verdict rests on. */
export type DriftOwnershipBy = "marker" | "derived" | "record" | "cache" | "state" | "label";

const OWNERSHIP_BY_WITNESS: Record<DriftOwnershipBy, true> = { marker: true, derived: true, record: true, cache: true, state: true, label: true };

/** Every ownership basis. */
export const DRIFT_OWNERSHIP_BY = Object.keys(OWNERSHIP_BY_WITNESS) as readonly DriftOwnershipBy[];

/**
 * One attribute that differs. `before` is what was expected (the record, the
 * snapshot, the declaration) and `after` what the read found. A path in the
 * plan-observation grammar: keys joined with `.`, indexes and keys that are
 * not identifiers in brackets (`tags["kubernetes.io/role"]`).
 */
export interface DriftAttribute {
  path: string;
  before?: unknown;
  after?: unknown;
  /** The planner marked it sensitive, or its name looks secret-bearing, so neither value is carried. */
  sensitive?: true;
}

/** Why a record is `not-observed`. */
export interface DriftUnobserved {
  reason: UnobservedReason;
  detail?: string;
  /** The address the read was issued against, when the engine reported one. */
  queried?: string;
}

/** Who holds the object, from an ownership read. */
export interface DriftOwnership {
  verdict: DriftOwnershipVerdict;
  by?: DriftOwnershipBy;
  /** The marker was read off the object itself, not derived or remembered. */
  markerOnObject?: boolean;
  /** The estate, stack or controller that does hold it, when not this member. */
  ownedBy?: string;
  /** The address an adoption would write onto the object. */
  adopt?: string;
}

/** What produced the record. */
export interface DriftEvidence {
  tool: string;
  version?: string;
  command?: string;
  /** The engine's own token for the verdict (`UNOWNED`, `NEEDS_DISCOVERY`, `ABSENT`), so a pane can show it. */
  engineCode?: string;
}

export interface DriftRecord {
  member: string;
  engine: DriftEngine;
  /** The engine's own address, at instance level: `aws_eip.pool[0]`, a Pulumi URN, a chant entity name. */
  address: string;
  /** The resource type, when the read reports one. Not `type`, which a stream line uses for its kind. */
  resourceType?: string;
  /**
   * The graph node, by the change set's mapping rules (`graphNodeFor` in
   * `./change-set-graph.ts`, {@link mapDriftToGraph}): for an instance of a
   * `count` or `for_each` block the instance node, `<blockNode>[0]` or
   * `<blockNode>["a"]`, and the block node otherwise. Null when the graph
   * holds none. A Pulumi URN's node is `<member>/<key>` by the URN rule
   * (#4456), and a plunge URN's by the same rule (#4453).
   */
  node: string | null;
  /** On a record whose `node` is an instance node (#4454): the block node it is an instance of, the rollup. */
  instanceOf?: string;
  /** RFC 3339. Per record, because a stream's rows finish at different times. */
  observedAt: string;
  read: DriftRead;
  /**
   * The read that was asked for and failed, when this one answered instead:
   * what `RootRead.depth` holds (`"plan"`, `"live+plan"`) on a root whose
   * `RootRead.fellBackTo` is set (`./observation.ts`).
   */
  fellBackFrom?: string;
  status: DriftStatus;
  /** Set exactly when `status` is `not-observed`. */
  unobserved?: DriftUnobserved;
  /** What differs. Only on `drifted`. */
  attributes?: DriftAttribute[];
  /**
   * Presence is known and the attributes are not: a deep read that failed
   * for an entity the thin read found. On `in-sync` and `drifted` only.
   */
  attributesUnobserved?: DriftUnobserved;
  ownership?: DriftOwnership;
  evidence: DriftEvidence;
}

/** Counts per status, every status present. */
export type DriftCounts = Record<DriftStatus, number>;

export interface DriftDocument {
  $schema: typeof DRIFT_SCHEMA_ID;
  drift: typeof DRIFT_VERSION;
  /** The chant that wrote it, when known. */
  chant?: string;
  /** Sorted by member, address and read. One per `(member, address, read)`. */
  records: DriftRecord[];
  counts: DriftCounts;
}

/** Which rule a refused record broke. */
export type DriftRecordRule =
  | "shape"
  | "state-read-status"
  | "unobserved-reason"
  | "unobserved-on-observed"
  | "attributes-status"
  | "attributes-unobserved-status";

/** A record {@link driftRecord} refused, naming the record and the rule. */
export class DriftRecordError extends Error {
  readonly rule: DriftRecordRule;
  constructor(rule: DriftRecordRule, message: string) {
    super(message);
    this.name = "DriftRecordError";
    this.rule = rule;
  }
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isRecordObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** RFC 3339 date-time, as JSON Schema's `date-time` format reads it. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/**
 * The key segments of an attribute path, indexes left out:
 * `spec.env[0]["db_password"]` is `spec`, `env`, `db_password`. A keyed
 * element (`Tags[#api-token-owner].Value`, the deep read's address for an
 * array it can key) is a key too: it names the element the way a map key
 * does, so an environment list keyed by `DB_PASSWORD` redacts like a map's.
 */
export function attributePathKeys(path: string): string[] {
  const keys: string[] = [];
  let current = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === ".") {
      if (current) keys.push(current);
      current = "";
    } else if (c === "[") {
      if (current) keys.push(current);
      current = "";
      if (path[i + 1] === '"') {
        let key = "";
        let j = i + 2;
        for (; j < path.length && path[j] !== '"'; j++) {
          if (path[j] === "\\" && j + 1 < path.length) j++;
          key += path[j];
        }
        keys.push(key);
        i = path.indexOf("]", j);
        if (i < 0) break;
      } else if (path[i + 1] === "#") {
        const close = path.indexOf("]", i);
        if (close < 0) break;
        keys.push(path.slice(i + 2, close));
        i = close;
      } else {
        const close = path.indexOf("]", i);
        if (close < 0) break;
        i = close; // a numeric index: not a key
      }
    } else current += c;
  }
  if (current) keys.push(current);
  return keys;
}

/**
 * One attribute, redacted: the planner's mark first, then any key segment
 * {@link isSensitiveKey} names. A redacted attribute is `{ path, sensitive:
 * true }` and nothing else.
 */
export function redactDriftAttribute(attribute: DriftAttribute): DriftAttribute {
  if (attribute.sensitive === true || attributePathKeys(attribute.path).some(isSensitiveKey)) {
    return { path: attribute.path, sensitive: true };
  }
  return {
    path: attribute.path,
    ...(attribute.before !== undefined ? { before: attribute.before } : {}),
    ...(attribute.after !== undefined ? { after: attribute.after } : {}),
  };
}

function checkUnobserved(value: unknown, where: string, field: string): DriftUnobserved {
  if (!isRecordObject(value)) throw new DriftRecordError("unobserved-reason", `${where}: ${field} needs a reason`);
  if (!isUnobservedReason(value.reason)) {
    throw new DriftRecordError("unobserved-reason", `${where}: ${field}.reason ${JSON.stringify(value.reason)} is not an unobserved reason`);
  }
  return {
    reason: value.reason,
    ...(nonEmpty(value.detail) ? { detail: value.detail } : {}),
    ...(nonEmpty(value.queried) ? { queried: value.queried } : {}),
  };
}

function checkOwnership(value: unknown, where: string): DriftOwnership {
  if (!isRecordObject(value) || !(DRIFT_OWNERSHIP_VERDICTS as readonly unknown[]).includes(value.verdict)) {
    throw new DriftRecordError("shape", `${where}: ownership.verdict must be one of ${DRIFT_OWNERSHIP_VERDICTS.join(", ")}`);
  }
  if (value.by !== undefined && !(DRIFT_OWNERSHIP_BY as readonly unknown[]).includes(value.by)) {
    throw new DriftRecordError("shape", `${where}: ownership.by ${JSON.stringify(value.by)} is not one of ${DRIFT_OWNERSHIP_BY.join(", ")}`);
  }
  if (value.markerOnObject !== undefined && typeof value.markerOnObject !== "boolean") {
    throw new DriftRecordError("shape", `${where}: ownership.markerOnObject must be a boolean`);
  }
  return {
    verdict: value.verdict as DriftOwnershipVerdict,
    ...(value.by !== undefined ? { by: value.by as DriftOwnershipBy } : {}),
    ...(typeof value.markerOnObject === "boolean" ? { markerOnObject: value.markerOnObject } : {}),
    ...(nonEmpty(value.ownedBy) ? { ownedBy: value.ownedBy } : {}),
    ...(nonEmpty(value.adopt) ? { adopt: value.adopt } : {}),
  };
}

/**
 * Build one record, or refuse it. Every adapter and every reader goes
 * through here, so these hold for every record that exists:
 *
 * - a `state` read's status is `recorded`, `pending` or `not-observed`;
 * - `not-observed` carries `unobserved` with a legal reason, and no other
 *   status carries it;
 * - `attributes` appear only on `drifted`, sorted by path, one per path,
 *   and redacted ({@link redactDriftAttribute});
 * - `attributesUnobserved` appears only on `in-sync` or `drifted`.
 *
 * A refusal is a {@link DriftRecordError} naming the member, the address,
 * the read and the status.
 */
export function driftRecord(input: DriftRecord): DriftRecord {
  const raw = input as unknown as Record<string, unknown>;
  if (!isRecordObject(raw)) throw new DriftRecordError("shape", "a drift record must be an object");
  const where = `drift record ${JSON.stringify(raw.address)} in member ${JSON.stringify(raw.member)} (${String(raw.read)} read, ${String(raw.status)})`;
  if (!nonEmpty(raw.member)) throw new DriftRecordError("shape", `${where}: member must be a non-empty string`);
  if (!nonEmpty(raw.address)) throw new DriftRecordError("shape", `${where}: address must be a non-empty string`);
  if (!(DRIFT_ENGINES as readonly unknown[]).includes(raw.engine)) {
    throw new DriftRecordError("shape", `${where}: engine ${JSON.stringify(raw.engine)} is not one of ${DRIFT_ENGINES.join(", ")}`);
  }
  if (!(DRIFT_READS as readonly unknown[]).includes(raw.read)) {
    throw new DriftRecordError("shape", `${where}: read ${JSON.stringify(raw.read)} is not one of ${DRIFT_READS.join(", ")}`);
  }
  if (!(DRIFT_STATUSES as readonly unknown[]).includes(raw.status)) {
    throw new DriftRecordError("shape", `${where}: status ${JSON.stringify(raw.status)} is not one of ${DRIFT_STATUSES.join(", ")}`);
  }
  if (raw.node !== null && !nonEmpty(raw.node)) throw new DriftRecordError("shape", `${where}: node must be a graph id or null`);
  if (typeof raw.observedAt !== "string" || !RFC3339.test(raw.observedAt)) {
    throw new DriftRecordError("shape", `${where}: observedAt ${JSON.stringify(raw.observedAt)} is not an RFC 3339 date-time`);
  }
  if (raw.instanceOf !== undefined && (!nonEmpty(raw.instanceOf) || raw.node === null)) {
    throw new DriftRecordError("shape", `${where}: instanceOf must be a block node id, beside a node`);
  }
  if (raw.fellBackFrom !== undefined && !nonEmpty(raw.fellBackFrom)) throw new DriftRecordError("shape", `${where}: fellBackFrom must be a non-empty string`);
  if (raw.resourceType !== undefined && !nonEmpty(raw.resourceType)) throw new DriftRecordError("shape", `${where}: resourceType must be a non-empty string`);
  if (!isRecordObject(raw.evidence) || !nonEmpty(raw.evidence.tool)) throw new DriftRecordError("shape", `${where}: evidence.tool must be a non-empty string`);

  const read = raw.read as DriftRead;
  const status = raw.status as DriftStatus;

  if (read === "state" && !STATE_READ_STATUSES.includes(status)) {
    throw new DriftRecordError(
      "state-read-status",
      `${where}: a state read says what the last apply recorded, so it can only be ${STATE_READ_STATUSES.join(", ")}, never ${status}`,
    );
  }

  let unobserved: DriftUnobserved | undefined;
  if (status === "not-observed") {
    if (raw.unobserved === undefined) throw new DriftRecordError("unobserved-reason", `${where}: not-observed needs unobserved.reason`);
    unobserved = checkUnobserved(raw.unobserved, where, "unobserved");
  } else if (raw.unobserved !== undefined) {
    throw new DriftRecordError("unobserved-on-observed", `${where}: only not-observed carries unobserved`);
  }

  let attributes: DriftAttribute[] | undefined;
  if (raw.attributes !== undefined) {
    if (status !== "drifted") throw new DriftRecordError("attributes-status", `${where}: only drifted carries attributes`);
    if (!Array.isArray(raw.attributes)) throw new DriftRecordError("shape", `${where}: attributes must be an array`);
    const byPath = new Map<string, DriftAttribute>();
    for (const [i, a] of raw.attributes.entries()) {
      if (!isRecordObject(a) || !nonEmpty(a.path)) throw new DriftRecordError("shape", `${where}: attributes[${i}] needs a path`);
      if (a.sensitive !== undefined && a.sensitive !== true) throw new DriftRecordError("shape", `${where}: attributes[${i}].sensitive must be true when set`);
      const redacted = redactDriftAttribute(a as unknown as DriftAttribute);
      const earlier = byPath.get(redacted.path);
      // Two rows at one path (a block's instances share none, so this is one
      // instance reported twice): a redaction on either redacts the path.
      byPath.set(redacted.path, earlier?.sensitive === true ? earlier : redacted);
    }
    attributes = [...byPath.values()].sort((a, b) => byString(a.path, b.path));
  }

  let attributesUnobserved: DriftUnobserved | undefined;
  if (raw.attributesUnobserved !== undefined) {
    if (status !== "in-sync" && status !== "drifted") {
      throw new DriftRecordError("attributes-unobserved-status", `${where}: only in-sync or drifted carries attributesUnobserved`);
    }
    attributesUnobserved = checkUnobserved(raw.attributesUnobserved, where, "attributesUnobserved");
  }

  const ev = raw.evidence;
  return {
    member: raw.member,
    engine: raw.engine as DriftEngine,
    address: raw.address,
    ...(raw.resourceType !== undefined ? { resourceType: raw.resourceType as string } : {}),
    node: raw.node as string | null,
    ...(raw.instanceOf !== undefined ? { instanceOf: raw.instanceOf as string } : {}),
    observedAt: raw.observedAt,
    read,
    ...(raw.fellBackFrom !== undefined ? { fellBackFrom: raw.fellBackFrom as string } : {}),
    status,
    ...(unobserved ? { unobserved } : {}),
    ...(attributes ? { attributes } : {}),
    ...(attributesUnobserved ? { attributesUnobserved } : {}),
    ...(raw.ownership !== undefined ? { ownership: checkOwnership(raw.ownership, where) } : {}),
    evidence: {
      tool: ev.tool as string,
      ...(nonEmpty(ev.version) ? { version: ev.version } : {}),
      ...(nonEmpty(ev.command) ? { command: ev.command } : {}),
      ...(nonEmpty(ev.engineCode) ? { engineCode: ev.engineCode } : {}),
    },
  };
}

/** Read one record from parsed JSON. The same checks as {@link driftRecord}. */
export function parseDriftRecord(value: unknown): DriftRecord {
  if (!isRecordObject(value)) throw new DriftRecordError("shape", "a drift record must be an object");
  return driftRecord(value as unknown as DriftRecord);
}

function recordKey(r: Pick<DriftRecord, "member" | "address" | "read">): string {
  return `${r.member}\u0000${r.address}\u0000${r.read}`;
}

/** Counts per status, zero included. */
export function countDriftStatuses(records: Iterable<Pick<DriftRecord, "status">>): DriftCounts {
  const counts = Object.fromEntries(DRIFT_STATUSES.map((s) => [s, 0])) as DriftCounts;
  for (const r of records) counts[r.status]++;
  return counts;
}

export interface DriftDocumentOptions {
  /** The chant version to record in `chant`. */
  chant?: string;
}

/**
 * Join records into one document. A later record for the same `(member,
 * address, read)` replaces the earlier one, as a stream's later line does.
 * Records are sorted by member, address and read. Every record is checked
 * with {@link driftRecord}.
 */
export function driftDocument(records: Iterable<DriftRecord>, options: DriftDocumentOptions = {}): DriftDocument {
  const latest = new Map<string, DriftRecord>();
  for (const r of records) {
    const checked = driftRecord(r);
    latest.set(recordKey(checked), checked);
  }
  const sorted = [...latest.entries()].sort(([a], [b]) => byString(a, b)).map(([, r]) => r);
  return {
    $schema: DRIFT_SCHEMA_ID,
    drift: DRIFT_VERSION,
    ...(options.chant !== undefined ? { chant: options.chant } : {}),
    records: sorted,
    counts: countDriftStatuses(sorted),
  };
}

/** Read a document from parsed JSON, checking every record. Counts are recomputed. */
export function parseDriftDocument(value: unknown): DriftDocument {
  if (!isRecordObject(value)) throw new DriftRecordError("shape", "a drift document must be an object");
  if (value.drift !== DRIFT_VERSION) throw new DriftRecordError("shape", `a drift document says drift ${JSON.stringify(value.drift)}, not "${DRIFT_VERSION}"`);
  if (!Array.isArray(value.records)) throw new DriftRecordError("shape", "a drift document needs a records array");
  return driftDocument(value.records.map(parseDriftRecord), nonEmpty(value.chant) ? { chant: value.chant } : {});
}

/**
 * The document's digest, for a WatchOp that keeps its document as evidence
 * in its own run ledger: `computePlanDigest("drift-document", …)` over the
 * records sorted as {@link driftDocument} sorts them, without `observedAt`
 * and `evidence`, which change on every read. No gate binds it.
 */
export function driftDocumentDigest(doc: Pick<DriftDocument, "records">): string {
  const records = [...doc.records]
    .sort((a, b) => byString(recordKey(a), recordKey(b)))
    .map(({ observedAt: _at, evidence: _evidence, ...r }) => r);
  return computePlanDigest("drift-document", records);
}

// ── the block rollup ───────────────────────────────────────────────────────────

/**
 * The precedence a block's instance records roll up in, most significant
 * first, for core's one rollup (`rollupInstances` in `./instance-nodes.ts`,
 * #4454). Partial knowledge is not knowledge, so one not-observed instance
 * makes the block not-observed, as `TERRAFORM_INSTANCE_ROLLUP` puts
 * `unobserved` first. A difference outranks an absence, an absence
 * outranks agreement, and `runtime` is last because a controller's children
 * never decide a block.
 */
export const DRIFT_INSTANCE_ROLLUP: readonly DriftStatus[] = [
  "not-observed",
  "drifted",
  "missing",
  "unclaimed",
  "undeclared",
  "pending",
  "in-sync",
  "recorded",
  "runtime",
];

/** One block node's rolled-up status and the records it came from. */
export interface DriftBlockRollup {
  /** The block node: the records' `instanceOf`, or their `node` when they are on the block itself. */
  node: string;
  status: DriftStatus;
  /** Every read that answered for the block's records, sorted. */
  reads: DriftRead[];
  records: DriftRecord[];
}

/**
 * Records grouped by block node (`instanceOf`, else `node`) and rolled up
 * with `rollupInstances` over {@link DRIFT_INSTANCE_ROLLUP}. A record with a
 * null `node` is on no block and is left out. Sorted by node.
 */
export function rollupDriftByBlock(records: Iterable<DriftRecord>): DriftBlockRollup[] {
  const groups = new Map<string, DriftRecord[]>();
  for (const r of records) {
    const block = r.instanceOf ?? r.node;
    if (block === null) continue;
    const list = groups.get(block) ?? [];
    list.push(r);
    groups.set(block, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([node, list]) => ({
      node,
      status: rollupInstances(list.map((r) => ({ kind: r.status })), DRIFT_INSTANCE_ROLLUP)!.kind,
      reads: [...new Set(list.map((r) => r.read))].sort(byString),
      records: list,
    }));
}

/**
 * The document with each record's `node` and `instanceOf` set from `graph`
 * by `graphNodeFor` (`./change-set-graph.ts`), the rule a change-set entry
 * uses, so a drift row and a change-set entry for one instance name the
 * same node: an instance of a `count` or `for_each` block is on
 * `<blockNode>[0]` with `instanceOf` the block node, and an instance under
 * an expanded module call is on `<root>/module.app[0]/<block>[1]` with the
 * same `instanceOf` (#4486). A Pulumi URN is on
 * `<member>/<key>` by the URN rule (`./pulumi-urn.ts`, #4456), through the
 * `pulumi` planner's case, and so is a plunge URN ({@link driftPlanner}).
 * A null `graph` gives every record `node: null`.
 */
export function mapDriftToGraph(doc: DriftDocument, graph: ChangeSetGraphNodes | null): DriftDocument {
  return {
    ...doc,
    records: doc.records.map(({ instanceOf: _i, ...r }) => {
      if (graph === null) return { ...r, node: null };
      const placed = graphNodeFor({ member: r.member, planner: driftPlanner(r.engine), address: r.address }, graph);
      return { ...r, node: placed.node, ...(placed.instanceOf !== undefined ? { instanceOf: placed.instanceOf } : {}) };
    }),
  };
}

// ── streaming ──────────────────────────────────────────────────────────────────

/**
 * The NDJSON stream, one JSON object per line, built like the run-event
 * stream and in the layout choudoufu's `live-plan -resource` writes
 * (choudoufu `internal/command/views/live_drift.go`): every line has a
 * `type`, `drift-start`, `drift-record` or `drift-settle`, and a record
 * line is the record itself with `type` beside its fields.
 */

/** One address a stream expects to hear about, with the node and type a not-reached record should carry. */
export interface DriftExpected {
  address: string;
  node?: string | null;
  instanceOf?: string;
  resourceType?: string;
}

/** Opens a member's read: which member, engine and read, and every address it expects. */
export interface DriftStartLine {
  type: "drift-start";
  drift: typeof DRIFT_VERSION;
  member: string;
  engine: DriftEngine;
  read: DriftRead;
  /** The one address the read was asked about, on a single-resource read (`live-plan -resource`). */
  resource?: string;
  fellBackFrom?: string;
  /** RFC 3339, when the writer gives it. */
  at?: string;
  /** Bare addresses, or addresses with the node and type a not-reached record is given. */
  expected: Array<string | DriftExpected>;
  /** The evidence a not-reached record is given. Default `{ tool: <engine> }`. */
  evidence?: DriftEvidence;
}

/** One record, as its read finishes: the record's own fields beside `type`. A later line for the same `(member, address, read)` replaces it. */
export type DriftRecordLine = DriftRecord & { type: "drift-record" };

/** Closes a member's read. */
export interface DriftSettleLine {
  type: "drift-settle";
  drift: typeof DRIFT_VERSION;
  member: string;
  engine: DriftEngine;
  read: DriftRead;
  /** Records per status. A writer may leave out a status it has none of. */
  counts: Partial<DriftCounts>;
  /** The engine's own account of what the read cost (choudoufu: `recordsRead`, `sweepCalls`, ...). Carried, never interpreted. */
  reads?: Record<string, unknown>;
  /** RFC 3339, when the writer gives it: every not-reached record's `observedAt`. */
  at?: string;
  /**
   * Expected addresses with no record line, when the writer lists them. A
   * reader treats every expected address with no record as not-reached
   * whether or not this is given; a writer that emits its own not-reached
   * records (choudoufu does) leaves it out.
   */
  notReached?: string[];
}

export type DriftLine = DriftStartLine | DriftRecordLine | DriftSettleLine;

/** A start line's expected entries, bare addresses made objects. */
export function driftExpected(start: Pick<DriftStartLine, "expected">): DriftExpected[] {
  return start.expected.map((e) => (typeof e === "string" ? { address: e } : e));
}

/** A record as its stream line. */
export function driftRecordLine(record: DriftRecord): DriftRecordLine {
  return { type: "drift-record", ...record };
}

/** One line of the stream, newline-terminated. */
export function encodeDriftLine(line: DriftLine): string {
  return `${JSON.stringify(line)}\n`;
}

/** The whole stream for one or more reads, in order. */
export function encodeDriftLines(lines: Iterable<DriftLine>): string {
  let out = "";
  for (const line of lines) out += encodeDriftLine(line);
  return out;
}

function checkStreamHead(v: Record<string, unknown>, type: string): void {
  if (v.drift !== DRIFT_VERSION) throw new DriftRecordError("shape", `a ${type} line says drift ${JSON.stringify(v.drift)}, not "${DRIFT_VERSION}"`);
  if (!nonEmpty(v.member)) throw new DriftRecordError("shape", `a ${type} line needs a member`);
  if (!(DRIFT_ENGINES as readonly unknown[]).includes(v.engine)) throw new DriftRecordError("shape", `a ${type} line for ${v.member} names engine ${JSON.stringify(v.engine)}`);
  if (!(DRIFT_READS as readonly unknown[]).includes(v.read)) throw new DriftRecordError("shape", `a ${type} line for ${v.member} names read ${JSON.stringify(v.read)}`);
  if (v.at !== undefined && (typeof v.at !== "string" || !RFC3339.test(v.at))) throw new DriftRecordError("shape", `a ${type} line for ${v.member} has an at that is not RFC 3339`);
}

/** Read one line, checking it. A record line goes through {@link driftRecord}. Unknown fields are dropped. */
export function decodeDriftLine(text: string): DriftLine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new DriftRecordError("shape", `a drift line is not JSON: ${(err as Error).message}`);
  }
  if (!isRecordObject(v)) throw new DriftRecordError("shape", "a drift line must be an object");
  switch (v.type) {
    case "drift-start": {
      checkStreamHead(v, "drift-start");
      if (!Array.isArray(v.expected)) throw new DriftRecordError("shape", `the drift-start line for ${v.member} needs an expected array`);
      const expected = v.expected.map((e, i): string | DriftExpected => {
        if (nonEmpty(e)) return e;
        if (!isRecordObject(e) || !nonEmpty(e.address)) throw new DriftRecordError("shape", `the drift-start line for ${v.member}: expected[${i}] needs an address`);
        return {
          address: e.address,
          ...(e.node === null || nonEmpty(e.node) ? { node: e.node as string | null } : {}),
          ...(nonEmpty(e.instanceOf) ? { instanceOf: e.instanceOf } : {}),
          ...(nonEmpty(e.resourceType) ? { resourceType: e.resourceType } : {}),
        };
      });
      if (v.evidence !== undefined && (!isRecordObject(v.evidence) || !nonEmpty(v.evidence.tool))) {
        throw new DriftRecordError("shape", `the drift-start line for ${v.member} has evidence with no tool`);
      }
      return {
        type: "drift-start",
        drift: DRIFT_VERSION,
        member: v.member as string,
        engine: v.engine as DriftEngine,
        read: v.read as DriftRead,
        ...(nonEmpty(v.resource) ? { resource: v.resource } : {}),
        ...(nonEmpty(v.fellBackFrom) ? { fellBackFrom: v.fellBackFrom } : {}),
        ...(v.at !== undefined ? { at: v.at as string } : {}),
        expected,
        ...(v.evidence !== undefined ? { evidence: v.evidence as unknown as DriftEvidence } : {}),
      };
    }
    case "drift-record": {
      const { type: _type, ...record } = v;
      return driftRecordLine(parseDriftRecord(record));
    }
    case "drift-settle": {
      checkStreamHead(v, "drift-settle");
      if (!isRecordObject(v.counts)) throw new DriftRecordError("shape", `the drift-settle line for ${v.member} needs counts`);
      const counts: Partial<DriftCounts> = {};
      for (const [s, n] of Object.entries(v.counts)) {
        if (!(DRIFT_STATUSES as readonly string[]).includes(s)) throw new DriftRecordError("shape", `the drift-settle line for ${v.member} counts status ${JSON.stringify(s)}`);
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new DriftRecordError("shape", `the drift-settle line for ${v.member}: counts.${s} must be a count`);
        counts[s as DriftStatus] = n;
      }
      if (v.notReached !== undefined && (!Array.isArray(v.notReached) || !v.notReached.every(nonEmpty))) {
        throw new DriftRecordError("shape", `the drift-settle line for ${v.member} has a notReached that is not a list of addresses`);
      }
      if (v.reads !== undefined && !isRecordObject(v.reads)) throw new DriftRecordError("shape", `the drift-settle line for ${v.member} has reads that is not an object`);
      return {
        type: "drift-settle",
        drift: DRIFT_VERSION,
        member: v.member as string,
        engine: v.engine as DriftEngine,
        read: v.read as DriftRead,
        counts,
        ...(v.reads !== undefined ? { reads: v.reads as Record<string, unknown> } : {}),
        ...(v.at !== undefined ? { at: v.at as string } : {}),
        ...(v.notReached !== undefined ? { notReached: [...(v.notReached as string[])].sort(byString) } : {}),
      };
    }
    default:
      throw new DriftRecordError("shape", `a drift line has type ${JSON.stringify(v.type)}, not drift-start, drift-record or drift-settle`);
  }
}

/** Every non-blank line of an NDJSON stream, decoded. */
export function decodeDriftLines(text: string): DriftLine[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(decodeDriftLine);
}

/** Open a read: the start line for a member's expected addresses, each once. */
export function driftStart(input: Omit<DriftStartLine, "type" | "drift">): DriftStartLine {
  const seen = new Set<string>();
  const expected = input.expected.filter((e) => {
    const address = typeof e === "string" ? e : e.address;
    return !seen.has(address) && seen.add(address);
  });
  return { type: "drift-start", drift: DRIFT_VERSION, ...input, expected };
}

type StreamHead = Pick<DriftStartLine, "member" | "engine" | "read" | "fellBackFrom" | "evidence">;

function notReachedRecord(head: StreamHead, expected: DriftExpected, at: string): DriftRecord {
  return driftRecord({
    member: head.member,
    engine: head.engine,
    address: expected.address,
    ...(expected.resourceType !== undefined ? { resourceType: expected.resourceType } : {}),
    node: expected.node ?? null,
    ...(expected.instanceOf !== undefined && expected.node ? { instanceOf: expected.instanceOf } : {}),
    observedAt: at,
    read: head.read,
    ...(head.fellBackFrom !== undefined ? { fellBackFrom: head.fellBackFrom } : {}),
    status: "not-observed",
    unobserved: { reason: "not-reached", detail: `the ${head.read} read settled without reporting ${expected.address}` },
    evidence: head.evidence ?? { tool: head.engine },
  });
}

/**
 * Close a read. `records` are the records sent since `start`, in order; a
 * later one for an address and read replaces an earlier one, and records
 * for another member are ignored. A record for an expected address answers
 * it whatever its read, since one read can answer an address with another
 * (a plan stream's unclaimed row is an `ownership` record). Every expected
 * address with no record becomes `not-observed / not-reached` at `at`.
 * Returns the settle line, which lists them in `notReached`, and the
 * member's final records.
 */
export function driftSettle(start: DriftStartLine, records: Iterable<DriftRecord>, at: string): { line: DriftSettleLine; records: DriftRecord[] } {
  const mine = new Map<string, DriftRecord>();
  const answered = new Set<string>();
  for (const r of records) {
    if (r.member !== start.member) continue;
    const checked = driftRecord(r);
    mine.set(recordKey(checked), checked);
    answered.add(checked.address);
  }
  const notReached: string[] = [];
  for (const e of driftExpected(start)) {
    if (answered.has(e.address)) continue;
    notReached.push(e.address);
    const r = notReachedRecord(start, e, at);
    mine.set(recordKey(r), r);
  }
  const final = [...mine.entries()].sort(([a], [b]) => byString(a, b)).map(([, r]) => r);
  return {
    line: {
      type: "drift-settle",
      drift: DRIFT_VERSION,
      member: start.member,
      engine: start.engine,
      read: start.read,
      counts: countDriftStatuses(final),
      at,
      notReached: notReached.sort(byString),
    },
    records: final,
  };
}

/** An address a started read expects and has not reported yet. Not a status: a settle always resolves it. */
export interface DriftReading {
  member: string;
  read: DriftRead;
  address: string;
  node: string | null;
}

/**
 * Fold a stream into a document. Record lines replace earlier ones for the
 * same `(member, address, read)`. At a settle line, every address its start
 * expected that no record answered (by member and address, whatever the
 * read) becomes `not-observed / not-reached`, with the node and type the
 * start gave, at the settle's `at`, else the start's, else the latest
 * record's `observedAt` in the stream; `notReached` addresses the start did
 * not list are added the same way. A start with no settle yet leaves its
 * unanswered addresses in `reading`, which a renderer shows as "reading"
 * and nothing else.
 */
export function foldDriftLines(lines: Iterable<DriftLine>, options: DriftDocumentOptions = {}): { document: DriftDocument; reading: DriftReading[] } {
  const records: DriftRecord[] = [];
  const answered = new Set<string>();
  const open = new Map<string, DriftStartLine>();
  let latest: string | undefined;
  const memberKey = (member: string, x: string) => `${member}\u0000${x}`;
  for (const line of lines) {
    if (line.type === "drift-start") {
      open.set(memberKey(line.member, line.read), line);
    } else if (line.type === "drift-record") {
      const { type: _type, ...record } = line;
      records.push(record);
      answered.add(memberKey(record.member, record.address));
      if (latest === undefined || record.observedAt > latest) latest = record.observedAt;
    } else {
      const start = open.get(memberKey(line.member, line.read));
      open.delete(memberKey(line.member, line.read));
      const expected = new Map((start ? driftExpected(start) : []).map((e) => [e.address, e]));
      for (const address of line.notReached ?? []) if (!expected.has(address)) expected.set(address, { address });
      const at = line.at ?? start?.at ?? latest ?? new Date(0).toISOString();
      const head: StreamHead = start ?? { member: line.member, engine: line.engine, read: line.read };
      for (const e of expected.values()) {
        if (answered.has(memberKey(line.member, e.address))) continue;
        records.push(notReachedRecord(head, e, at));
        answered.add(memberKey(line.member, e.address));
      }
    }
  }
  const reading: DriftReading[] = [];
  for (const start of open.values()) {
    for (const e of driftExpected(start)) {
      if (!answered.has(memberKey(start.member, e.address))) {
        reading.push({ member: start.member, read: start.read, address: e.address, node: e.node ?? null });
      }
    }
  }
  reading.sort((a, b) => byString(recordKey(a), recordKey(b)));
  return { document: driftDocument(records, options), reading };
}

// ── chant adapters ─────────────────────────────────────────────────────────────

/** What every adapter takes beside its source document. */
export interface DriftAdapterBase {
  member: string;
  /** RFC 3339, given to every record. */
  observedAt: string;
  /**
   * The member's graph, to place each record with `graphNodeFor` as it is
   * made. Omit to leave `node` null, for {@link mapDriftToGraph} to fill.
   */
  graph?: ChangeSetGraphNodes | null;
  /** The read that was asked for and failed, when this one answered instead. */
  fellBackFrom?: string;
  /** The chant or engine version, for `evidence.version`. */
  version?: string;
}

/**
 * Where an adapter's record for `address` sits: `graphNodeFor` on the
 * input's graph, plunge's by the `pulumi` rule ({@link driftPlanner}). Exported
 * for the lexicons' adapters.
 */
export function placeDriftRecord(
  input: Pick<DriftAdapterBase, "member" | "graph">,
  engine: DriftEngine,
  address: string,
): { node: string | null; instanceOf?: string } {
  if (!input.graph) return { node: null };
  const placed = graphNodeFor({ member: input.member, planner: driftPlanner(engine), address }, input.graph);
  return { node: placed.node, ...(placed.instanceOf !== undefined ? { instanceOf: placed.instanceOf } : {}) };
}

function base(input: DriftAdapterBase, engine: DriftEngine, read: DriftRead, address: string) {
  return {
    member: input.member,
    engine,
    address,
    ...placeDriftRecord(input, engine, address),
    observedAt: input.observedAt,
    read,
    ...(input.fellBackFrom !== undefined ? { fellBackFrom: input.fellBackFrom } : {}),
  };
}

function chantEvidence(input: DriftAdapterBase, command: string): DriftEvidence {
  return { tool: "chant", ...(input.version ? { version: input.version } : {}), command };
}

export interface LiveDiffDriftInput extends DriftAdapterBase {
  /** `chant lifecycle diff --live --json`, parsed. */
  diff: LiveDiffResult;
  /** Entity types by name, for the records whose diff row carries none. */
  types?: Record<string, string>;
}

/**
 * A chant member's records, from `lifecycle diff --live`: `unchanged` and
 * `newlyObserved` are in-sync, `driftedSinceSnapshot` drifted (before is the
 * snapshot, after the read), `missing` pending, `disappeared` missing,
 * `orphan` undeclared, `runtimeChildren` runtime, `unobserved` not-observed.
 * An entity in both `missing` and `disappeared` was deployed and is gone,
 * so it is missing.
 */
export function liveDiffDriftRecords(input: LiveDiffDriftInput): DriftRecord[] {
  const { diff } = input;
  const evidence = chantEvidence(input, "chant lifecycle diff --live");
  const out = new Map<string, DriftRecord>();
  const put = (name: string, rest: Pick<DriftRecord, "status"> & Partial<DriftRecord>, type?: string) => {
    if (out.has(name)) return;
    const t = type ?? input.types?.[name];
    out.set(name, driftRecord({ ...base(input, "chant", "live-read", name), ...(t ? { resourceType: t } : {}), evidence, ...rest }));
  };
  for (const u of diff.unobserved ?? []) {
    put(u.name, {
      status: "not-observed",
      unobserved: { reason: u.reason, ...(u.detail ? { detail: u.detail } : {}), ...(u.queried ? { queried: u.queried } : {}) },
    }, u.type);
  }
  for (const d of diff.driftedSinceSnapshot ?? []) {
    put(d.name, {
      status: "drifted",
      attributes: d.changes.map((c) => ({ path: c.path, ...(c.oldValue !== undefined ? { before: c.oldValue } : {}), ...(c.newValue !== undefined ? { after: c.newValue } : {}) })),
    }, d.type);
  }
  for (const name of diff.disappeared ?? []) put(name, { status: "missing" });
  for (const name of diff.missing ?? []) put(name, { status: "pending" });
  for (const name of diff.orphan ?? []) put(name, { status: "undeclared" });
  for (const r of diff.runtimeChildren ?? []) put(r.name, { status: "runtime", ownership: { verdict: "foreign", ownedBy: r.owner } }, r.type);
  for (const name of [...(diff.unchanged ?? []), ...(diff.newlyObserved ?? [])]) put(name, { status: "in-sync" });
  return [...out.values()].sort((a, b) => byString(a.address, b.address));
}

export interface DeepDiffDriftInput extends DriftAdapterBase {
  /** `chant lifecycle diff --live --deep --json`'s deep result, parsed. */
  diff: DeepDiffResult;
}

/**
 * A chant member's records from the deep diff alone: `drifted` with paths
 * (before is the declared value, after the live one; an `absent` path has
 * no after), `unchanged` in-sync, `unobserved` not-observed and
 * `undeclaredEntities` undeclared. Accepted and held paths are not drift and
 * are left out. To lay these over the thin read's records, so a deep hole
 * stays on the attribute surface, use {@link mergeDeepDrift}.
 */
export function deepDiffDriftRecords(input: DeepDiffDriftInput): DriftRecord[] {
  const { diff } = input;
  const evidence = chantEvidence(input, "chant lifecycle diff --live --deep");
  const out = new Map<string, DriftRecord>();
  const put = (name: string, rest: Pick<DriftRecord, "status"> & Partial<DriftRecord>) => {
    if (!out.has(name)) out.set(name, driftRecord({ ...base(input, "chant", "live-read", name), evidence, ...rest }));
  };
  for (const u of diff.unobserved ?? []) {
    put(u.name, {
      ...(u.type ? { resourceType: u.type } : {}),
      status: "not-observed",
      unobserved: { reason: u.reason, ...(u.detail ? { detail: u.detail } : {}), ...(u.queried ? { queried: u.queried } : {}) },
    });
  }
  for (const d of diff.drifted ?? []) {
    put(d.name, {
      resourceType: d.type,
      status: "drifted",
      attributes: d.changes.map((c) => ({
        path: c.path,
        ...(c.declared !== undefined ? { before: c.declared } : {}),
        ...(c.kind === "changed" && c.live !== undefined ? { after: c.live } : {}),
      })),
    });
  }
  for (const name of diff.undeclaredEntities ?? []) put(name, { status: "undeclared" });
  for (const name of diff.unchanged ?? []) put(name, { status: "in-sync" });
  return [...out.values()].sort((a, b) => byString(a.address, b.address));
}

/**
 * The thin read's records with the deep read laid over them, by member and
 * address. A thin in-sync record the deep read found drifted becomes
 * drifted with the deep paths. A deep not-observed record never changes the
 * thin status: presence is known, so it becomes `attributesUnobserved` on an
 * in-sync or drifted record and is dropped elsewhere. Deep records with no
 * thin record are added as they are.
 */
export function mergeDeepDrift(thin: Iterable<DriftRecord>, deep: Iterable<DriftRecord>): DriftRecord[] {
  const key = (r: DriftRecord) => `${r.member}\u0000${r.address}`;
  const out = new Map<string, DriftRecord>();
  for (const r of thin) out.set(key(r), r);
  for (const d of deep) {
    const t = out.get(key(d));
    if (!t) {
      out.set(key(d), d);
      continue;
    }
    if (d.status === "not-observed") {
      if (t.status === "in-sync" || t.status === "drifted") out.set(key(d), driftRecord({ ...t, attributesUnobserved: d.unobserved! }));
    } else if (d.status === "drifted" && (t.status === "in-sync" || t.status === "drifted")) {
      out.set(key(d), driftRecord({ ...t, status: "drifted", attributes: [...(t.attributes ?? []), ...(d.attributes ?? [])] }));
    }
  }
  return [...out.values()].sort((a, b) => byString(key(a), key(b)));
}

export interface ComponentStatusDriftInput extends DriftAdapterBase {
  /** `chant components status [env] --json`'s rows. */
  rows: readonly ComponentStatusRow[];
}

/**
 * A member's records from component status, one per component, addressed
 * by component name: `reconciled` in-sync, `drifted` drifted, `stale`
 * missing (recorded and no longer observed live), `unknown` not-observed
 * with the row's reason, or `not-reached` when live status was never asked
 * for. `unrecorded` is drifted when the component is live, since something
 * runs that no release accounts for, pending when nothing is, and
 * not-observed when live status was not asked for.
 */
export function componentStatusDriftRecords(input: ComponentStatusDriftInput): DriftRecord[] {
  const evidence = chantEvidence(input, "chant components status --live");
  return input.rows
    .map((row) => {
      const at = base(input, "chant", "live-read", row.component);
      const common = { ...at, resourceType: "component", evidence };
      switch (row.reconciliation) {
        case "reconciled":
          return driftRecord({ ...common, status: "in-sync" });
        case "drifted":
          return driftRecord({ ...common, status: "drifted" });
        case "stale":
          return driftRecord({ ...common, status: "missing" });
        case "unrecorded":
          if (row.live === true) return driftRecord({ ...common, status: "drifted" });
          if (row.live === false) return driftRecord({ ...common, status: "pending" });
          return driftRecord({ ...common, status: "not-observed", unobserved: { reason: "not-reached", detail: row.detail } });
        case "unknown":
          return driftRecord({
            ...common,
            status: "not-observed",
            unobserved: row.unobserved
              ? { reason: row.unobserved.reason, ...(row.unobserved.detail ? { detail: row.unobserved.detail } : {}) }
              : { reason: "not-reached", detail: row.detail },
          });
      }
    })
    .sort((a, b) => byString(a.address, b.address));
}

// ── a lexicon's own drift read ─────────────────────────────────────────────────

/**
 * What `chant lifecycle drift` asks a lexicon for (`LexiconPlugin.readDrift`,
 * behold#995). `chant workspace drift` runs that command in a member's reader
 * project, so a lexicon that reads members of a package kind (the terraform
 * lexicon's `terraform` and `choudoufu` kinds) answers with its own engine,
 * and chant core never imports the lexicon.
 */
export interface ReadDriftOptions {
  /** The workspace member the records are for. Every line the lexicon returns names it. */
  member: string;
  /** The directory holding the project's `chant.config.*`. */
  projectRoot: string;
  /** The project's resolved config, for the lexicon's own namespace. */
  config: Record<string, unknown>;
  /** The read asked for. Unset, the lexicon's default read for what it finds. */
  read?: DriftRead;
  /** One address to read, on an engine that can read one resource on its own. */
  resource?: string;
  /** RFC 3339, the `observedAt` of every record the lexicon builds itself. */
  observedAt: string;
}

/** Why a lexicon will not answer a drift read, in a code a caller can branch on. */
export type ReadDriftRefusalCode = "read-unsupported" | "resource-unsupported" | "no-drift-read";

/**
 * A lexicon's answer: the stream lines of each read it ran, in order (a
 * `drift-start`, its records, a `drift-settle`, per root), or a refusal. A
 * read that ran and failed is not a refusal: its addresses are records
 * with status `not-observed`.
 */
export type ReadDriftResult = { lines: DriftLine[] } | { refused: { code: ReadDriftRefusalCode; message: string } };
