/**
 * The plan summary a gate's policy reads (#3182).
 *
 * A gate's Cedar request used to carry `planDigest` and whatever the Op put
 * in `approval.context` by hand, so a rule like "deny an agent a plan that
 * deletes a database" needed every Op to compute and pass the plan's deletes
 * itself. A gate whose `plan` names the step that planned the change now gets
 * `context.plan` from that step's change-set document (#3181), with no code in
 * the Op:
 *
 * - `terraformPlan` returns `changeSet`, one member's part;
 * - `lifecyclePlanChangeSet` and `readChangeSetPart` return `part`;
 * - `composeChangeSet` returns `document`, the whole run's change set.
 *
 * {@link gatePlanSummary} is the summary, shaped for Cedar: flat counts
 * (`no-op` is not a Cedar identifier), sets of names, and no nulls or floats.
 * The cedar lexicon's `GATE_CEDAR_SCHEMA` declares it as `Chant::PlanSummary`,
 * and its policy pack is written against it.
 *
 * The summary rides on the pending fact with the rest of the resolved context,
 * so `chant approve` evaluates the policy against the plan the run produced.
 * It comes from the same step result as the digest the gate binds, and a new
 * plan is a new digest, so an approval never stands on a summary of another
 * plan.
 *
 * Imports types only, so the module bundles without TypeScript (#3421).
 */

import type { ChangeSetEntry, ChangeSetMember, ChangeSetPart, ChangeSetDocument } from "../change-set";

/** The `approval.context` key the summary lands under. An authored context may not use it. */
export const GATE_PLAN_CONTEXT_KEY = "plan";

/** How many addresses each address set carries before it is cut and {@link GatePlanSummary.truncated} is set. */
export const GATE_PLAN_ADDRESS_LIMIT = 500;

/** The attributes that hold a resource's tags or labels, read in this order. */
const TAG_ATTRIBUTES = ["tags", "tags_all", "labels"] as const;

/**
 * `context.plan` on a gate's Cedar request. Counts are over entries; type,
 * address, region, scope and member sets are over the changes only (create,
 * update, replace and delete), so a resource the plan only reads or leaves
 * alone does not count as touched.
 */
export interface GatePlanSummary {
  /** Every member the change set names. */
  members: string[];
  /** Members with at least one change. */
  membersChanged: string[];
  /** Members that failed to plan. A plan with a failed member says nothing about it. */
  failedMembers: string[];
  /** How many members failed to plan. */
  failed: number;
  /** Resources a planner could not read. */
  holes: number;
  entries: number;
  /** creates + updates + replaces + deletes. */
  changes: number;
  creates: number;
  updates: number;
  replaces: number;
  deletes: number;
  reads: number;
  noOps: number;
  forgets: number;
  /** Types with a change. */
  types: string[];
  createdTypes: string[];
  updatedTypes: string[];
  replacedTypes: string[];
  deletedTypes: string[];
  /** Addresses deleted, as each planner writes them. */
  deleted: string[];
  /** Addresses replaced. */
  replaced: string[];
  /** Regions a change lands in, where the planner reports one. */
  regions: string[];
  /** Estates, environments or orgs a change lands in. */
  scopes: string[];
  lexicons: string[];
  /** Creates that carry tags or labels. */
  taggedCreates: number;
  /** Creates that carry no tags or labels attribute at all: a type with no tags, or tags left unset. */
  untaggedCreates: number;
  /**
   * The tag keys every tagged create carries: the intersection over
   * {@link taggedCreates}. A required-tags rule checks this contains its keys.
   */
  createTagKeys: string[];
  /** At least one change, and every change an update of tags or labels only. */
  tagOnly: boolean;
  /** An address set was cut at {@link GATE_PLAN_ADDRESS_LIMIT}. The counts are whole. */
  truncated: boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

function isMember(v: unknown): v is ChangeSetMember {
  return isObject(v) && typeof v.member === "string";
}

function isPart(v: unknown): v is ChangeSetPart {
  return isObject(v) && isMember(v.member) && Array.isArray(v.entries);
}

function isDocument(v: unknown): v is ChangeSetDocument {
  return isObject(v) && Array.isArray(v.members) && v.members.every(isMember) && Array.isArray(v.entries);
}

/** The members and entries a step result carries, when it carries a change set. */
export function changeSetOfResult(result: unknown): { members: ChangeSetMember[]; entries: ChangeSetEntry[] } | undefined {
  if (isDocument(result)) return result;
  if (isPart(result)) return { members: [result.member], entries: result.entries };
  if (!isObject(result)) return undefined;
  if (isDocument(result.document)) return result.document;
  for (const key of ["changeSet", "part"] as const) {
    const part = result[key];
    if (isPart(part)) return { members: [part.member], entries: part.entries };
  }
  return undefined;
}

const CHANGES = new Set(["create", "update", "replace", "delete"]);

function tagKeysOf(entry: ChangeSetEntry): string[] | undefined {
  let keys: Set<string> | undefined;
  for (const name of TAG_ATTRIBUTES) {
    const attr = entry.attributes.find((a) => a.path === name);
    if (!attr) continue;
    keys ??= new Set();
    if (isObject(attr.after)) for (const k of Object.keys(attr.after)) keys.add(k);
  }
  return keys ? [...keys] : undefined;
}

function isTagOnlyUpdate(entry: ChangeSetEntry): boolean {
  return (
    entry.action === "update" &&
    entry.attributes.length > 0 &&
    entry.attributes.every((a) => (TAG_ATTRIBUTES as readonly string[]).includes(a.path))
  );
}

const sorted = (s: Set<string>): string[] => [...s].sort();

/** The plan summary of a change set's members and entries. */
export function gatePlanSummary(changeSet: { members: ReadonlyArray<ChangeSetMember>; entries: ReadonlyArray<ChangeSetEntry> }): GatePlanSummary {
  const count = { create: 0, update: 0, replace: 0, delete: 0, read: 0, "no-op": 0, forget: 0 };
  const typesBy = { create: new Set<string>(), update: new Set<string>(), replace: new Set<string>(), delete: new Set<string>() };
  const types = new Set<string>();
  const membersChanged = new Set<string>();
  const regions = new Set<string>();
  const scopes = new Set<string>();
  const lexicons = new Set<string>();
  const deleted: string[] = [];
  const replaced: string[] = [];
  let taggedCreates = 0;
  let untaggedCreates = 0;
  let createTagKeys: Set<string> | undefined;
  let tagOnly = true;

  for (const e of changeSet.entries) {
    if (e.action in count) count[e.action]++;
    if (!CHANGES.has(e.action)) continue;
    const action = e.action as keyof typeof typesBy;
    typesBy[action].add(e.type);
    types.add(e.type);
    membersChanged.add(e.member);
    lexicons.add(e.lexicon);
    if (e.region) regions.add(e.region);
    if (e.scope) scopes.add(e.scope);
    if (action === "delete") deleted.push(e.address);
    if (action === "replace") replaced.push(e.address);
    if (!isTagOnlyUpdate(e)) tagOnly = false;
    if (action === "create") {
      const keys = tagKeysOf(e);
      if (keys === undefined) {
        untaggedCreates++;
      } else {
        taggedCreates++;
        createTagKeys = createTagKeys === undefined ? new Set(keys) : new Set(keys.filter((k) => createTagKeys!.has(k)));
      }
    }
  }

  const failedMembers = new Set(changeSet.members.filter((m) => m.status === "failed").map((m) => m.member));
  const changes = count.create + count.update + count.replace + count.delete;
  const cap = (list: string[]) => [...new Set(list)].sort().slice(0, GATE_PLAN_ADDRESS_LIMIT);
  const truncated = new Set(deleted).size > GATE_PLAN_ADDRESS_LIMIT || new Set(replaced).size > GATE_PLAN_ADDRESS_LIMIT;
  return {
    members: sorted(new Set(changeSet.members.map((m) => m.member))),
    membersChanged: sorted(membersChanged),
    failedMembers: sorted(failedMembers),
    failed: failedMembers.size,
    holes: changeSet.members.reduce((n, m) => n + (Array.isArray(m.holes) ? m.holes.length : 0), 0),
    entries: changeSet.entries.length,
    changes,
    creates: count.create,
    updates: count.update,
    replaces: count.replace,
    deletes: count.delete,
    reads: count.read,
    noOps: count["no-op"],
    forgets: count.forget,
    types: sorted(types),
    createdTypes: sorted(typesBy.create),
    updatedTypes: sorted(typesBy.update),
    replacedTypes: sorted(typesBy.replace),
    deletedTypes: sorted(typesBy.delete),
    deleted: cap(deleted),
    replaced: cap(replaced),
    regions: sorted(regions),
    scopes: sorted(scopes),
    lexicons: sorted(lexicons),
    taggedCreates,
    untaggedCreates,
    createTagKeys: createTagKeys ? sorted(createTagKeys) : [],
    tagOnly: changes > 0 && tagOnly,
    truncated,
  };
}

/** The summary of a step result, when the result carries a change set. */
export function gatePlanSummaryOfResult(result: unknown): GatePlanSummary | undefined {
  const changeSet = changeSetOfResult(result);
  return changeSet ? gatePlanSummary(changeSet) : undefined;
}
