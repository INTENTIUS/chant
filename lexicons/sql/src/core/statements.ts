/**
 * The statements a schema change takes, rendered offline (#3644), the same
 * shape in every dialect: what `diffStatements`
 * (`../migration-statements.ts`) returns and `chant sql diff --statements
 * --json` prints, for a migration file to hold.
 *
 * Every value is plain JSON: strings, booleans, arrays and objects, no
 * `undefined` left in, so the document reads back as it was written. Steps
 * are in the order they run.
 */

/** A classified change, as a step names the changes it makes. */
export interface StatementChange {
  /** The classifier rule, e.g. `SQLCH201`, `SQLPG240`. */
  rule: string;
  /** That rule's class, e.g. `metadata`, `rewrite`, `concurrently`. */
  class: string;
  /** What changed, e.g. `columns.region`, `orderBy`. */
  field: string;
  before?: string;
  after?: string;
  /** Data is removed and not recoverable. */
  destructive?: boolean;
  note?: string;
}

/** What every step says about the object it is for. */
export interface StepObject {
  /** The object's export name: in the newer build, or the older one for an object it drops. */
  object: string;
  /** Its entity type, e.g. `ClickHouse::Table`, `Postgres::Index`. */
  type: string;
  /** Its name on the server: `database.name` or `schema.name`, or a database's, schema's or extension's own name. */
  name: string;
}

/** One statement, as the applier would send it. */
export interface StatementStep extends StepObject {
  kind: "statement";
  sql: string;
  /** The rule of the change it makes. */
  rule: string;
  /** That rule's class. */
  class: string;
  /** False for a statement that may not run inside a transaction block (Postgres `CONCURRENTLY`, `ALTER TYPE ... ADD VALUE`). Always false for ClickHouse, which has none. */
  transactional: boolean;
  /** ClickHouse: the statement starts a mutation; wait for it in `system.mutations` before the next one. */
  waitsForMutation?: boolean;
  /** The statement removes data that is not recoverable (a column or table drop). */
  destructive?: boolean;
}

/** A change no statement makes in place, made by a migration Op. */
export interface OpStep extends StepObject {
  kind: "op";
  /** The Op's export name. */
  op: "ClickHouseRebuildOp" | "PostgresMigrationOp";
  /** The module the Op is imported from. */
  importPath: string;
  /** The Op's options as the hand-off suggests them: `name`, `env`, `table`, and `dualWrite` (ClickHouse) or `column` (Postgres). */
  options: Record<string, unknown>;
  /** The Op's declaration, ready for an `*.op.ts` file. */
  declaration: string;
  /** The changes the Op makes. */
  changes: StatementChange[];
  /** The refusal as the applier reports it: each rule, its restriction, and the Op. */
  detail: string;
}

/**
 * A change neither a statement nor an Op makes: a rebuild of a view or a
 * database, an expand-and-contract change no Op covers, a change with no
 * in-place statement, or the object's other changes that the applier holds
 * back while one of its changes is refused.
 */
export interface ManualStep extends StepObject {
  kind: "manual";
  changes: StatementChange[];
  detail: string;
}

export type MigrationStep = StatementStep | OpStep | ManualStep;

export interface SchemaStatements {
  dialect: "clickhouse" | "postgres";
  /** ClickHouse: the database a bare name means. */
  defaultDatabase?: string;
  /** Postgres: the schema a bare name means; the applier sets `search_path` to it. */
  defaultSchema?: string;
  /** Postgres: the major the changes were classified for. */
  major?: number;
  /** In the order they run: each object's in the newer build's creation order, then the drops. */
  steps: MigrationStep[];
  /** True when a step is an Op or manual: the schema change is more than statements. */
  refused: boolean;
  /** What the diff points out besides the changes (a likely rename written as a drop and an add). */
  hints: string[];
}

/** A classified change as a step names it, with no `undefined` fields. */
export function statementChange(c: { rule: string; class: string; field: string; before?: string; after?: string; destructive?: boolean; note?: string }): StatementChange {
  return {
    rule: c.rule,
    class: c.class,
    field: c.field,
    ...(c.before !== undefined ? { before: c.before } : {}),
    ...(c.after !== undefined ? { after: c.after } : {}),
    ...(c.destructive ? { destructive: true } : {}),
    ...(c.note !== undefined ? { note: c.note } : {}),
  };
}

/** The steps as a migration file's SQL: each statement after a comment naming its object, rule and class; an Op or manual step as a comment. */
export function renderStatements(doc: SchemaStatements): string {
  const out: string[] = [];
  for (const s of doc.steps) {
    if (s.kind === "statement") {
      const notes = [s.transactional || doc.dialect !== "postgres" ? "" : "outside a transaction", s.waitsForMutation ? "waits for its mutation" : "", s.destructive ? "destructive" : ""].filter(Boolean);
      out.push(`-- ${s.object} (${s.name}): ${s.rule} ${s.class}${notes.length ? `, ${notes.join(", ")}` : ""}`, `${s.sql};`, "");
    } else if (s.kind === "op") {
      out.push(`-- ${s.object} (${s.name}): ${s.changes.map((c) => c.rule).join(", ")} made by ${s.op}, not a statement:`, `--   ${s.declaration}`, "");
    } else {
      out.push(`-- ${s.object} (${s.name}): ${s.changes.map((c) => c.rule).join(", ")} has no statement and no Op: ${s.detail}`, "");
    }
  }
  return out.join("\n");
}
