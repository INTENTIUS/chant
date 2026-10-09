/**
 * A schema change's statements, rendered offline (#3644): for two `chant
 * build` outputs, the ordered statements that take the first to the second,
 * each with its change's class and rule, for a migration file. No server is
 * read.
 *
 * The statements are the applier's: each dialect's `planStatements` /
 * `planPgStatements` (`./clickhouse/apply/statements.ts`,
 * `./postgres/apply/statements.ts`) turns classified changes into steps, and
 * both the applier and this renderer call it. What differs is only where the
 * current schema comes from: here the older build, keyed by export name as
 * `chant sql diff` keys it; in the applier the server's catalog.
 *
 * A change the applier refuses in place is a step naming the Op that makes
 * it, never DDL: a ClickHouse rebuild is `ClickHouseRebuildOp`, a Postgres
 * column rename or type change across kinds is `PostgresMigrationOp`. One no
 * Op makes is a manual step. Column and object drops are statements, marked
 * destructive.
 *
 * Where the applier asks the server something, the renderer cannot:
 *
 * - ClickHouse: the applier also asks the server's formatter whether a
 *   difference the rules leave is only formatting; the offline diff is the
 *   rules' alone, as `chant sql diff` is. Before dropping a database it
 *   checks the database is empty.
 * - Postgres: the applier asks the server to normalize expressions the rules
 *   leave different, and keeps an extension's own comment (from its control
 *   file) under the trailer when the declaration sets none.
 * - Both: the applier restamps an object whose comment lost chant's marker;
 *   offline, the older build's objects carry it.
 */

import type { OwnershipMarker } from "@intentius/chant/ownership";
import { statementChange, type ManualStep, type MigrationStep, type SchemaStatements, type StepObject } from "./core/statements";
import { declaredObjects as clickhouseDeclared } from "./clickhouse/apply/apply";
import { planStatements, type DeclaredObject } from "./clickhouse/apply/statements";
import { topologyLabel, type Topology } from "./clickhouse/topology";
import { diffSchemas, type Change } from "./clickhouse/plan/diff";
import { rebuildOpSuggestions } from "./clickhouse/plan/rebuild-handoff";
import { declaredObjects as postgresDeclared } from "./postgres/apply/apply";
import { planPgStatements, type DeclaredPgObject } from "./postgres/apply/statements";
import { diffPgSchemas, type PgChange } from "./postgres/plan/diff";
import { pgBuildMajor } from "./postgres/plan/schema";
import { migrationOpSuggestions, migrationTarget } from "./postgres/migrate/handoff";
import { POSTGRES_ENTITY_TYPES } from "./postgres/entity-types";
import { POSTGRES_LATEST_MAJOR } from "./spec/postgres-pin";

export type { ManualStep, MigrationStep, OpStep, SchemaStatements, StatementChange, StatementStep, StepObject } from "./core/statements";
export { renderStatements } from "./core/statements";

export interface DiffStatementsOptions {
  /** The ownership marker every `CREATE` and restamped comment carries, as the applier stamps it. Default: `managed-by=chant` alone. */
  marker?: OwnershipMarker;
  /** The environment an Op step's suggested declaration names. Default: `<env>`. */
  env?: string;
  /** ClickHouse: the database a bare name means. Default: `default`. */
  defaultDatabase?: string;
  /**
   * ClickHouse: the topology to render the statements for
   * (`./clickhouse/topology.ts`): `ON CLUSTER` and the engine, on both
   * builds' declarations before they are compared, so the steps are the ones
   * the applier sends to an environment with that topology. Default: `single`.
   */
  topology?: Topology;
  /** Postgres: the schema a bare name means. Default: `public`. */
  defaultSchema?: string;
  /** Postgres: the major to classify for. Default: the newer build's `postgresMajor`, else the older's, else the newest pinned. */
  major?: number;
}

type BuildInput = string | object;

const text = (b: BuildInput): string => (typeof b === "string" ? b : JSON.stringify(b));

/** The dialect a build output names, at its root or under `sql`. */
function dialectOf(json: string): string | undefined {
  const raw = JSON.parse(json) as { dialect?: unknown; sql?: { dialect?: unknown } };
  const d = raw?.sql && typeof raw.sql === "object" ? raw.sql.dialect : raw?.dialect;
  return typeof d === "string" ? d : undefined;
}

/**
 * The statements that take the schema `before` builds to the one `after`
 * builds. Each is a `chant build` output of the sql lexicon, as JSON text or
 * parsed. Both must be the same dialect.
 */
export function diffStatements(before: BuildInput, after: BuildInput, options: DiffStatementsOptions = {}): SchemaStatements {
  const b = text(before);
  const a = text(after);
  const dialect = dialectOf(a);
  if (dialectOf(b) !== dialect) throw new Error(`diffStatements: the builds are different dialects (${dialectOf(b) ?? "none"} and ${dialect ?? "none"})`);
  if (dialect === "postgres") return postgresStatements(b, a, options);
  if (dialect === "clickhouse") return clickhouseStatements(b, a, options);
  throw new Error(`diffStatements: not a sql lexicon build output (dialect ${dialect ?? "missing"})`);
}

const at = (object: string, type: string, name: string): StepObject => ({ object, type, name });

// ── ClickHouse ─────────────────────────────────────────────────────────

function clickhouseStatements(beforeJson: string, afterJson: string, options: DiffStatementsOptions): SchemaStatements {
  const defaultDatabase = options.defaultDatabase ?? "default";
  const env = options.env ?? "<env>";
  const topology: Topology = options.topology ?? { kind: "single" };
  const before = clickhouseDeclared(beforeJson, defaultDatabase, topology);
  const after = clickhouseDeclared(afterJson, defaultDatabase, topology);
  const keyed = (objs: readonly DeclaredObject[]) => objs.map((o) => ({ key: o.exportName, canonical: o.canonical }));
  const diff = diffSchemas(keyed(before), keyed(after));
  const plan = planStatements({
    declared: after,
    changes: diff.changes,
    current: new Map(before.map((o) => [o.exportName, o.canonical])),
    keyOf: (o) => o.exportName,
    allowDestructive: true,
    topology,
    ...(options.marker ? { marker: options.marker } : {}),
  });
  const declaredByExport = new Map(after.map((o) => [o.exportName, o.canonical]));
  const isDestructive = (changes: readonly Change[], rule: string) => changes.some((c) => c.rule === rule && c.destructive);

  const steps: MigrationStep[] = [];
  for (const entry of plan.objects) {
    const where = at(entry.obj.exportName, entry.obj.type, entry.obj.key);
    if (entry.verdict === "rebuild") {
      const [op] = rebuildOpSuggestions({ ...diff, rebuilds: entry.refused }, declaredByExport, env);
      if (op) {
        steps.push({
          kind: "op",
          ...where,
          op: "ClickHouseRebuildOp",
          importPath: "@intentius/chant-lexicon-sql/clickhouse",
          options: { name: op.name, env: op.env, table: op.table, dualWrite: op.dualWrite },
          declaration: op.declaration,
          // The rebuild creates the new table from the declaration, so it makes every change to it.
          changes: entry.changes.map(statementChange),
          detail: entry.detail,
        });
      } else steps.push({ kind: "manual", ...where, changes: entry.refused.map(statementChange), detail: entry.detail });
      continue;
    }
    if (entry.verdict === "withheld") continue; // not reached: destructive changes are planned
    for (const s of entry.steps) {
      steps.push({
        kind: "statement",
        ...where,
        sql: s.sql,
        rule: s.rule,
        class: s.class,
        transactional: false,
        ...(s.rewrite ? { waitsForMutation: true } : {}),
        ...(s.rule === "SQLCH202" || isDestructive(entry.changes, s.rule) ? { destructive: true } : {}),
      });
    }
  }
  const beforeByExport = new Map(before.map((o) => [o.exportName, o]));
  for (const d of plan.drops) {
    const o = beforeByExport.get(d.key);
    const change = diff.changes.find((c) => c.object === d.key && c.rule === "SQLCH250");
    steps.push({
      kind: "statement",
      ...at(d.key, d.type, o?.key ?? d.name),
      sql: d.step.sql,
      rule: d.step.rule,
      class: d.step.class,
      transactional: false,
      ...(change?.destructive ? { destructive: true } : {}),
    });
  }
  return { dialect: "clickhouse", defaultDatabase, topology: topologyLabel(topology), steps, refused: steps.some((s) => s.kind !== "statement"), hints: diff.hints };
}

// ── Postgres ───────────────────────────────────────────────────────────

function postgresStatements(beforeJson: string, afterJson: string, options: DiffStatementsOptions): SchemaStatements {
  const defaultSchema = options.defaultSchema ?? "public";
  const env = options.env ?? "<env>";
  const major = options.major ?? buildMajor(afterJson) ?? buildMajor(beforeJson) ?? POSTGRES_LATEST_MAJOR;
  const before = postgresDeclared(beforeJson, defaultSchema);
  const after = postgresDeclared(afterJson, defaultSchema);
  const keyed = (objs: readonly DeclaredPgObject[]) => objs.map((o) => ({ key: o.exportName, canonical: o.canonical }));
  const current = keyed(before);
  const diff = diffPgSchemas(current, keyed(after), { major });
  const plan = planPgStatements({
    declared: after,
    changes: diff.changes,
    current,
    keyOf: (o) => o.exportName,
    major,
    allowDestructive: true,
    ...(options.marker ? { marker: options.marker } : {}),
  });
  const isDestructive = (changes: readonly PgChange[], rule: string | undefined) => changes.some((c) => c.rule === rule && c.destructive);

  const steps: MigrationStep[] = [];
  for (const entry of plan.objects) {
    const where = at(entry.obj.exportName, entry.obj.type, entry.obj.name);
    switch (entry.verdict) {
      case "refused": {
        const handled = new Set<PgChange>();
        for (const op of migrationOpSuggestions(entry.refused, new Map([[entry.obj.exportName, entry.obj.canonical]]), env, defaultSchema)) {
          const made = entry.refused.filter((c) => {
            const t = migrationTarget(c, entry.obj.canonical, defaultSchema);
            return t !== undefined && t.table === op.table && t.column === op.column;
          });
          for (const c of made) handled.add(c);
          steps.push({
            kind: "op",
            ...where,
            op: "PostgresMigrationOp",
            importPath: "@intentius/chant-lexicon-sql/postgres",
            options: { name: op.name, env: op.env, table: op.table, column: op.column },
            declaration: op.declaration,
            changes: made.map(statementChange),
            detail: entry.detail,
          });
        }
        const rest = entry.changes.filter((c) => !handled.has(c));
        if (rest.length > 0) steps.push(manual(where, rest, handled.size > 0 ? `the applier sends nothing for ${entry.obj.name} while a change to it is refused; these changes are not made by the Op: ${entry.detail}` : entry.detail));
        continue;
      }
      case "unsupported":
        steps.push(manual(where, entry.changes, entry.detail));
        continue;
      case "foreign":
      case "withheld":
        continue; // not reached offline: a build declares no foreign object, and destructive changes are planned
    }
    for (const s of entry.steps) {
      steps.push({
        kind: "statement",
        ...where,
        sql: s.sql,
        rule: s.rule ?? (s.class === "create" ? "SQLPG200" : (entry.changes[0]?.rule ?? "SQLPG200")),
        class: s.class,
        transactional: s.transactional,
        ...(s.rule === "SQLPG204" || isDestructive(entry.changes, s.rule) ? { destructive: true } : {}),
      });
    }
  }
  const beforeByExport = new Map(before.map((o) => [o.exportName, o]));
  for (const d of plan.drops) {
    const o = beforeByExport.get(d.key);
    const change = diff.changes.find((c) => c.object === d.key && (c.rule === "SQLPG270" || c.rule === "SQLPG242"));
    steps.push({
      kind: "statement",
      ...at(d.key, o?.type ?? POSTGRES_ENTITY_TYPES[d.kind], o?.name ?? d.name),
      sql: d.step.sql,
      rule: d.step.rule ?? "SQLPG270",
      class: d.step.class,
      transactional: d.step.transactional,
      ...(change?.destructive ? { destructive: true } : {}),
    });
  }
  return { dialect: "postgres", defaultSchema, major, steps, refused: steps.some((s) => s.kind !== "statement"), hints: diff.hints };
}

const manual = (where: StepObject, changes: readonly PgChange[], detail: string): ManualStep => ({ kind: "manual", ...where, changes: changes.map(statementChange), detail });

function buildMajor(json: string): number | undefined {
  const raw = JSON.parse(json) as { sql?: unknown };
  return pgBuildMajor(raw.sql && typeof raw.sql === "object" ? JSON.stringify(raw.sql) : json);
}
