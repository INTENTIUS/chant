/**
 * One change-set document across planners (#3181).
 *
 * Several things plan changes, each with its own output: `chant lifecycle
 * plan` for the cloud lexicons, terraform, tofu and choudoufu plans, and a
 * warden's reconcile plan. This module is the one typed document they all
 * become, so a reader can ask one question of every plan in a run: what will
 * change, where, and how risky it is. Its schema is
 * `./workspace/change-set.schema.json`, part of the workspace read contract.
 *
 * Each planner reaches it through an adapter that returns a
 * {@link ChangeSetPart}: one member and its entries. The lifecycle and
 * reconcile adapters are here; the terraform-family ones live in the
 * terraform lexicon's `change-set` subpath, the SQL ones in the sql
 * lexicon's and the Pulumi one in the pulumi lexicon's. A part another process wrote to a file reads back through
 * {@link readChangeSetPartFile}. {@link composeChangeSet} joins
 * the parts.
 *
 * ## The digest
 *
 * Every member carries the plan digest a gate on that member alone binds
 * (#2300): `terraformPlanDigest` for a terraform-family root, and here
 * `computePlanDigest("lifecycle-plan", …)` and `computePlanDigest(
 * "reconcile-plan", …)`. {@link changeSetDigest} over the sorted `{ member,
 * planDigest }` pairs is the set digest #3049 describes, and a wave's digest
 * is that function over the wave's members.
 *
 * The document's digest is {@link changeSetDocumentDigest}: the set digest,
 * each member's status and holes, the entries and the side effects. An
 * approval of the document binds what it says as well as the plans it came
 * from, so a pull request's apply that resumes from a record (#3464) can
 * check a re-planned member against the record's entries without trusting
 * whoever wrote the record. The summary is computed from the entries and is
 * not hashed. A change to how chant projects a plan into entries moves the
 * document's digest, so an approval given under one chant does not carry to
 * an apply under a chant that projects the same plan differently.
 *
 * ## The import graph
 *
 * terragucci runs this in customer CI as one bundled file with no TypeScript
 * toolchain (#3421). Everything here imports `./lifecycle/plan-digest` and
 * types only, and `change-set-bundle.test.ts` holds that.
 */

import { computePlanDigest } from "./lifecycle/plan-digest";
import type { ChangeSet as LifecycleChangeSet, ChangeSetEntry as LifecycleEntry } from "./lifecycle/change-set";
import type { ChangeSet as ReconcileChangeSet } from "./reconcile";

/** The schema a change-set document names in `$schema`. */
export const CHANGE_SET_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/change-set/v1/change-set.schema.json";

/** The read-contract version the document follows. */
export const CHANGE_SET_CONTRACT = 1;

/** The first chant whose change set can carry a member's `group` (ws-107, #4440). */
export const CHANGE_SET_GROUP_FLOOR = "0.124.53";

/** What a planner proposes for one resource. `no-op`, `read` and `forget` appear only when the planner reports them. */
export type ChangeSetAction = "create" | "update" | "replace" | "delete" | "read" | "no-op" | "forget";

/** Every action, in the order the summary lists them. */
export const CHANGE_SET_ACTIONS: readonly ChangeSetAction[] = ["create", "update", "replace", "delete", "read", "no-op", "forget"];

/** How much applying one change hurts, in the vocabulary of `./lifecycle/disruption.ts`. */
export type ChangeSetDisruption = "in-place" | "rolling" | "replace" | "destroy" | "unknown";

/**
 * Which tool produced a member's plan. `sql` is a SQL schema change: a
 * versioned plan (a product's migrations) or one of the sql lexicon's
 * migration Ops' plans, through `@intentius/chant-lexicon-sql/change-set`.
 * `pulumi` is a `pulumi preview --json` of a Pulumi member, through
 * `@intentius/chant-lexicon-pulumi/change-set` (#4453); its addresses are URNs.
 */
export type ChangeSetPlanner = "terraform" | "tofu" | "choudoufu" | "chant" | "warden" | "sql" | "pulumi";

/** Every planner, in the order the schema lists them. */
export const CHANGE_SET_PLANNERS: readonly ChangeSetPlanner[] = ["terraform", "tofu", "choudoufu", "chant", "warden", "sql", "pulumi"];

/** One attribute a change writes, at top-level granularity. */
export interface ChangeSetAttribute {
  path: string;
  /** The value before. Absent on a create, and when `sensitive`. */
  before?: unknown;
  /** The value after. Absent on a delete, when `unknown`, and when `sensitive`. */
  after?: unknown;
  /** The value is known only after apply. */
  unknown?: true;
  /** The planner marked the value sensitive, so neither side is carried. */
  sensitive?: true;
  /** Changing this attribute is what forces the replacement. */
  forcesReplacement?: true;
}

export interface ChangeSetEntry {
  member: string;
  lexicon: string;
  planner: ChangeSetPlanner;
  /** The planner's own address for the resource, unique within the member with `deposed`. */
  address: string;
  type: string;
  /** The resource's name, without module path or index, when the planner's address has one. */
  name?: string;
  /** A `count` or `for_each` index. */
  index?: string | number;
  /** The module path the resource sits in. */
  module?: string;
  /** A deposed object's key: a second entry at the same address. */
  deposed?: string;
  /** The provider's own id, when the planner reports one. */
  id?: string;
  action: ChangeSetAction;
  /** The entry also imports the object into state (an `import` block). Its action is whatever else the plan does to it, `no-op` included. */
  importing?: true;
  /** Set on update, replace and delete. `unknown` means nobody could say. */
  disruption?: ChangeSetDisruption;
  /**
   * The planner could not enumerate what this entry stands for (#4453). A
   * Pulumi program can register resources inside an `apply()`, which does not
   * run at preview while its input is unknown, so the preview never lists
   * them. The pulumi adapter keeps them in the set rather than dropping them:
   * one entry per component whose children may appear, at
   * `pulumiMayAppearAddress` of the component, and an entry for each resource
   * the last export holds under such a component that the preview did not
   * list or plans to delete. An entry carrying it is never empty
   * ({@link isEmptyChangeSet}). Part of the digest.
   */
  mayAppear?: true;
  region?: string;
  /** The estate, environment or org the change lands in. */
  scope?: string;
  attributes: ChangeSetAttribute[];
  /**
   * The graph node the entry changes, as `chant graph --format ir` and
   * `chant workspace graph` name it (#4022): `<member>/<id>` inside a
   * workspace. Null when the graph holds no node for the address, such as
   * a delete of a block the source no longer declares. Absent until the
   * document is mapped onto a graph (`./change-set-graph.ts`), and never
   * part of the digest.
   *
   * An instance of a `count` or `for_each` block (#4454) gets the instance
   * node's id, the block node's id followed by the key as the planner prints
   * it (`<member>/aws_eip.pool[0]`), and {@link instanceOf} names the block
   * node. See `./instance-nodes.ts`.
   */
  node?: string | null;
  /**
   * On an entry whose `node` is an instance node (#4454): the id of the block
   * node it is an instance of, the rollup, in the same id space as `node`.
   * Absent on every other entry. Like `node`, never part of the digest.
   */
  instanceOf?: string;
  /**
   * The source file that declares the entry's node, from the repository
   * root (#4025): the node's `sourceLoc.file` in the member's graph IR, with
   * the member's directory in front. Set beside `node` when a stored change
   * set is mapped onto a graph whose node has a source location, absent
   * otherwise. Like `node`, never part of the digest. The overlap report
   * attributes the entry to a work item through the commits that changed
   * this file.
   */
  source?: string;
}

/** Something a planner could not read, so the plan says nothing about it. */
export interface ChangeSetHole {
  address: string;
  type?: string;
  reason: string;
}

export interface ChangeSetMember {
  member: string;
  lexicon: string;
  planner: ChangeSetPlanner;
  scope?: string;
  status: "planned" | "failed";
  error?: string;
  /** What a gate on this member alone binds. `null` when the member failed to plan. */
  planDigest: string | null;
  /**
   * Planned before what it reads applied, so it may hold stand-in values (a
   * Terragrunt dependent planned on `mock_outputs` at PR time, #3416). A
   * preview only: {@link changeSetDigest} leaves it out, so no approval of the
   * document covers it, a wave's set digest refuses it, and the grouped
   * summary never folds it into a group of real plans.
   */
  provisional?: true;
  /** The planner's own digest of the same plan, when it prints one (choudoufu's per-root digest). */
  nativeDigest?: string;
  holes: ChangeSetHole[];
  /**
   * Set on a member a capability planned with others as one group (ws-107,
   * #4440). Part of the document's digest when present. Added within
   * contract 1 by chant {@link CHANGE_SET_GROUP_FLOOR}.
   */
  group?: ChangeSetMemberGroup;
}

/** A grouped member's group (ws-107): the group digest folded into its `planDigest`, and what it reads inside the group. */
export interface ChangeSetMemberGroup {
  digest: string;
  /**
   * The `<component>.<output>` values it reads from another member of its
   * group that the plan does not know, sorted. The group's apply computes
   * them. A change set with any is never empty ({@link isEmptyChangeSet}).
   */
  reads: string[];
}

/** A provider-defined side effect an apply runs: a Terraform `action` block's invocation. */
export interface ChangeSetSideEffect {
  member: string;
  /** The invocation's address, or its action type when the planner gives none. */
  address: string;
  /** The action's type, such as `aws_lambda_invoke`. */
  type: string;
  /** The address of the resource whose lifecycle triggers it, when one does. */
  trigger?: string;
  /** The lifecycle event, such as `after_update`. */
  event?: string;
}

/** What an adapter returns: one member, the entries it plans and the side effects it will run. */
export interface ChangeSetPart {
  member: ChangeSetMember;
  entries: ChangeSetEntry[];
  sideEffects?: Array<Omit<ChangeSetSideEffect, "member">>;
}

export type ActionCounts = Partial<Record<ChangeSetAction, number>>;

export interface ChangeSetNamed {
  member: string;
  address: string;
  type: string;
  deposed?: string;
  disruption?: ChangeSetDisruption;
}

export interface ChangeSetSummary {
  members: number;
  entries: number;
  /** Every action, zero included. */
  actions: Record<ChangeSetAction, number>;
  /** Per type, the actions it has. */
  types: Record<string, ActionCounts>;
  /** Per member, the actions it has. */
  byMember: Record<string, ActionCounts>;
  deletes: ChangeSetNamed[];
  replacements: ChangeSetNamed[];
  /** Members that failed to plan. */
  failed: string[];
  holes: number;
}

export interface ChangeSetDocument {
  $schema: typeof CHANGE_SET_SCHEMA_ID;
  contract: typeof CHANGE_SET_CONTRACT;
  /** The chant that composed it, when the caller knows. */
  chant?: string;
  digest: string;
  members: ChangeSetMember[];
  entries: ChangeSetEntry[];
  /** Triggered actions, sorted by member and address. Absent when no member runs one. */
  sideEffects?: ChangeSetSideEffect[];
  summary: ChangeSetSummary;
  /**
   * The graph the entries' `node` ids come from (#4022): the workspace member
   * whose graph it is, or null outside a workspace, and the commit it was
   * read at, or null when that is unknown. Null when no graph could be read,
   * so every `node` is null. Absent on a document never mapped. Not hashed.
   */
  graph?: ChangeSetGraph | null;
  /**
   * The release this change set was planned for (#4045): the `releaseDigest`
   * of the release a `components promote --release` deploys. Set with
   * `environment` on a release gate's document, absent on every other. Part
   * of the digest when present, so a stored document names the one release
   * and environment its gate bound, and two releases whose plans read the
   * same never share a document or an approval.
   */
  releaseDigest?: string;
  /** The environment this change set was planned for (#4045), set with `releaseDigest`. Part of the digest when present. */
  environment?: string;
}

/** Where a document's node ids come from. */
export interface ChangeSetGraph {
  member: string | null;
  at: string | null;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function entryKey(e: ChangeSetEntry): string {
  return `${e.member}\u0000${e.address}\u0000${e.deposed ?? ""}\u0000${e.action}`;
}

const bySideEffect = (a: ChangeSetSideEffect, b: ChangeSetSideEffect): number =>
  byString(a.member, b.member) || byString(a.address, b.address) || byString(a.trigger ?? "", b.trigger ?? "");

/**
 * The set digest over members' plan digests: `computePlanDigest("change-set",
 * …)` over `{ member, planDigest }` sorted by member. Order-independent,
 * and different whenever one member's plan digest is. Refuses a set that
 * names a member twice, which has no single plan for that member.
 *
 * Provisional members are left out: their plans may stand on values that do
 * not exist yet, so an approval of this digest never covers them.
 */
export function changeSetDigest(members: ReadonlyArray<Pick<ChangeSetMember, "member" | "planDigest" | "provisional">>): string {
  const pairs = members
    .filter((m) => m.provisional !== true)
    .map((m) => ({ member: m.member, planDigest: m.planDigest }))
    .sort((a, b) => byString(a.member, b.member));
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i - 1].member === pairs[i].member) throw new Error(`the change set names member ${pairs[i].member} twice`);
  }
  return computePlanDigest("change-set", pairs);
}

/**
 * The document's digest: `computePlanDigest("change-set-document", …)` over
 * the set digest ({@link changeSetDigest}), each member's name, status and
 * holes, the entries (without their graph `node`) and the side effects.
 * Members are sorted by name and
 * entries and side effects by the keys {@link composeChangeSet} sorts them by,
 * so order makes no difference.
 *
 * A provisional member is left out, with its entries and side effects, as
 * the set digest leaves it out: no approval of the document covers it.
 *
 * A release gate's document (#4045) also hashes the `releaseDigest` and
 * `environment` it was planned for. A document without them hashes as it
 * always has, so no earlier digest moves. A grouped member's `group`
 * (ws-107) is hashed with it the same way: only when present.
 */
export function changeSetDocumentDigest(
  doc: Pick<ChangeSetDocument, "members" | "entries" | "sideEffects" | "releaseDigest" | "environment">,
): string {
  const provisional = new Set(doc.members.filter((m) => m.provisional === true).map((m) => m.member));
  const members = doc.members
    .filter((m) => !provisional.has(m.member))
    .map((m) => ({ member: m.member, status: m.status, holes: m.holes, ...(m.group ? { group: { digest: m.group.digest, reads: [...m.group.reads].sort() } } : {}) }))
    .sort((a, b) => byString(a.member, b.member));
  // An entry's graph node (#4022), its block node (#4454) and its source
  // file (#4025) say where on the graph the change is, not what the plan
  // does, so they stay outside the digest: mapping a stored
  // document onto a graph never moves the value its gate bound.
  const entries = doc.entries
    .filter((e) => !provisional.has(e.member))
    .map(({ node: _node, instanceOf: _instanceOf, source: _source, ...e }) => e)
    .sort((a, b) => byString(entryKey(a), entryKey(b)));
  const sideEffects = (doc.sideEffects ?? []).filter((s) => !provisional.has(s.member)).sort(bySideEffect);
  const planned =
    doc.releaseDigest !== undefined || doc.environment !== undefined
      ? { planned: { releaseDigest: doc.releaseDigest ?? null, environment: doc.environment ?? null } }
      : {};
  return computePlanDigest("change-set-document", { set: changeSetDigest(doc.members), members, entries, sideEffects, ...planned });
}

/** The summary of a set of members and entries. */
export function summarizeChangeSet(members: ChangeSetMember[], entries: ChangeSetEntry[]): ChangeSetSummary {
  const actions = Object.fromEntries(CHANGE_SET_ACTIONS.map((a) => [a, 0])) as Record<ChangeSetAction, number>;
  const types: Record<string, ActionCounts> = {};
  const byMember: Record<string, ActionCounts> = {};
  const deletes: ChangeSetNamed[] = [];
  const replacements: ChangeSetNamed[] = [];
  const bump = (into: Record<string, ActionCounts>, key: string, action: ChangeSetAction) => {
    const counts = (into[key] ??= {});
    counts[action] = (counts[action] ?? 0) + 1;
  };
  for (const e of entries) {
    actions[e.action]++;
    bump(types, e.type, e.action);
    bump(byMember, e.member, e.action);
    const named: ChangeSetNamed = {
      member: e.member, address: e.address, type: e.type,
      ...(e.deposed !== undefined ? { deposed: e.deposed } : {}),
      ...(e.disruption !== undefined ? { disruption: e.disruption } : {}),
    };
    if (e.action === "delete") deletes.push(named);
    if (e.action === "replace") replacements.push(named);
  }
  return {
    members: members.length,
    entries: entries.length,
    actions,
    types: sortKeys(types),
    byMember: sortKeys(byMember),
    deletes,
    replacements,
    failed: members.filter((m) => m.status === "failed").map((m) => m.member),
    holes: members.reduce((n, m) => n + m.holes.length, 0),
  };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => byString(a, b)));
}

export interface ComposeChangeSetOptions {
  /** The chant version to record in `chant`. */
  chant?: string;
  /** The release and environment a release gate's change set was planned for (#4045), recorded and hashed. */
  planned?: { releaseDigest: string; environment: string };
}

/**
 * Join adapters' parts into one document: members sorted by name, entries
 * by member, address, deposed key and action, the summary, and the digest.
 * Throws when two parts name the same member, or an entry names a member
 * other than its part's.
 */
export function composeChangeSet(parts: ReadonlyArray<ChangeSetPart>, options: ComposeChangeSetOptions = {}): ChangeSetDocument {
  const members = parts.map((p) => p.member).sort((a, b) => byString(a.member, b.member));
  const entries: ChangeSetEntry[] = [];
  for (const part of parts) {
    for (const e of part.entries) {
      if (e.member !== part.member.member) throw new Error(`an entry at ${e.address} names member ${e.member}, inside member ${part.member.member}`);
      entries.push(e);
    }
  }
  entries.sort((a, b) => byString(entryKey(a), entryKey(b)));
  const sideEffects: ChangeSetSideEffect[] = parts
    .flatMap((p) => (p.sideEffects ?? []).map((s) => ({ member: p.member.member, ...s })))
    .sort(bySideEffect);
  const planned = options.planned ? { releaseDigest: options.planned.releaseDigest, environment: options.planned.environment } : {};
  const digest = changeSetDocumentDigest({ members, entries, sideEffects, ...planned });
  return {
    $schema: CHANGE_SET_SCHEMA_ID,
    contract: CHANGE_SET_CONTRACT,
    ...(options.chant !== undefined ? { chant: options.chant } : {}),
    digest,
    ...planned,
    members,
    entries,
    ...(sideEffects.length > 0 ? { sideEffects } : {}),
    summary: summarizeChangeSet(members, entries),
  };
}

/**
 * Whether a document's digest is the one its members, entries and side
 * effects give ({@link changeSetDocumentDigest}). A document that names a
 * member twice has no digest and is not verified.
 */
export function verifyChangeSetDigest(
  doc: Pick<ChangeSetDocument, "digest" | "members" | "entries" | "sideEffects" | "releaseDigest" | "environment">,
): boolean {
  try {
    return changeSetDocumentDigest(doc) === doc.digest;
  } catch {
    return false;
  }
}

/**
 * Whether a change set changes nothing (ws-104 question 6, #4045): it has at
 * least one member, every member planned, none failed or provisional, no
 * member has a hole, and every entry is a `no-op` or a `read` that no
 * planner marked `mayAppear`. A release gate over such a document passes
 * without an approval. A member that reads a value its group computes in its
 * apply (`group.reads`, ws-107 ruling 4) makes it not empty: what the plan
 * shows may not be all the apply does.
 */
export function isEmptyChangeSet(doc: Pick<ChangeSetDocument, "members" | "entries">): boolean {
  if (doc.members.length === 0) return false;
  for (const m of doc.members) {
    if (m.status !== "planned" || m.provisional === true || m.holes.length > 0) return false;
    if (m.group && m.group.reads.length > 0) return false;
  }
  return doc.entries.every((e) => (e.action === "no-op" || e.action === "read") && e.mayAppear !== true);
}

// ── chant lifecycle plan ───────────────────────────────────────────────────────

export interface LifecyclePlanPartInput {
  member: string;
  /** `chant lifecycle plan <env> --json`, parsed. */
  plan: LifecycleChangeSet;
  /** The lexicon an entry names when it carries none. Default `"chant"`. */
  lexicon?: string;
}

function lifecycleAttributes(entry: LifecycleEntry): ChangeSetAttribute[] {
  const because = new Set(entry.disruptionBecause ?? []);
  return (entry.deltas ?? []).map((d) => ({
    path: d.path,
    ...(d.oldValue !== undefined ? { before: d.oldValue } : {}),
    ...(d.newValue !== undefined ? { after: d.newValue } : {}),
    ...(because.has(d.path) ? { forcesReplacement: true as const } : {}),
  }));
}

/**
 * A chant member's part, from `chant lifecycle plan <env> --json`.
 *
 * `create`, `update`, `delete` and `noop` map across. An `update` whose
 * lexicon says it replaces or destroys becomes a `replace`. An `effect`
 * entry is the receipt its effect step writes: a `create` when the receipt
 * is absent, else an `update`. `unobserved` entries are holes. `adopt` and
 * `runtime` propose nothing and are left out.
 *
 * The member's plan digest is `computePlanDigest("lifecycle-plan", plan)`
 * over the whole document, which carries no timestamp or run id.
 */
export function lifecyclePlanPart(input: LifecyclePlanPartInput): ChangeSetPart {
  const { plan } = input;
  const fallback = input.lexicon ?? "chant";
  const entries: ChangeSetEntry[] = [];
  const holes: ChangeSetHole[] = [];
  for (const e of plan.entries ?? []) {
    const lexicon = e.lexicon ?? fallback;
    if (e.action === "unobserved") {
      holes.push({ address: e.name, ...(e.type ? { type: e.type } : {}), reason: e.unobservedReason ?? "unobserved" });
      continue;
    }
    let action: ChangeSetAction;
    let disruption: ChangeSetDisruption | undefined;
    switch (e.action) {
      case "create": action = "create"; break;
      case "noop": action = "no-op"; break;
      case "delete": action = "delete"; disruption = "destroy"; break;
      case "effect": action = e.effectReason === "receipt-absent" ? "create" : "update"; break;
      case "update":
        disruption = e.disruption ?? "unknown";
        action = disruption === "replace" || disruption === "destroy" ? "replace" : "update";
        break;
      default: continue; // adopt, runtime: not a proposal
    }
    entries.push({
      member: input.member,
      lexicon,
      planner: "chant",
      address: e.name,
      type: e.type ?? "unknown",
      ...(e.physicalId ? { id: e.physicalId } : {}),
      action,
      ...(disruption ? { disruption } : {}),
      scope: plan.env,
      attributes: lifecycleAttributes(e),
    });
  }
  const lexicons = [...new Set(entries.map((e) => e.lexicon))].sort();
  return {
    member: {
      member: input.member,
      lexicon: lexicons.length === 1 ? lexicons[0] : fallback,
      planner: "chant",
      scope: plan.env,
      status: "planned",
      planDigest: computePlanDigest("lifecycle-plan", plan),
      holes,
    },
    entries,
  };
}

// ── a warden's reconcile plan ──────────────────────────────────────────────────

export interface ReconcilePlanPartInput {
  member: string;
  /** The change sets a reconcile run planned, one per cycle and org. */
  plan: ReconcileChangeSet | ReconcileChangeSet[];
  /** The lexicon the reconciled provider belongs to. Default `"github"`. */
  lexicon?: string;
}

function topLevelKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

/**
 * A warden member's part, from the reconcile `ChangeSet`s it planned
 * (`./reconcile.ts`). The address is `<resourceType>.<key>`, unique within
 * one org, and the scope is the org. An update's disruption is `unknown`:
 * the reconcile model says nothing about it.
 *
 * The plan digest covers each change set's org and entries, and leaves out
 * the managed counts, which are guardrail denominators rather than changes.
 */
export function reconcilePlanPart(input: ReconcilePlanPartInput): ChangeSetPart {
  const sets = (Array.isArray(input.plan) ? input.plan : [input.plan])
    .map((cs) => ({ org: cs.org, entries: [...cs.entries].sort((a, b) => byString(`${a.resourceType}\u0000${a.key}`, `${b.resourceType}\u0000${b.key}`)) }))
    .sort((a, b) => byString(a.org, b.org));
  const lexicon = input.lexicon ?? "github";
  const entries: ChangeSetEntry[] = [];
  for (const cs of sets) {
    for (const e of cs.entries) {
      const attributes: ChangeSetAttribute[] =
        e.kind === "update"
          ? (e.fields ?? []).map((f) => ({ path: f.field, ...(f.before !== undefined ? { before: f.before } : {}), ...(f.after !== undefined ? { after: f.after } : {}) }))
          : e.kind === "create"
            ? topLevelKeys(e.after).map((k) => ({ path: k, after: (e.after as Record<string, unknown>)[k] }))
            : [];
      entries.push({
        member: input.member,
        lexicon,
        planner: "warden",
        address: `${e.resourceType}.${e.key}`,
        type: e.resourceType,
        name: e.key,
        action: e.kind,
        ...(e.kind === "delete" ? { disruption: "destroy" as const } : e.kind === "update" ? { disruption: "unknown" as const } : {}),
        scope: cs.org,
        attributes,
      });
    }
  }
  const orgs = [...new Set(sets.map((s) => s.org))];
  return {
    member: {
      member: input.member,
      lexicon,
      planner: "warden",
      ...(orgs.length === 1 ? { scope: orgs[0] } : {}),
      status: "planned",
      planDigest: computePlanDigest("reconcile-plan", sets),
      holes: [],
    },
    entries,
  };
}

// ── a part written to a file ───────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A part an adapter in another process wrote as JSON, read back as `member`'s
 * part. The `sql` planner's plans arrive this way: the sql lexicon's
 * `change-set` adapters, or a product that fills them, write the part, and
 * `readChangeSetPart` with `planner: "sql"` reads it.
 *
 * The part must name `planner` on its member and on every entry, and say
 * `status`, `planDigest` and `holes`. Its member and entries are renamed to
 * `member`, so the file need not know the name the run gives it; a `lexicon`
 * given here replaces the part's. Nothing is recomputed: the plan digest is
 * the one the writer took, over a plan this process never sees.
 */
export function readChangeSetPartFile(part: unknown, planner: ChangeSetPlanner, member: string, lexicon?: string): ChangeSetPart {
  const where = `the ${planner} part for ${member}`;
  if (!isRecord(part) || !isRecord(part.member) || !Array.isArray(part.entries)) throw new Error(`${where} is not a change-set part: it needs member and entries`);
  const m = part.member;
  if (m.planner !== planner) throw new Error(`${where} names planner ${String(m.planner)}, not ${planner}`);
  if (m.status !== "planned" && m.status !== "failed") throw new Error(`${where} has no status`);
  if (m.planDigest !== null && typeof m.planDigest !== "string") throw new Error(`${where} has no planDigest`);
  if (m.status === "planned" && m.planDigest === null) throw new Error(`${where} planned but has no planDigest`);
  if (!Array.isArray(m.holes)) throw new Error(`${where} has no holes array`);
  const entries = part.entries.map((e, i) => {
    if (!isRecord(e) || typeof e.address !== "string" || typeof e.type !== "string" || typeof e.action !== "string" || !Array.isArray(e.attributes)) {
      throw new Error(`${where}: entries[${i}] needs address, type, action and attributes`);
    }
    if (!(CHANGE_SET_ACTIONS as readonly string[]).includes(e.action)) throw new Error(`${where}: entries[${i}] has action ${e.action}`);
    if (e.planner !== planner) throw new Error(`${where}: entries[${i}] names planner ${String(e.planner)}, not ${planner}`);
    return { ...(e as unknown as ChangeSetEntry), member, ...(lexicon !== undefined ? { lexicon } : {}) };
  });
  return {
    member: { ...(m as unknown as ChangeSetMember), member, ...(lexicon !== undefined ? { lexicon } : {}) },
    entries,
    ...(Array.isArray(part.sideEffects) ? { sideEffects: part.sideEffects as ChangeSetPart["sideEffects"] } : {}),
  };
}
