/**
 * SQL plans as change-set parts (#3767, the document is #3181).
 *
 * The sql lexicon's declarative plans reach the change set through `chant
 * lifecycle plan`. Two kinds of SQL plan do not, and this module is their
 * adapter:
 *
 * - a versioned plan: the migrations a product (SQL Yodeler) would apply to
 *   an environment, each a list of steps in the shape `diffStatements`
 *   writes (`./core/statements.ts`). {@link sqlVersionedPlanPart}.
 * - the plan step of the lexicon's own migration Ops, `ClickHouseRebuildOp`
 *   and `PostgresMigrationOp`. {@link clickhouseRebuildPart} and
 *   {@link postgresMigrationPart}.
 *
 * Each returns a part with planner `sql`, so it composes with every other
 * member's in `composeChangeSet`, and a gate that binds the document gets its
 * Cedar `context.plan` (#3182). A part written to a file as JSON reads back
 * through core's `readChangeSetPart` with `planner: "sql"`.
 *
 * ## Entries
 *
 * One entry per object a plan touches, at the object's server name (`db.name`
 * or `schema.name`), however many steps or migrations touch it. The action
 * and disruption come from the change classes the steps carry, as the
 * dialects' `CHANGE_CLASSES` and `PG_CHANGE_CLASSES` price them:
 *
 * - a `drop` class is a `delete` (`destroy`); a `create` class a `create`;
 * - a `rebuild`, `replace` or `expand` class, or a step a migration Op makes, is a
 *   `replace` (`replace`): the object, or a column of it, is built again;
 * - anything else is an `update`, its disruption the worst class's
 *   (`metadata` in-place; `validate`, `concurrently` and `rewrite` rolling).
 *   A step marked destructive (a column drop) makes it `destroy`. A class
 *   neither dialect knows makes it `unknown`.
 *
 * A step may name its `action` itself, which wins over its classes.
 *
 * ## The import graph
 *
 * Like `@intentius/chant/change-set`, this module bundles small for a tool
 * that runs it in CI with no TypeScript toolchain: it imports chant's plan
 * hashing code and types only. `change-set.test.ts` holds that.
 */

import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import type {
  ChangeSetAction,
  ChangeSetAttribute,
  ChangeSetDisruption,
  ChangeSetEntry,
  ChangeSetHole,
  ChangeSetPart,
} from "@intentius/chant/change-set";
import type { MigrationStep, StatementChange } from "./core/statements";

/** The lexicon a SQL part's member and entries name. */
export const SQL_CHANGE_SET_LEXICON = "sql";

/**
 * What each change class costs, both dialects together. The same values as
 * `CHANGE_CLASSES.disruption` (ClickHouse) and `PG_CHANGE_CLASSES.disruption`
 * (Postgres), copied so the rule tables stay out of the bundle; the test
 * holds the two together.
 */
export const SQL_CLASS_DISRUPTION: Readonly<Record<string, ChangeSetDisruption>> = {
  create: "in-place",
  metadata: "in-place",
  validate: "rolling",
  concurrently: "rolling",
  rewrite: "rolling",
  replace: "replace",
  rebuild: "replace",
  expand: "replace",
  drop: "destroy",
};

/**
 * One step of a versioned plan: a `MigrationStep` as `diffStatements` or
 * `chant sql diff --statements --json` writes it, with what a product knows
 * besides. Only `name` and `type` (from `StepObject`) and `kind` are needed.
 */
export type SqlPlanStep = MigrationStep & {
  /** Already applied by an earlier, partial run: it proposes nothing. */
  done?: boolean;
  /** The action, when the product knows it better than the classes say. */
  action?: ChangeSetAction;
  /** A statement's classified changes, when the product has them; they become the entry's attributes. */
  changes?: StatementChange[];
};

/** A migration of a versioned plan. A step may come wrapped as `{ step, done }`, as SQL Yodeler's plan view holds it. */
export interface SqlPlanMigration {
  id: string;
  steps: ReadonlyArray<SqlPlanStep | { step: SqlPlanStep; done?: boolean }>;
}

/**
 * A versioned plan, in the shape a product fills: the migrations it would
 * apply to one environment, in order. SQL Yodeler's `VersionedPlan` (`yodel
 * plan <env> --json`) is one as it stands: `pending` for `migrations`, its
 * `refusal` and `digest`.
 */
export interface SqlVersionedPlan {
  dialect: string;
  /** The environment it plans into: the member's and every entry's `scope`. */
  environment?: string;
  /** The migrations to apply, in order. */
  migrations?: ReadonlyArray<SqlPlanMigration>;
  /** SQL Yodeler's name for `migrations`, read when `migrations` is absent. */
  pending?: ReadonlyArray<SqlPlanMigration>;
  /**
   * The digest the product's own gate binds. When given, it is the member's
   * `planDigest`, so a gate on the member alone and the product's approval
   * bind one value. Absent, the adapter takes `computePlanDigest(
   * "sql-versioned-plan", …)` over the dialect, environment and steps.
   */
  digest?: string;
  /** Why the product would refuse to apply: the member is `failed`. */
  refusal?: string | { message: string };
  /** What the product could not read; the plan says nothing about it. */
  holes?: ChangeSetHole[];
}

export interface SqlVersionedPlanPartInput {
  member: string;
  plan: SqlVersionedPlan;
  /** Default `"sql"`. */
  lexicon?: string;
}

const RANK: Record<ChangeSetDisruption, number> = { "in-place": 0, rolling: 1, unknown: 2, replace: 3, destroy: 4 };
const worst = (a: ChangeSetDisruption | undefined, b: ChangeSetDisruption): ChangeSetDisruption => (a === undefined || RANK[b] > RANK[a] ? b : a);
const ACTION_ORDER: ChangeSetAction[] = ["delete", "replace", "create", "update", "forget", "read", "no-op"];

/** What the adapter gathers for one object across every step that touches it. */
interface ObjectChanges {
  address: string;
  type: string;
  classes: string[];
  actions: ChangeSetAction[];
  destructive: boolean;
  /** A step a migration Op makes. */
  ops: string[];
  manual: string[];
  sql: string[];
  fields: Map<string, StatementChange>;
}

const unwrap = (s: SqlPlanStep | { step: SqlPlanStep; done?: boolean }): SqlPlanStep =>
  "step" in s && s.step && typeof s.step === "object" ? { ...s.step, ...(s.done ? { done: true } : {}) } : (s as SqlPlanStep);

function gather(steps: Iterable<SqlPlanStep>): ObjectChanges[] {
  const byAddress = new Map<string, ObjectChanges>();
  for (const step of steps) {
    if (step.done) continue;
    let o = byAddress.get(step.name);
    if (!o) {
      o = { address: step.name, type: step.type, classes: [], actions: [], destructive: false, ops: [], manual: [], sql: [], fields: new Map() };
      byAddress.set(step.name, o);
    }
    if (step.action) o.actions.push(step.action);
    const changes: readonly StatementChange[] = step.changes ?? [];
    if (step.kind === "statement") {
      o.classes.push(step.class);
      o.sql.push(step.sql);
      if (step.destructive) o.destructive = true;
    } else if (step.kind === "op") {
      o.ops.push(step.op);
    } else {
      o.manual.push(step.detail);
    }
    for (const c of changes) {
      o.classes.push(c.class);
      if (c.destructive) o.destructive = true;
      const had = o.fields.get(c.field);
      // The first step's before, the last step's after.
      o.fields.set(c.field, had ? { ...c, ...(had.before !== undefined ? { before: had.before } : {}) } : c);
    }
  }
  return [...byAddress.values()];
}

function attributesOf(o: ObjectChanges): ChangeSetAttribute[] {
  const attributes: ChangeSetAttribute[] = [...o.fields.values()]
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    .map((c) => ({
      path: c.field,
      ...(c.before !== undefined ? { before: c.before } : {}),
      ...(c.after !== undefined ? { after: c.after } : {}),
      ...(SQL_CLASS_DISRUPTION[c.class] === "replace" ? { forcesReplacement: true as const } : {}),
    }));
  if (o.sql.length > 0) attributes.push({ path: "sql", after: o.sql });
  if (o.ops.length > 0) attributes.push({ path: "op", after: [...new Set(o.ops)] });
  if (o.manual.length > 0) attributes.push({ path: "manual", after: o.manual });
  return attributes;
}

/** The action and disruption of one object's changes, as the module's header says. */
export function sqlChangeAction(o: Pick<ObjectChanges, "classes" | "actions" | "destructive" | "ops">): { action: ChangeSetAction; disruption?: ChangeSetDisruption } {
  let disruption: ChangeSetDisruption | undefined;
  for (const c of o.classes) disruption = worst(disruption, SQL_CLASS_DISRUPTION[c] ?? "unknown");
  if (o.ops.length > 0) disruption = worst(disruption, "replace");
  if (o.destructive) disruption = worst(disruption, "destroy");
  let action: ChangeSetAction;
  if (o.actions.length > 0) action = ACTION_ORDER.find((a) => o.actions.includes(a))!;
  else if (o.classes.includes("drop")) action = "delete";
  else if (o.classes.includes("create")) action = "create";
  else if (o.ops.length > 0 || o.classes.some((c) => SQL_CLASS_DISRUPTION[c] === "replace")) action = "replace";
  else action = "update";
  switch (action) {
    case "create":
    case "read":
    case "no-op":
    case "forget":
      return { action };
    case "delete":
      return { action, disruption: "destroy" };
    case "replace":
      return { action, disruption: worst(disruption, "replace") };
    default:
      return { action, disruption: disruption ?? "unknown" };
  }
}

function entriesOf(member: string, lexicon: string, scope: string | undefined, objects: ObjectChanges[]): ChangeSetEntry[] {
  return objects.map((o) => ({
    member,
    lexicon,
    planner: "sql" as const,
    address: o.address,
    type: o.type,
    ...sqlChangeAction(o),
    ...(scope !== undefined ? { scope } : {}),
    attributes: attributesOf(o),
  }));
}

/**
 * A versioned plan's part ({@link SqlVersionedPlan}): one entry per object
 * its pending steps touch, `scope` the environment. A refusal makes the
 * member `failed` with no plan digest; its entries stay, for a reader.
 */
export function sqlVersionedPlanPart(input: SqlVersionedPlanPartInput): ChangeSetPart {
  const { plan } = input;
  const lexicon = input.lexicon ?? SQL_CHANGE_SET_LEXICON;
  const migrations = (plan.migrations ?? plan.pending ?? []).map((m) => ({ id: m.id, steps: m.steps.map(unwrap) }));
  const objects = gather(migrations.flatMap((m) => m.steps));
  const refusal = plan.refusal === undefined ? undefined : typeof plan.refusal === "string" ? plan.refusal : plan.refusal.message;
  const planDigest =
    refusal !== undefined
      ? null
      : (plan.digest ??
        computePlanDigest("sql-versioned-plan", {
          dialect: plan.dialect,
          environment: plan.environment ?? null,
          migrations: migrations.map((m) => ({ id: m.id, steps: m.steps.filter((s) => !s.done) })),
        }));
  return {
    member: {
      member: input.member,
      lexicon,
      planner: "sql",
      ...(plan.environment !== undefined ? { scope: plan.environment } : {}),
      status: refusal !== undefined ? "failed" : "planned",
      ...(refusal !== undefined ? { error: refusal } : {}),
      planDigest,
      holes: plan.holes ?? [],
    },
    entries: entriesOf(input.member, lexicon, plan.environment, objects),
  };
}

// ── the migration Ops' plan steps ─────────────────────────────────────────────

/**
 * What a migration Op's plan step returns, as far as a part needs it:
 * `clickhouseRebuildPlan`'s `RebuildPlanResult` and `postgresMigrationPlan`'s
 * `MigrationPlanResult` (`./op/activities/`).
 */
export interface SqlOpPlan {
  state: string;
  /** ClickHouse: the table, `database.name`. */
  table?: string;
  /** Postgres: `schema.table.column`. */
  migration?: string;
  /** The plan's digest; present while there is something to do. */
  planDigest?: string;
  /** Each classified change, as `<rule> <field>: <before> -> <after>`. */
  changes: string[];
  /** The same changes, structured. Each becomes an attribute; without them, only the field is read from `changes`. */
  classified?: StatementChange[];
}

export interface SqlOpPlanPartInput {
  member: string;
  plan: SqlOpPlan;
  /** The environment the Op runs against: the member's and the entry's `scope`. */
  environment?: string;
  /** Default `"sql"`. */
  lexicon?: string;
}

/** A change as a plain string, read back as far as its rule and field go. */
function changeOf(line: string): StatementChange {
  const m = /^(\S+)\s+([^\s:]+)/.exec(line);
  return { rule: m?.[1] ?? line, class: "unknown", field: m?.[2] ?? line };
}

function opPart(input: SqlOpPlanPartInput, op: "ClickHouseRebuildOp" | "PostgresMigrationOp", active: string, address: string, type: string): ChangeSetPart {
  const { plan } = input;
  const lexicon = input.lexicon ?? SQL_CHANGE_SET_LEXICON;
  const running = plan.state === active;
  const changes = plan.classified ?? plan.changes.map(changeOf);
  const objects = running
    ? gather([{ kind: "op", object: address, type, name: address, op, importPath: "", options: {}, declaration: "", changes, detail: "" }])
    : [];
  // Swapped or done: the Op has nothing left to change in the schema; the digest says which.
  const planDigest = running && plan.planDigest ? plan.planDigest : computePlanDigest("sql-op-plan", { op, address, state: plan.state, planDigest: plan.planDigest ?? null });
  return {
    member: {
      member: input.member,
      lexicon,
      planner: "sql",
      ...(input.environment !== undefined ? { scope: input.environment } : {}),
      status: "planned",
      planDigest,
      holes: [],
    },
    entries: entriesOf(input.member, lexicon, input.environment, objects),
  };
}

/**
 * The part of a `ClickHouseRebuildOp`'s plan step: while the state is
 * `rebuild`, one `replace` of the table, its plan digest the step's (the
 * value before the verification, not the swap gate's). `swapped` and `done`
 * propose nothing.
 */
export function clickhouseRebuildPart(input: SqlOpPlanPartInput): ChangeSetPart {
  const table = input.plan.table;
  if (!table) throw new Error("clickhouseRebuildPart: the plan names no table");
  return opPart(input, "ClickHouseRebuildOp", "rebuild", table, "ClickHouse::Table");
}

/**
 * The part of a `PostgresMigrationOp`'s plan step: while the state is
 * `migrate`, one `replace` of the table (`schema.table`) whose column it
 * expands and contracts, its plan digest the step's. `switched` and `done`
 * propose nothing.
 */
export function postgresMigrationPart(input: SqlOpPlanPartInput): ChangeSetPart {
  const migration = input.plan.migration;
  if (!migration) throw new Error("postgresMigrationPart: the plan names no migration");
  const table = migration.split(".").slice(0, -1).join(".") || migration;
  return opPart(input, "PostgresMigrationOp", "migrate", table, "Postgres::Table");
}
