/**
 * SQL plans as change-set parts (#3767): a versioned plan, as
 * `diffStatements` writes its steps and as SQL Yodeler's plan view holds
 * them, and the migration Ops' plan steps. Every part composes with core's
 * lifecycle part and gives a gate its Cedar `context.plan`; the digests are
 * stable under re-planning and move with the plan.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";
import { composeChangeSet, lifecyclePlanPart, verifyChangeSetDigest, type ChangeSetPart } from "@intentius/chant/change-set";
import type { ChangeSet as LifecycleChangeSet } from "@intentius/chant/lifecycle/change-set";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { gatePlanSummaryOfResult } from "@intentius/chant/op/gate-plan-context";
import { readChangeSetPart } from "@intentius/chant/op/activities/change-set";
import { diffStatements } from "./migration-statements";
import { clickhouseRebuildPart, postgresMigrationPart, SQL_CLASS_DISRUPTION, sqlChangeAction, sqlVersionedPlanPart, type SqlPlanStep, type SqlVersionedPlan } from "./change-set";
import { CHANGE_CLASSES } from "./clickhouse/plan/rules";
import { PG_CHANGE_CLASSES } from "./postgres/plan/rules";

const REPO = join(import.meta.dirname, "..", "..", "..");
const LIFECYCLE = JSON.parse(readFileSync(join(REPO, "packages", "core", "src", "__fixtures__", "change-set", "lifecycle-plan.floci.json"), "utf-8")) as LifecycleChangeSet;

interface Obj {
  export: string;
  type: string;
  ddl: string;
  dependsOn?: string[];
}
const buildOf = (dialect: string, objects: Obj[]) => ({ dialect, applyOrder: objects.map((o) => o.export), objects: objects.map((o) => ({ dependsOn: [], ...o })) });

const DB: Obj = { export: "analytics", type: "ClickHouse::Database", ddl: "CREATE DATABASE analytics ENGINE = Atomic" };
const EVENTS: Obj = { export: "events", type: "ClickHouse::Table", dependsOn: ["analytics"], ddl: "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, kind String) ENGINE = MergeTree ORDER BY (ts, user_id)" };
const EVENTS_V2: Obj = { ...EVENTS, ddl: "CREATE TABLE analytics.events (ts DateTime, user_id UInt64, region String DEFAULT 'eu', kind LowCardinality(String)) ENGINE = MergeTree ORDER BY (ts, user_id)" };
const SESSIONS: Obj = { export: "sessions", type: "ClickHouse::Table", dependsOn: ["analytics"], ddl: "CREATE TABLE analytics.sessions (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY id" };
const SESSIONS_RESORTED: Obj = { ...SESSIONS, ddl: "CREATE TABLE analytics.sessions (id UInt64, ts DateTime) ENGINE = MergeTree ORDER BY (ts, id)" };
const OLD: Obj = { export: "old", type: "ClickHouse::Table", dependsOn: ["analytics"], ddl: "CREATE TABLE analytics.old (a UInt8) ENGINE = MergeTree ORDER BY a" };
const BY_KIND: Obj = { export: "byKind", type: "ClickHouse::View", dependsOn: ["events"], ddl: "CREATE VIEW analytics.by_kind AS SELECT kind, count() AS n FROM analytics.events GROUP BY kind" };

/** The migration a product would write for the change: the steps `chant sql diff --statements --json` prints. */
const migration = () => diffStatements(buildOf("clickhouse", [DB, EVENTS, SESSIONS, OLD]), buildOf("clickhouse", [DB, EVENTS_V2, SESSIONS_RESORTED, BY_KIND]), { env: "prod" });

const versioned = (extra: Partial<SqlVersionedPlan> = {}): SqlVersionedPlan => ({ dialect: "clickhouse", environment: "prod", migrations: [{ id: "0002_events_region", steps: migration().steps }], ...extra });

describe("sqlVersionedPlanPart", () => {
  test("one entry per object, its action and disruption from the steps' change classes", () => {
    const part = sqlVersionedPlanPart({ member: "warehouse", plan: versioned() });
    expect(part.member).toMatchObject({ member: "warehouse", lexicon: "sql", planner: "sql", scope: "prod", status: "planned", holes: [] });
    expect(part.member.planDigest).toMatch(/^jcs1-sha256:/);
    expect(part.entries.map((e) => [e.address, e.type, e.action, e.disruption ?? null])).toEqual([
      ["analytics.events", "ClickHouse::Table", "update", "rolling"],
      ["analytics.sessions", "ClickHouse::Table", "replace", "replace"],
      ["analytics.by_kind", "ClickHouse::View", "create", null],
      ["analytics.old", "ClickHouse::Table", "delete", "destroy"],
    ]);
    const events = part.entries[0];
    expect(events.scope).toBe("prod");
    expect(events.attributes.find((a) => a.path === "sql")?.after).toEqual(migration().steps.filter((s) => s.kind === "statement" && s.object === "events").map((s) => (s as { sql: string }).sql));
    const sessions = part.entries[1];
    expect(sessions.attributes.find((a) => a.path === "op")).toEqual({ path: "op", after: ["ClickHouseRebuildOp"] });
    expect(sessions.attributes.find((a) => a.path === "orderBy")).toMatchObject({ forcesReplacement: true });
  });

  test("SQL Yodeler's plan view goes in as it stands: pending, wrapped steps, done steps left out, its digest the member's", () => {
    const steps = migration().steps.map((step, index) => ({ index, step, done: index === 0 }));
    const plan = { environment: "prod", dialect: "clickhouse", appliedCount: 4, pending: [{ id: "0002_events_region", outOfOrder: false, steps }], problems: [], digest: "jcs1-sha256:" + "a".repeat(64), notes: [] };
    const part = sqlVersionedPlanPart({ member: "warehouse", plan });
    expect(part.member.planDigest).toBe(plan.digest);
    const events = part.entries.find((e) => e.address === "analytics.events")!;
    expect((events.attributes.find((a) => a.path === "sql")?.after as string[]).length).toBe(1);
    expect(sqlVersionedPlanPart({ member: "warehouse", plan: { ...plan, digest: undefined } }).member.planDigest).not.toBe(sqlVersionedPlanPart({ member: "warehouse", plan: versioned() }).member.planDigest);
  });

  test("a refusal is a failed member with no digest; a hole is carried", () => {
    const part = sqlVersionedPlanPart({ member: "warehouse", plan: versioned({ refusal: { message: "checksum mismatch on 0001" }, holes: [{ address: "analytics.history", reason: "unreadable" }] }) });
    expect(part.member).toMatchObject({ status: "failed", error: "checksum mismatch on 0001", planDigest: null, holes: [{ address: "analytics.history", reason: "unreadable" }] });
  });

  test("a product's own steps: classes it fills, an action it names, a destructive column drop", () => {
    const step = (s: Partial<SqlPlanStep> & { sql: string; class: string }): SqlPlanStep => ({ kind: "statement", object: "orders", type: "Postgres::Table", name: "public.orders", rule: "R", transactional: true, ...s }) as SqlPlanStep;
    const part = sqlVersionedPlanPart({
      member: "app-db",
      plan: {
        dialect: "postgres",
        migrations: [
          { id: "0007", steps: [step({ sql: "ALTER TABLE public.orders DROP COLUMN note", class: "metadata", destructive: true })] },
          { id: "0008", steps: [step({ sql: "CREATE INDEX CONCURRENTLY orders_by_day ON public.orders (day)", class: "concurrently", changes: [{ rule: "SQLPG230", class: "concurrently", field: "indexes.orders_by_day", after: "(day)" }] })] },
          { id: "0009", steps: [{ ...step({ sql: "CREATE OR REPLACE VIEW public.totals AS SELECT 1", class: "mystery" }), name: "public.totals", type: "Postgres::View", action: "update" }] },
        ],
      },
    });
    expect(part.entries.map((e) => [e.address, e.action, e.disruption])).toEqual([
      ["public.orders", "update", "destroy"],
      ["public.totals", "update", "unknown"],
    ]);
    expect(part.entries[0].attributes).toEqual([
      { path: "indexes.orders_by_day", after: "(day)" },
      { path: "sql", after: ["ALTER TABLE public.orders DROP COLUMN note", "CREATE INDEX CONCURRENTLY orders_by_day ON public.orders (day)"] },
    ]);
    expect(part.member.scope).toBeUndefined();
  });

  test("the digest is stable across re-planning and moves with any step", () => {
    const one = sqlVersionedPlanPart({ member: "warehouse", plan: versioned() });
    expect(sqlVersionedPlanPart({ member: "warehouse", plan: versioned() })).toEqual(one);
    expect(sqlVersionedPlanPart({ member: "renamed", plan: versioned() }).member.planDigest).toBe(one.member.planDigest);
    const steps = migration().steps;
    const edited = steps.map((s, i) => (i === 0 && s.kind === "statement" ? { ...s, sql: s.sql.replace("'eu'", "'us'") } : s));
    expect(sqlVersionedPlanPart({ member: "warehouse", plan: versioned({ migrations: [{ id: "0002_events_region", steps: edited }] }) }).member.planDigest).not.toBe(one.member.planDigest);
    expect(sqlVersionedPlanPart({ member: "warehouse", plan: versioned({ environment: "staging" }) }).member.planDigest).not.toBe(one.member.planDigest);
    expect(sqlVersionedPlanPart({ member: "warehouse", plan: versioned({ migrations: [{ id: "0003", steps }] }) }).member.planDigest).not.toBe(one.member.planDigest);
    expect(one.member.planDigest).toBe(
      computePlanDigest("sql-versioned-plan", { dialect: "clickhouse", environment: "prod", migrations: [{ id: "0002_events_region", steps }] }),
    );
  });
});

describe("the classes", () => {
  test("cost what the dialects' class tables say", () => {
    for (const classes of [CHANGE_CLASSES, PG_CHANGE_CLASSES]) {
      for (const [cls, disruption] of Object.entries(classes.disruption)) expect([cls, SQL_CLASS_DISRUPTION[cls]]).toEqual([cls, disruption]);
    }
    expect(Object.keys(SQL_CLASS_DISRUPTION).sort()).toEqual([...new Set([...CHANGE_CLASSES.order, ...PG_CHANGE_CLASSES.order])].sort());
  });

  test("a named action wins; drop, create and rebuild classes decide otherwise", () => {
    const none = { actions: [], destructive: false, ops: [] };
    expect(sqlChangeAction({ ...none, classes: ["metadata", "drop"] })).toEqual({ action: "delete", disruption: "destroy" });
    expect(sqlChangeAction({ ...none, classes: ["create", "metadata"] })).toEqual({ action: "create" });
    expect(sqlChangeAction({ ...none, classes: ["expand"], destructive: true })).toEqual({ action: "replace", disruption: "destroy" });
    expect(sqlChangeAction({ ...none, classes: ["rewrite", "validate"] })).toEqual({ action: "update", disruption: "rolling" });
    expect(sqlChangeAction({ ...none, classes: [] })).toEqual({ action: "update", disruption: "unknown" });
    expect(sqlChangeAction({ ...none, classes: ["drop"], actions: ["no-op"] })).toEqual({ action: "no-op" });
  });
});

describe("the migration Ops' plan steps", () => {
  const rebuild = {
    state: "rebuild",
    table: "analytics.sessions",
    planDigest: computePlanDigest("clickhouse-rebuild", { t: 1 }),
    changes: ["SQLCH211 orderBy: id -> (ts, id)"],
    classified: [{ rule: "SQLCH211", class: "rebuild", field: "orderBy", before: "id", after: "(ts, id)" }],
  };

  test("a rebuild is one replace of the table, its digest the plan step's", () => {
    const part = clickhouseRebuildPart({ member: "sessions-rebuild", plan: rebuild, environment: "prod" });
    expect(part.member).toMatchObject({ member: "sessions-rebuild", planner: "sql", scope: "prod", status: "planned", planDigest: rebuild.planDigest });
    expect(part.entries).toEqual([
      {
        member: "sessions-rebuild",
        lexicon: "sql",
        planner: "sql",
        address: "analytics.sessions",
        type: "ClickHouse::Table",
        action: "replace",
        disruption: "replace",
        scope: "prod",
        attributes: [
          { path: "orderBy", before: "id", after: "(ts, id)", forcesReplacement: true },
          { path: "op", after: ["ClickHouseRebuildOp"] },
        ],
      },
    ]);
    // Without the structured changes the field still reads from the line.
    const { classified: _, ...lines } = rebuild;
    expect(clickhouseRebuildPart({ member: "m", plan: lines }).entries[0].attributes[0]).toEqual({ path: "orderBy" });
  });

  test("a swapped or finished Op proposes nothing, under a digest that says which", () => {
    const swapped = clickhouseRebuildPart({ member: "m", plan: { state: "swapped", table: "analytics.sessions", changes: [] } });
    expect(swapped.entries).toEqual([]);
    expect(swapped.member.planDigest).toBe(clickhouseRebuildPart({ member: "m", plan: { state: "swapped", table: "analytics.sessions", changes: [] } }).member.planDigest);
    expect(swapped.member.planDigest).not.toBe(clickhouseRebuildPart({ member: "m", plan: { state: "done", table: "analytics.sessions", changes: [] } }).member.planDigest);
  });

  test("an expand-and-contract migration replaces its table", () => {
    const part = postgresMigrationPart({
      member: "orders-amount",
      plan: { state: "migrate", migration: "public.orders.amount", planDigest: computePlanDigest("postgres-migration", { t: 1 }), changes: [], classified: [{ rule: "SQLPG207", class: "expand", field: "columns.amount.type", before: "integer", after: "numeric(12,2)" }] },
    });
    expect(part.entries.map((e) => [e.address, e.type, e.action, e.disruption])).toEqual([["public.orders", "Postgres::Table", "replace", "replace"]]);
    expect(part.entries[0].attributes[0]).toEqual({ path: "columns.amount.type", before: "integer", after: "numeric(12,2)", forcesReplacement: true });
  });
});

describe("with other members", () => {
  const lifecycle = () => lifecyclePlanPart({ member: "delivery", plan: LIFECYCLE });
  const warehouse = () => sqlVersionedPlanPart({ member: "warehouse", plan: versioned() });
  const rebuildPart = () => clickhouseRebuildPart({ member: "sessions-rebuild", plan: { state: "rebuild", table: "analytics.sessions", planDigest: computePlanDigest("clickhouse-rebuild", { t: 1 }), changes: [] } });

  test("composes with a lifecycle part into one document whose digest is order-independent", () => {
    const doc = composeChangeSet([lifecycle(), warehouse(), rebuildPart()]);
    expect(composeChangeSet([rebuildPart(), warehouse(), lifecycle()])).toEqual(doc);
    expect(verifyChangeSetDigest(doc)).toBe(true);
    expect(doc.members.map((m) => [m.member, m.planner])).toEqual([["delivery", "chant"], ["sessions-rebuild", "sql"], ["warehouse", "sql"]]);
    expect(doc.summary.byMember.warehouse).toEqual({ update: 1, replace: 1, create: 1, delete: 1 });
    expect(doc.summary.deletes).toContainEqual({ member: "warehouse", address: "analytics.old", type: "ClickHouse::Table", disruption: "destroy" });
    const moved = sqlVersionedPlanPart({ member: "warehouse", plan: versioned({ environment: "staging" }) });
    expect(composeChangeSet([lifecycle(), moved, rebuildPart()]).digest).not.toBe(doc.digest);
  });

  test("gives a gate its Cedar context.plan", () => {
    const plan = gatePlanSummaryOfResult({ part: warehouse() })!;
    expect(plan).toMatchObject({ members: ["warehouse"], deletes: 1, replaces: 1, creates: 1, updates: 1 });
    expect(plan.lexicons).toEqual(["sql"]);
    const whole = gatePlanSummaryOfResult({ document: composeChangeSet([lifecycle(), warehouse()]) })!;
    expect(whole.members).toEqual(["delivery", "warehouse"]);
  });

  test("a part written to a file reads back through readChangeSetPart with planner sql", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-sql-change-set-"));
    const file = join(dir, "warehouse.part.json");
    writeFileSync(file, JSON.stringify(sqlVersionedPlanPart({ member: "written-as", plan: versioned() })));
    const { part } = await readChangeSetPart({ member: "warehouse", planner: "sql", file });
    expect(part).toEqual(warehouse());
  });
});

describe("the bundle", () => {
  test("holds the adapter and chant's plan hashing code, and nothing heavier", async () => {
    const result = await build({
      entryPoints: [join(import.meta.dirname, "change-set.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      outdir: "out",
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs).map((i) => i.replace(/^.*?(packages|lexicons)\//, "$1/")).sort();
    expect(inputs).toEqual([
      "lexicons/sql/src/change-set.ts",
      "packages/core/src/content-digest.ts",
      "packages/core/src/declarable.ts",
      "packages/core/src/effect-receipt.ts",
      "packages/core/src/intrinsic.ts",
      "packages/core/src/lifecycle/plan-digest.ts",
    ]);
    expect(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0)).toBeLessThan(24 * 1024);
  });
});
