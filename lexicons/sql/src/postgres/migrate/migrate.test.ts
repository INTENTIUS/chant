/**
 * The expand-and-contract migration's pieces that need no server (#3281):
 * the Op's shape and its contracts, the names and the trailer, the
 * dual-write function and the switch's statements, the replica-lag wait,
 * and the plan's hand-off to the Op. `migrate.e2e.test.ts` runs it against
 * the pinned server.
 */

import { describe, expect, test } from "vitest";
import {
  collectActivityContracts,
  gatePolicyVersion,
  loadActivityContracts,
  mergeActivityContracts,
  validateActivitySteps,
  validateStepOutputRefs,
  type ActivityContract,
  type OpConfig,
} from "@intentius/chant/op";
import * as contractsModule from "../../op/activity-contracts";
import * as activitiesModule from "../../op/activities";
import { readTrailerPairs } from "../../core/ownership";
import { diffPgSchemas } from "../plan/diff";
import { diffObject, type PgSchemaObject } from "../plan/schema";
import { renderPgDiff } from "../plan/report";
import { refusalDetail } from "../apply/statements";
import { PostgresMigrationOp, type PostgresMigrationOpConfig } from "./op";
import { migrationNames, MIGRATION_TRAILER_KEY, pgName } from "./names";
import { dualWriteBody, dualWriteStatements, switchStatements, workingComment } from "./steps";
import { migrationOpSuggestions } from "./handoff";
import { ReplicationLagError, waitForReplicas } from "./replication";
import type { MigrationObservation } from "./observe";

const BASE: PostgresMigrationOpConfig = { name: "migrate-users-login", env: "prod", table: "app.users", column: "login" };
const propsOf = (config: PostgresMigrationOpConfig) => (PostgresMigrationOp(config).op as unknown as { props: OpConfig }).props;
const MARKER = { stack: "shop", env: "prod" };

describe("PostgresMigrationOp", () => {
  test("its phases, in order, with onFailure dropping what the expand added", () => {
    const props = propsOf(BASE);
    expect(props.phases.map((p) => p.name)).toEqual([
      "Build",
      "Plan",
      "Expand",
      "Dual write",
      "Backfill",
      "Carry over",
      "Verify",
      "Approve",
      "Switch",
      "Retain",
      "Approve contract",
      "Contract",
    ]);
    expect(props.onFailure?.map((p) => p.steps.map((s) => (s as { fn?: string }).fn))).toEqual([["postgresMigrationCompensate"]]);
    expect(props.labels).toEqual({ Migration: "true", Env: "prod", Table: "app.users", Column: "login" });
  });

  test("the switch gate binds the verification's digest and the contract gate the kept column's", () => {
    const gates = propsOf(BASE).phases.flatMap((p) => p.steps).filter((s) => s.kind === "gate") as Array<{ gate: string; plan: unknown }>;
    expect(gates.map((g) => g.gate)).toEqual(["approve-migrate-users-login", "approve-migrate-users-login-contract"]);
    expect(JSON.stringify(gates[0]!.plan)).toContain('"verify"');
    expect(JSON.stringify(gates[0]!.plan)).toContain('"planDigest"');
    expect(JSON.stringify(gates[1]!.plan)).toContain('"contractDigest"');
  });

  test("a policy on the switch gate gets the verification's counts as context", () => {
    const text = "permit (principal, action, resource);";
    const policy = { kind: "gate-policy" as const, lexicon: "cedar", name: "ship", version: gatePolicyVersion(text), text };
    const props = propsOf({ ...BASE, gate: { approval: { policy, mode: "log-only" } } });
    const g = props.phases.find((p) => p.name === "Approve")!.steps[0] as { approval: { context: Record<string, unknown> } };
    expect(Object.keys(g.approval.context)).toEqual(["verifiedRows", "mismatched"]);
  });

  test("bad configuration fails when the Op is built", () => {
    expect(() => PostgresMigrationOp({ ...BASE, table: "app.users; DROP" })).toThrow(/table must be/);
    expect(() => PostgresMigrationOp({ ...BASE, column: "" })).toThrow(/column must be/);
    expect(() => PostgresMigrationOp({ ...BASE, batchSize: 0 })).toThrow(/batchSize/);
    expect(() => PostgresMigrationOp({ ...BASE, retain: "soon" })).toThrow();
  });

  test("every step passes the contracts OPS012 and OPS013 check it against at build", async () => {
    const contracts = new Map<string, ActivityContract>();
    collectActivityContracts(contractsModule as unknown as Record<string, unknown>, contracts);
    const merged = mergeActivityContracts(await loadActivityContracts([]), contracts);
    const full: PostgresMigrationOpConfig = {
      ...BASE,
      using: "CAST(login AS text)",
      retain: "3d",
      batchSize: 500,
      replicationLag: { max: "5s", wait: "10m" },
      lockTimeoutMs: 2000,
      statementTimeoutMs: 30000,
      stack: "shop",
      ownershipEnv: "prod",
      build: false,
    };
    for (const config of [BASE, full, { ...BASE, replicationLag: false as const }]) {
      const props = propsOf(config);
      expect(validateActivitySteps(props, merged)).toEqual([]);
      expect(validateStepOutputRefs(props, merged)).toEqual([]);
    }
  });

  test("every migration step is an activity the sql lexicon exports, and none is a receipt activity", () => {
    const exported = new Set(Object.entries(activitiesModule).filter(([, v]) => typeof v === "function").map(([k]) => k));
    const steps = propsOf(BASE).phases.flatMap((p) => p.steps).filter((s) => s.kind === "activity" && (s as { fn: string }).fn.startsWith("postgresMigration"));
    expect(steps).toHaveLength(9);
    for (const s of steps) expect(exported.has((s as { fn: string }).fn)).toBe(true);
    expect(exported.has("receiptRead")).toBe(false);
  });
});

describe("names", () => {
  test("a type change works under __chant_new and keeps the old column as __chant_old; a rename keeps the old name", () => {
    const t = migrationNames("app", "orders", "amount", "type", "amount");
    expect([t.key, t.newColumn, t.oldColumn, t.trigger, t.fn, t.check, t.qualifiedTable]).toEqual([
      "app.orders.amount",
      "amount__chant_new",
      "amount__chant_old",
      "amount__chant_sync",
      "orders__amount__chant_sync",
      "amount__chant_new__chant_nn",
      "app.orders",
    ]);
    const r = migrationNames("app", "users", "login", "rename", "email");
    expect([r.newColumn, r.oldColumn, r.source]).toEqual(["login", "email", "email"]);
  });

  test("a name longer than Postgres keeps is cut and given a hash, the same each time", () => {
    const long = `${"x".repeat(60)}__chant_new`;
    expect(pgName(long)).toHaveLength(63);
    expect(pgName(long)).toBe(pgName(long));
    expect(pgName(long)).not.toBe(pgName(`${"x".repeat(61)}__chant_new`));
    expect(pgName("short")).toBe("short");
  });

  test("a working object's comment carries the marker, the migration and its role", () => {
    const n = migrationNames("app", "users", "login", "rename", "email");
    const pairs = readTrailerPairs(workingComment(n, MARKER, "old", "kept", { "retain-until": "2026-10-10T00:00:00.000Z" }))!;
    expect(Object.fromEntries(pairs)).toEqual({ "managed-by": "chant", stack: "shop", env: "prod", [MIGRATION_TRAILER_KEY]: "app.users.login", role: "old", "retain-until": "2026-10-10T00:00:00.000Z" });
  });
});

const observation = (change: "rename" | "type", over: Partial<MigrationObservation> = {}): MigrationObservation => {
  const names = change === "rename" ? migrationNames("app", "users", "login", "rename", "email") : migrationNames("app", "orders", "amount", "type", "amount");
  return {
    state: "migrate",
    names,
    declared: {} as MigrationObservation["declared"],
    column: change === "rename" ? { name: "login", type: "text", notNull: true } : { name: "amount", type: "numeric(12,2)", notNull: true, default: "0", comment: "In euros" },
    oid: "16384",
    batchKey: "id",
    keyColumns: [{ name: "id", type: "bigint" }],
    carried: [],
    carriedStates: new Map(),
    views: [],
    columns: new Map(),
    source: { attnum: 2, name: names.source, type: "text", notNull: true, generated: false, identity: false, ...(change === "type" ? { default: "'0'::text" } : {}) },
    changes: [],
    expression: change === "rename" ? '"email"' : "CAST(amount AS numeric(12,2))",
    publications: [],
    major: 18,
    ...over,
  };
};

describe("dual write", () => {
  test("a type change computes the new column from the row with the backfill's expression", () => {
    const body = dualWriteBody(observation("type"));
    expect(body).toContain("NEW.amount__chant_new := (SELECT CAST(amount AS numeric(12,2)) FROM (SELECT NEW.*) AS orders);");
  });

  test("a rename writes each column from the other: an insert from whichever it was given, an update from whichever it changed", () => {
    const body = dualWriteBody(observation("rename"));
    expect(body).toContain("IF NEW.login IS NULL THEN NEW.login := NEW.email; ELSE NEW.email := NEW.login; END IF;");
    expect(body).toContain("ELSIF NEW.login IS DISTINCT FROM OLD.login THEN");
    expect(body).toContain("NEW.email := NEW.login;");
    expect(body).toContain("NEW.login := NEW.email;");
  });

  test("the function runs with the declarations' schema as its search_path and both objects are marked", () => {
    const sql = dualWriteStatements(observation("type"), MARKER, "app");
    expect(sql[0]).toMatch(/^CREATE OR REPLACE FUNCTION app\.orders__amount__chant_sync\(\) RETURNS trigger LANGUAGE plpgsql SET search_path = app AS \$chant\$/);
    expect(sql[3]).toBe("CREATE TRIGGER amount__chant_sync BEFORE INSERT OR UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.orders__amount__chant_sync()");
    expect(sql[4]).toContain("migration=app.orders.amount role=dual");
  });
});

describe("switch", () => {
  test("a type change swaps the columns by name in one transaction and keeps the old one unwritten", () => {
    const o = observation("type", { check: { name: "amount__chant_new__chant_nn", validated: true } });
    expect(switchStatements(o, MARKER, "2026-10-10T00:00:00.000Z")).toEqual([
      "ALTER TABLE app.orders ALTER COLUMN amount__chant_new SET NOT NULL",
      "ALTER TABLE app.orders DROP CONSTRAINT amount__chant_new__chant_nn",
      "DROP TRIGGER amount__chant_sync ON app.orders",
      "ALTER TABLE app.orders ALTER COLUMN amount DROP NOT NULL",
      "ALTER TABLE app.orders ALTER COLUMN amount DROP DEFAULT",
      "ALTER TABLE app.orders RENAME COLUMN amount TO amount__chant_old",
      "ALTER TABLE app.orders RENAME COLUMN amount__chant_new TO amount",
      "ALTER TABLE app.orders ALTER COLUMN amount SET DEFAULT 0",
      "COMMENT ON COLUMN app.orders.amount IS 'In euros'",
      expect.stringMatching(/^COMMENT ON COLUMN app\.orders\.amount__chant_old IS 'chant migration of app\.orders\.amount: the old column, kept until 2026-10-10T00:00:00\.000Z \[chant .* migration=app\.orders\.amount role=old retain-until=2026-10-10T00%3A00%3A00\.000Z\]'$/),
      "DROP FUNCTION app.orders__amount__chant_sync()",
    ]);
  });

  test("a rename finishes the new column and keeps the trigger writing the old one until the contract", () => {
    const sql = switchStatements(observation("rename"), MARKER, "2026-10-10T00:00:00.000Z");
    expect(sql).toEqual([
      "ALTER TABLE app.users ALTER COLUMN login SET NOT NULL",
      "COMMENT ON COLUMN app.users.login IS NULL",
      expect.stringMatching(/^COMMENT ON COLUMN app\.users\.email IS .*role=old/),
    ]);
  });
});

describe("replication lag", () => {
  const client = (answers: Array<Array<{ name: string; state: string | null; lag_ms: string | number | null }>>) => ({
    query: async <T>() => (answers.length > 1 ? answers.shift()! : answers[0]!) as unknown as T[],
  });
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  test("no replicas: the check passes at once", async () => {
    expect(await waitForReplicas(client([[]]), { maxLagMs: 1000, waitMs: 5000 }, clock())).toBe(0);
  });

  test("a replica behind: the batch waits until it catches up; a NULL replay_lag is no lag", async () => {
    const lines: string[] = [];
    const waited = await waitForReplicas(
      client([[{ name: "standby1", state: "streaming", lag_ms: 4000 }], [{ name: "standby1", state: "streaming", lag_ms: 2500 }], [{ name: "standby1", state: "streaming", lag_ms: null }]]),
      { maxLagMs: 1000, waitMs: 60_000 },
      { ...clock(), log: (l) => lines.push(l) },
    );
    expect(waited).toBe(2000);
    expect(lines[0]).toMatch(/replicas behind \(standby1 4s\); pausing the backfill/);
  });

  test("a replica that stays behind stops the backfill, naming it", async () => {
    await expect(waitForReplicas(client([[{ name: "standby1", state: "streaming", lag_ms: 90_000 }]]), { maxLagMs: 1000, waitMs: 3000 }, clock())).rejects.toThrow(
      /did not: standby1 90s behind/,
    );
  });

  test("a lag this role cannot read stops the backfill with the grant to make", async () => {
    await expect(waitForReplicas(client([[{ name: "12345", state: null, lag_ms: null }]]), { maxLagMs: 1000, waitMs: 3000 }, clock())).rejects.toThrow(ReplicationLagError);
    await expect(waitForReplicas(client([[{ name: "12345", state: null, lag_ms: null }]]), { maxLagMs: 1000, waitMs: 3000 }, clock())).rejects.toThrow(/pg_monitor/);
  });
});

describe("the plan's hand-off", () => {
  const obj = (key: string, ddl: string): PgSchemaObject => ({ key, canonical: { ...diffObject("Postgres::Table", ddl, "public"), exportName: key } });
  const USERS = "CREATE TABLE app.users (id bigint PRIMARY KEY, email text NOT NULL, status text)";
  const before = [obj("users", USERS)];
  const after = [obj("users", "CREATE TABLE app.users (id bigint PRIMARY KEY,\n  login text NOT NULL, -- previously: email\n  status integer)")];

  test("a rename and a type change across kinds each get a PostgresMigrationOp declaration", () => {
    const d = diffPgSchemas(before, after);
    expect(d.refused.map((c) => c.rule)).toEqual(["SQLPG205", "SQLPG208"]);
    const ops = migrationOpSuggestions(d.refused, new Map(after.map((o) => [o.key, o.canonical])), "prod");
    expect(ops.map((o) => [o.table, o.column, o.rule, o.name])).toEqual([
      ["app.users", "login", "SQLPG205", "migrate-app-users-login"],
      ["app.users", "status", "SQLPG208", "migrate-app-users-status"],
    ]);
    expect(ops[0]!.declaration).toBe('export const { op } = PostgresMigrationOp({ name: "migrate-app-users-login", env: "prod", table: "app.users", column: "login" });');
    const report = renderPgDiff({ ...d, migrationOps: ops });
    expect(report).toContain('import { PostgresMigrationOp } from "@intentius/chant-lexicon-sql/postgres"');
    expect(report).toContain(ops[1]!.declaration);
  });

  test("an expand-and-contract change the Op does not make gets no declaration", () => {
    const d = diffPgSchemas(before, [obj("users", "CREATE TABLE app.users (id bigint PRIMARY KEY, email text NOT NULL, status text, tier int NOT NULL)")]);
    expect(d.refused.map((c) => c.rule)).toEqual(["SQLPG203"]);
    expect(migrationOpSuggestions(d.refused, new Map(), "prod")).toEqual([]);
    expect(refusalDetail(d.refused, "app.users")).toMatch(/No migration Op makes this change yet/);
  });

  test("the applier's refusal names the Op with the table and column", () => {
    const d = diffPgSchemas(before, after);
    const detail = refusalDetail(d.refused, "app.users", after[0]!.canonical);
    expect(detail).toContain('PostgresMigrationOp({ table: "app.users", column: "login", ... }), PostgresMigrationOp({ table: "app.users", column: "status", ... })');
    expect(detail).toContain("@intentius/chant-lexicon-sql/postgres");
  });
});
