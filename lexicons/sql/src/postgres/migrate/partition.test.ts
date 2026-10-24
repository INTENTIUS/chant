/**
 * An index on a partitioned table's migrated column (#3333), carried over
 * per partition: the `ON ONLY` statement, each partition's `CONCURRENTLY`
 * build, the attach, and a run that goes on from where the last stopped.
 * The e2e is `partition.e2e.test.ts`.
 */

import { describe, expect, test } from "vitest";
import type { PostgresClient } from "../live/client";
import { carriedPartitionedIndexStatement, discoverDependents, partitionIndexName, partitionIndexStatement, type CarriedObject } from "./carry";
import { migrationNames } from "./names";
import { carryPartitionedIndex, type MigrationRun } from "./steps";

const DEF = "CREATE INDEX events_amount_idx ON ONLY app.events USING btree (amount)";

describe("the statements", () => {
  test("a partitioned index is made again ON ONLY on the new column, without CONCURRENTLY", () => {
    expect(carriedPartitionedIndexStatement(DEF, "events_amount_idx__chant_new", "amount", "amount__chant_new")).toBe("CREATE INDEX events_amount_idx__chant_new ON ONLY app.events USING btree (amount__chant_new)");
    expect(carriedPartitionedIndexStatement("CREATE UNIQUE INDEX e ON ONLY app.events USING btree (id, amount) WHERE (amount > 0)", "e__chant_new", "amount", "login")).toBe(
      "CREATE UNIQUE INDEX e__chant_new ON ONLY app.events USING btree (id, login) WHERE (login > 0)",
    );
    // Without ONLY in the definition, the statement still has it.
    expect(carriedPartitionedIndexStatement("CREATE INDEX e ON app.events USING btree (amount)", "w", "amount", "n")).toBe("CREATE INDEX w ON ONLY app.events USING btree (n)");
  });

  test("a partition that holds rows gets a CONCURRENTLY build, one that is partitioned further gets ON ONLY", () => {
    const c = { definition: "CREATE UNIQUE INDEX events_amount_idx__chant_new ON ONLY app.events USING btree (id, amount__chant_new) WHERE (amount__chant_new > 0)" };
    expect(partitionIndexStatement(c, { ident: "app.events_2025", leaf: true }, "events_2025_events_amount_idx__chant_new")).toBe(
      "CREATE UNIQUE INDEX CONCURRENTLY events_2025_events_amount_idx__chant_new ON app.events_2025 USING btree (id, amount__chant_new) WHERE (amount__chant_new > 0)",
    );
    expect(partitionIndexStatement(c, { ident: "app.events_2026", leaf: false }, "events_2026_x")).toBe(
      "CREATE UNIQUE INDEX events_2026_x ON ONLY app.events_2026 USING btree (id, amount__chant_new) WHERE (amount__chant_new > 0)",
    );
  });

  test("the partition's index name keeps within what Postgres keeps", () => {
    expect(partitionIndexName({ name: "events_2025" }, "events_amount_idx__chant_new")).toBe("events_2025_events_amount_idx__chant_new");
    expect(partitionIndexName({ name: "p".repeat(40) }, "i".repeat(40))).toHaveLength(63);
  });
});

const names = migrationNames("app", "events", "amount", "type", "amount");
const c: CarriedObject = {
  kind: "index",
  name: "events_amount_idx",
  table: "app.events",
  tableName: "app.events",
  tableOid: "100",
  schema: "app",
  working: "events_amount_idx__chant_new",
  target: "events_amount_idx",
  definition: "CREATE INDEX events_amount_idx__chant_new ON ONLY app.events USING btree (amount__chant_new)",
  validated: true,
  partitioned: true,
};

interface Node {
  oid: string;
  name: string;
  parent?: string;
  leaf: boolean;
  level: number;
}

/** A fake server for one partitioned index: the tree it has, and what of the working index exists already. */
function server(tree: Node[], have: { root?: boolean; attached?: string[]; standalone?: Record<string, { valid: boolean; comment: string | null }> } = {}) {
  const statements: string[] = [];
  const indexOid = (name: string) => `i-${name}`;
  const query = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    if (/^(CREATE|ALTER INDEX|COMMENT|DROP)/.test(sql)) statements.push(sql);
    if (sql.includes("pg_partition_tree")) return tree.map((n) => ({ oid: n.oid, schema: "app", name: n.name, parent: n.parent ?? null, leaf: n.leaf, kind: n.leaf ? "r" : "p", level: n.level }));
    if (sql.includes("AS oid") && sql.includes("to_regclass")) {
      const ident = String(params[0]);
      if (ident === "app.events_amount_idx__chant_new") return [{ oid: have.root ? "root" : null }];
      return [{ oid: null }];
    }
    if (sql.includes("FROM pg_catalog.pg_inherits h")) {
      const parent = String(params[0]);
      const partition = String(params[1]);
      const hit = tree.find((n) => n.oid === partition);
      if (parent === "root" && hit && have.attached?.includes(hit.name)) return [{ oid: indexOid(hit.name), schema: "app", name: `${hit.name}_auto_idx` }];
      return [];
    }
    if (sql.includes("indisvalid AS valid")) {
      const ident = String(params[0]);
      const name = /\.(.+)$/.exec(ident)![1]!;
      const s = have.standalone?.[name];
      return s ? [{ valid: s.valid, comment: s.comment }] : [];
    }
    return [];
  };
  const run = { client: { query } as unknown as PostgresClient, target: { defaultSchema: "app" }, lockTimeoutMs: 1000, statementTimeoutMs: 1000, log: () => undefined } as unknown as MigrationRun;
  return { run, statements: () => statements };
}

const TREE: Node[] = [
  { oid: "100", name: "events", leaf: false, level: 0 },
  { oid: "101", name: "events_2025", parent: "100", leaf: true, level: 1 },
  { oid: "102", name: "events_2026", parent: "100", leaf: true, level: 1 },
];

describe("carrying a partitioned index over", () => {
  test("ON ONLY first, each partition's index built CONCURRENTLY, then each attached", async () => {
    const s = server(TREE);
    expect(await carryPartitionedIndex(s.run, names, c, "the comment", undefined)).toBe(true);
    const sql = s.statements();
    expect(sql[0]).toBe(c.definition);
    expect(sql[1]).toMatch(/^COMMENT ON INDEX app\.events_amount_idx__chant_new IS /);
    expect(sql.filter((x) => x.startsWith("CREATE"))).toEqual([
      c.definition,
      "CREATE INDEX CONCURRENTLY events_2025_events_amount_idx__chant_new ON app.events_2025 USING btree (amount__chant_new)",
      "CREATE INDEX CONCURRENTLY events_2026_events_amount_idx__chant_new ON app.events_2026 USING btree (amount__chant_new)",
    ]);
    const attaches = sql.filter((x) => x.startsWith("ALTER INDEX"));
    expect(attaches).toEqual([
      "ALTER INDEX app.events_amount_idx__chant_new ATTACH PARTITION app.events_2025_events_amount_idx__chant_new",
      "ALTER INDEX app.events_amount_idx__chant_new ATTACH PARTITION app.events_2026_events_amount_idx__chant_new",
    ]);
    // Every attach comes after every build, and each partition's index carries the migration's trailer.
    expect(sql.lastIndexOf(sql.filter((x) => x.startsWith("CREATE")).at(-1)!)).toBeLessThan(sql.indexOf(attaches[0]!));
    expect(sql.filter((x) => x.startsWith("COMMENT ON INDEX app.events_2025_")).join()).toContain("migration=app.events.amount role=carry");
  });

  test("a run after a crash keeps the partitions already attached, drops an invalid build and goes on", async () => {
    const s = server(TREE, { root: true, attached: ["events_2025"], standalone: { events_2026_events_amount_idx__chant_new: { valid: false, comment: null } } });
    const state = { present: true, ready: false, marked: true };
    await carryPartitionedIndex(s.run, names, c, "the comment", state);
    const sql = s.statements();
    expect(sql.some((x) => x.includes("events_2025"))).toBe(false);
    expect(sql.filter((x) => !x.startsWith("COMMENT"))).toEqual([
      "DROP INDEX CONCURRENTLY IF EXISTS app.events_2026_events_amount_idx__chant_new",
      "CREATE INDEX CONCURRENTLY events_2026_events_amount_idx__chant_new ON app.events_2026 USING btree (amount__chant_new)",
      "ALTER INDEX app.events_amount_idx__chant_new ATTACH PARTITION app.events_2026_events_amount_idx__chant_new",
    ]);
  });

  test("a valid partitioned index that is marked is left alone", async () => {
    const s = server(TREE, { root: true });
    expect(await carryPartitionedIndex(s.run, names, c, "the comment", { present: true, ready: true, marked: true })).toBe(false);
    expect(s.statements()).toEqual([]);
  });

  test("a partition that is partitioned further gets ON ONLY, and is attached after its own partitions", async () => {
    const tree: Node[] = [
      { oid: "100", name: "events", leaf: false, level: 0 },
      { oid: "101", name: "events_2025", parent: "100", leaf: false, level: 1 },
      { oid: "103", name: "events_2025_q1", parent: "101", leaf: true, level: 2 },
    ];
    const s = server(tree);
    await carryPartitionedIndex(s.run, names, c, "the comment", undefined);
    const sql = s.statements().filter((x) => !x.startsWith("COMMENT"));
    expect(sql).toEqual([
      c.definition,
      "CREATE INDEX events_2025_events_amount_idx__chant_new ON ONLY app.events_2025 USING btree (amount__chant_new)",
      "CREATE INDEX CONCURRENTLY events_2025_q1_events_amount_idx__chant_new ON app.events_2025_q1 USING btree (amount__chant_new)",
      "ALTER INDEX app.events_2025_events_amount_idx__chant_new ATTACH PARTITION app.events_2025_q1_events_amount_idx__chant_new",
      "ALTER INDEX app.events_amount_idx__chant_new ATTACH PARTITION app.events_2025_events_amount_idx__chant_new",
    ]);
  });
});

describe("finding a partitioned index on the column", () => {
  const find = async (tree: Array<{ name: string; kind: string }>, row: Record<string, unknown> = {}) => {
    const query = async (sql: string): Promise<Record<string, unknown>[]> => {
      if (sql.includes("pg_catalog.pg_depend d") && sql.includes("UNION")) return [{ kind: "class", objid: "9", objsubid: 0, what: "index", deptype: "n" }];
      if (sql.includes("AS has_exprs")) {
        return [{ oid: "9", name: "events_amount_idx", kind: "I", schema: "app", comment: null, def: DEF, valid: true, is_unique: false, replident: false, clustered: false, cols: ["amount"], has_exprs: false, ...row }];
      }
      if (sql.includes("pg_partition_tree")) return tree.map((t, i) => ({ oid: String(100 + i), schema: "app", name: t.name, parent: i === 0 ? null : "100", leaf: i > 0, kind: t.kind, level: i === 0 ? 0 : 1 }));
      return [];
    };
    return discoverDependents({
      client: { query } as unknown as PostgresClient,
      names: migrationNames("app", "events", "amount", "type", "amount"),
      oid: "100",
      attnum: 3,
      objects: [],
      declared: { props: {}, canonical: { schema: "app", name: "events" } } as never,
      defaultSchema: "app",
      partitioned: true,
    });
  };

  test("it is carried over, as a partitioned index", async () => {
    const d = await find([{ name: "events", kind: "p" }, { name: "events_2025", kind: "r" }]);
    expect(d.refused).toEqual([]);
    expect(d.carried).toHaveLength(1);
    expect(d.carried[0]).toMatchObject({
      kind: "index",
      partitioned: true,
      working: "events_amount_idx__chant_new",
      definition: "CREATE INDEX events_amount_idx__chant_new ON ONLY app.events USING btree (amount__chant_new)",
    });
  });

  test("a foreign table among the partitions refuses it, naming the partition", async () => {
    const d = await find([{ name: "events", kind: "p" }, { name: "events_remote", kind: "f" }]);
    expect(d.carried).toEqual([]);
    expect(d.refused).toEqual([expect.stringMatching(/partitioned index app\.events_amount_idx: app\.events_remote is a foreign table/)]);
  });

  test("an INVALID one (an ON ONLY never finished) still refuses", async () => {
    const d = await find([{ name: "events", kind: "p" }], { valid: false });
    expect(d.refused).toEqual([expect.stringMatching(/index app\.events_amount_idx is INVALID/)]);
  });
});
