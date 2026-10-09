import { describe, expect, test } from "vitest";
import { canonicalObject } from "./plan/normalize";
import type { Change } from "./plan/diff";
import { alterSteps, createStatement, dropStatement, type DeclaredObject } from "./apply/statements";
import { CLICKHOUSE_ENTITY_TYPES, type ClickHouseEntityType } from "./entities";
import { parseTopology, renderEngine, renderStatement, renderSteps, type Topology } from "./topology";

const SINGLE: Topology = { kind: "single" };
const CLUSTER: Topology = { kind: "cluster", cluster: "main" };
const REPLICATED: Topology = { kind: "replicated" };
const CLOUD: Topology = { kind: "cloud" };

const EVENTS = `CREATE TABLE analytics.events (
  id UInt64,
  ts DateTime,
  kind LowCardinality(String)
)
ENGINE = ReplacingMergeTree(ts)
ORDER BY id
COMMENT 'events'`;

describe("CREATE TABLE per topology", () => {
  test("a single node takes the declaration as written", () => {
    expect(renderStatement(EVENTS, SINGLE)).toBe(EVENTS);
  });

  test("a cluster adds ON CLUSTER after the name and replicates the engine with its Keeper path and replica", () => {
    expect(renderStatement(EVENTS, CLUSTER)).toBe(`CREATE TABLE analytics.events ON CLUSTER \`main\` (
  id UInt64,
  ts DateTime,
  kind LowCardinality(String)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}', ts)
ORDER BY id
COMMENT 'events'`);
  });

  test("a cluster's Keeper path and replica name can be set, and a macro cluster name is a string literal", () => {
    const t: Topology = { kind: "cluster", cluster: "{cluster}", replicaPath: "/ch/{shard}/{database}/{table}", replicaName: "{replica}" };
    expect(renderStatement("CREATE TABLE db.t (id UInt64) ENGINE = MergeTree ORDER BY id", t)).toBe(
      "CREATE TABLE db.t ON CLUSTER '{cluster}' (id UInt64) ENGINE = ReplicatedMergeTree('/ch/{shard}/{database}/{table}', '{replica}') ORDER BY id",
    );
  });

  test("a Replicated database gets the Replicated family with no path arguments and no ON CLUSTER", () => {
    expect(renderStatement(EVENTS, REPLICATED)).toBe(EVENTS.replace("ReplacingMergeTree(ts)", "ReplicatedReplacingMergeTree(ts)"));
  });

  test("Cloud takes the plain family, which it turns into SharedMergeTree itself", () => {
    expect(renderStatement(EVENTS, CLOUD)).toBe(EVENTS);
  });

  describe("a declaration written for a cluster", () => {
    const declared =
      "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER prod (id UInt64, v UInt32) ENGINE = ReplicatedSummingMergeTree('/p/{shard}/t', '{replica}', (v)) ORDER BY id";

    test("keeps its own path on a cluster, under the topology's cluster name", () => {
      expect(renderStatement(declared, CLUSTER)).toBe(
        "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER `main` (id UInt64, v UInt32) ENGINE = ReplicatedSummingMergeTree('/p/{shard}/t', '{replica}', (v)) ORDER BY id",
      );
    });

    test("loses ON CLUSTER and replication on a single node", () => {
      expect(renderStatement(declared, SINGLE)).toBe("CREATE TABLE IF NOT EXISTS db.t (id UInt64, v UInt32) ENGINE = SummingMergeTree((v)) ORDER BY id");
    });

    test("loses ON CLUSTER and the path arguments in a Replicated database", () => {
      expect(renderStatement(declared, REPLICATED)).toBe(
        "CREATE TABLE IF NOT EXISTS db.t (id UInt64, v UInt32) ENGINE = ReplicatedSummingMergeTree((v)) ORDER BY id",
      );
    });

    test("loses ON CLUSTER and the path arguments on Cloud", () => {
      expect(renderStatement(declared, CLOUD)).toBe("CREATE TABLE IF NOT EXISTS db.t (id UInt64, v UInt32) ENGINE = SummingMergeTree((v)) ORDER BY id");
    });
  });

  test("ON CLUSTER goes after a UUID clause", () => {
    expect(renderStatement("CREATE TABLE db.t UUID '0e9a7e46-0a7d-4c3a-8d47-3c1f2f9b0a11' (id UInt64) ENGINE = MergeTree ORDER BY id", CLUSTER)).toBe(
      "CREATE TABLE db.t UUID '0e9a7e46-0a7d-4c3a-8d47-3c1f2f9b0a11' ON CLUSTER `main` (id UInt64) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') ORDER BY id",
    );
  });

  test("an engine outside the MergeTree family is left alone; only ON CLUSTER changes", () => {
    const log = "CREATE TABLE db.l (id UInt64) ENGINE = Log";
    expect(renderStatement(log, REPLICATED)).toBe(log);
    expect(renderStatement(log, CLUSTER)).toBe("CREATE TABLE db.l ON CLUSTER `main` (id UInt64) ENGINE = Log");
  });

  test("comments and spacing in the declaration survive", () => {
    const sql = "CREATE TABLE db.t ( -- the key\n  id UInt64 /* id */\n)\nENGINE = MergeTree() -- engine\nORDER BY id";
    expect(renderStatement(sql, REPLICATED)).toBe(sql.replace("MergeTree()", "ReplicatedMergeTree()"));
  });
});

describe("views per topology", () => {
  const mv = "CREATE MATERIALIZED VIEW db.counts ENGINE = SummingMergeTree ORDER BY kind AS SELECT kind, count() AS n FROM db.events GROUP BY kind";
  const to = "CREATE MATERIALIZED VIEW db.feed TO db.events AS SELECT * FROM db.raw";

  test("a materialized view's inner engine is replicated like a table's", () => {
    expect(renderStatement(mv, CLUSTER)).toBe(
      "CREATE MATERIALIZED VIEW db.counts ON CLUSTER `main` ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}') ORDER BY kind AS SELECT kind, count() AS n FROM db.events GROUP BY kind",
    );
    expect(renderStatement(mv, REPLICATED)).toBe(mv.replace("SummingMergeTree", "ReplicatedSummingMergeTree"));
    expect(renderStatement(mv, SINGLE)).toBe(mv);
    expect(renderStatement(mv, CLOUD)).toBe(mv);
  });

  test("a view writing TO a table only gains ON CLUSTER", () => {
    expect(renderStatement(to, CLUSTER)).toBe("CREATE MATERIALIZED VIEW db.feed ON CLUSTER `main` TO db.events AS SELECT * FROM db.raw");
    for (const t of [SINGLE, REPLICATED, CLOUD]) expect(renderStatement(to, t)).toBe(to);
  });

  test("a SELECT inside a view is not mistaken for the view's own clauses", () => {
    const v = "CREATE OR REPLACE VIEW db.v AS SELECT * FROM db.t ON CLUSTER_X JOIN db.u USING id";
    expect(renderStatement(v, SINGLE)).toBe(v);
  });
});

describe("CREATE DATABASE per topology", () => {
  const db = "CREATE DATABASE IF NOT EXISTS analytics COMMENT 'the warehouse'";

  test("single node and Cloud take it as written", () => {
    expect(renderStatement(db, SINGLE)).toBe(db);
    expect(renderStatement(db, CLOUD)).toBe(db);
  });

  test("a cluster adds ON CLUSTER", () => {
    expect(renderStatement(db, CLUSTER)).toBe("CREATE DATABASE IF NOT EXISTS analytics ON CLUSTER `main` COMMENT 'the warehouse'");
  });

  test("the replicated topology makes it a Replicated database, on its cluster when it names one", () => {
    expect(renderStatement(db, REPLICATED)).toBe(
      "CREATE DATABASE IF NOT EXISTS analytics ENGINE = Replicated('/clickhouse/databases/analytics', '{shard}', '{replica}') COMMENT 'the warehouse'",
    );
    expect(renderStatement(db, { kind: "replicated", cluster: "all" })).toBe(
      "CREATE DATABASE IF NOT EXISTS analytics ON CLUSTER `all` ENGINE = Replicated('/clickhouse/databases/analytics', '{shard}', '{replica}') COMMENT 'the warehouse'",
    );
  });

  test("a declared Atomic engine becomes Replicated in the replicated topology, and a declared Replicated one keeps its arguments", () => {
    expect(renderStatement("CREATE DATABASE `a` ENGINE = Atomic", REPLICATED)).toBe("CREATE DATABASE `a` ENGINE = Replicated('/clickhouse/databases/a', '{shard}', '{replica}')");
    const r = "CREATE DATABASE a ENGINE = Replicated('/x/a', 's', 'r')";
    expect(renderStatement(r, REPLICATED)).toBe(r);
  });

  test("a declared Replicated engine is dropped everywhere else", () => {
    const r = "CREATE DATABASE a ENGINE = Replicated('/x/a', '{shard}', '{replica}') COMMENT 'c'";
    expect(renderStatement(r, SINGLE)).toBe("CREATE DATABASE a COMMENT 'c'");
    expect(renderStatement(r, CLOUD)).toBe("CREATE DATABASE a COMMENT 'c'");
    expect(renderStatement(r, CLUSTER)).toBe("CREATE DATABASE a ON CLUSTER `main` COMMENT 'c'");
  });
});

describe("the other DDL per topology", () => {
  const cases: Array<[string, string]> = [
    ["ALTER TABLE `db`.`t` ADD COLUMN `x` UInt8 AFTER `id`", "ALTER TABLE `db`.`t` ON CLUSTER `main` ADD COLUMN `x` UInt8 AFTER `id`"],
    ["ALTER TABLE `db`.`t` MODIFY COMMENT 'c'", "ALTER TABLE `db`.`t` ON CLUSTER `main` MODIFY COMMENT 'c'"],
    ["DROP TABLE `db`.`t` SYNC", "DROP TABLE `db`.`t` ON CLUSTER `main` SYNC"],
    ["DROP VIEW IF EXISTS `db`.`v` SYNC", "DROP VIEW IF EXISTS `db`.`v` ON CLUSTER `main` SYNC"],
    ["TRUNCATE TABLE db.t", "TRUNCATE TABLE db.t ON CLUSTER `main`"],
    ["DETACH VIEW db.v", "DETACH VIEW db.v ON CLUSTER `main`"],
    ["ATTACH TABLE db.v", "ATTACH TABLE db.v ON CLUSTER `main`"],
    ["OPTIMIZE TABLE db.t FINAL", "OPTIMIZE TABLE db.t ON CLUSTER `main` FINAL"],
    ["RENAME TABLE `db`.`a` TO `db`.`b`", "RENAME TABLE `db`.`a` TO `db`.`b` ON CLUSTER `main`"],
    ["RENAME TABLE db.a TO db.b, db.c TO db.d;", "RENAME TABLE db.a TO db.b, db.c TO db.d ON CLUSTER `main`;"],
    ["EXCHANGE TABLES db.a AND db.b", "EXCHANGE TABLES db.a AND db.b ON CLUSTER `main`"],
    ["EXCHANGE TABLES db.a AND db.b SETTINGS x = 1", "EXCHANGE TABLES db.a AND db.b ON CLUSTER `main` SETTINGS x = 1"],
  ];

  test.each(cases)("%s gains ON CLUSTER on a cluster", (sql, onCluster) => {
    expect(renderStatement(sql, CLUSTER)).toBe(onCluster);
  });

  test.each(cases)("%s is written without ON CLUSTER on every other topology", (sql, onCluster) => {
    for (const t of [SINGLE, REPLICATED, CLOUD]) {
      expect(renderStatement(sql, t)).toBe(sql);
      expect(renderStatement(onCluster, t)).toBe(sql);
    }
  });

  test("ALTER, RENAME and DROP DATABASE take ON CLUSTER on a cluster", () => {
    expect(renderStatement("ALTER DATABASE `db` MODIFY COMMENT 'c'", CLUSTER)).toBe("ALTER DATABASE `db` ON CLUSTER `main` MODIFY COMMENT 'c'");
    expect(renderStatement("RENAME DATABASE `a` TO `b`", CLUSTER)).toBe("RENAME DATABASE `a` TO `b` ON CLUSTER `main`");
    expect(renderStatement("DROP DATABASE `db` SYNC", CLUSTER)).toBe("DROP DATABASE `db` ON CLUSTER `main` SYNC");
  });

  test("in the replicated topology only dropping a database carries its cluster", () => {
    const t: Topology = { kind: "replicated", cluster: "all" };
    expect(renderStatement("DROP DATABASE `db` SYNC", t)).toBe("DROP DATABASE `db` ON CLUSTER `all` SYNC");
    expect(renderStatement("ALTER DATABASE `db` MODIFY COMMENT 'c'", t)).toBe("ALTER DATABASE `db` MODIFY COMMENT 'c'");
    expect(renderStatement("ALTER TABLE db.t DROP COLUMN x", t)).toBe("ALTER TABLE db.t DROP COLUMN x");
  });

  test("a declared ON CLUSTER is replaced with the topology's cluster", () => {
    expect(renderStatement("ALTER TABLE db.t ON CLUSTER old DROP COLUMN x", CLUSTER)).toBe("ALTER TABLE db.t ON CLUSTER `main` DROP COLUMN x");
  });

  test("KILL gains ON CLUSTER on a cluster, and is kept as written elsewhere", () => {
    expect(renderStatement("KILL QUERY WHERE query_id = 'q' SYNC", CLUSTER)).toBe("KILL QUERY ON CLUSTER `main` WHERE query_id = 'q' SYNC");
    const replicatedKill = "KILL QUERY ON CLUSTER 'db' WHERE query_id = 'q' SYNC";
    expect(renderStatement(replicatedKill, REPLICATED)).toBe(replicatedKill);
  });

  test("statements that are not DDL come back unchanged", () => {
    for (const sql of ["INSERT INTO db.t SELECT * FROM db.s", "SELECT 1", "SYSTEM SYNC REPLICA db.t LIGHTWEIGHT"]) {
      for (const t of [SINGLE, CLUSTER, REPLICATED, CLOUD]) expect(renderStatement(sql, t)).toBe(sql);
    }
  });

  test("a CREATE the parser does not take still gains ON CLUSTER", () => {
    expect(renderStatement("CREATE TABLE db.t2 AS db.t", CLUSTER)).toBe("CREATE TABLE db.t2 ON CLUSTER `main` AS db.t");
    expect(renderStatement("CREATE TABLE db.t2 ON CLUSTER x AS db.t", SINGLE)).toBe("CREATE TABLE db.t2 AS db.t");
  });
});

describe("renderEngine", () => {
  test("splits a Replicated engine's path and replica from the family's own arguments", () => {
    expect(renderEngine({ name: "ReplicatedReplacingMergeTree", args: ["'/p'", "'{replica}'", "ver"] }, SINGLE)).toEqual({ name: "ReplacingMergeTree", args: ["ver"] });
    expect(renderEngine({ name: "ReplicatedReplacingMergeTree", args: ["ver"] }, SINGLE)).toEqual({ name: "ReplacingMergeTree", args: ["ver"] });
  });

  test("leaves a Shared engine and the non-MergeTree engines alone", () => {
    for (const name of ["SharedMergeTree", "Distributed", "Memory"]) {
      const e = { name, args: ["a"] };
      for (const t of [SINGLE, CLUSTER, REPLICATED, CLOUD]) expect(renderEngine(e, t)).toBe(e);
    }
  });

  test("keeps an engine written without parentheses without them where it can", () => {
    expect(renderEngine({ name: "MergeTree" }, REPLICATED)).toEqual({ name: "ReplicatedMergeTree" });
    expect(renderEngine({ name: "ReplicatedMergeTree" }, CLOUD)).toEqual({ name: "MergeTree" });
  });
});

describe("parseTopology", () => {
  test("reads each topology's string form", () => {
    expect(parseTopology("single")).toEqual(SINGLE);
    expect(parseTopology("cluster:main")).toEqual(CLUSTER);
    expect(parseTopology("cluster:{cluster}")).toEqual({ kind: "cluster", cluster: "{cluster}" });
    expect(parseTopology("replicated")).toEqual(REPLICATED);
    expect(parseTopology("replicated:all")).toEqual({ kind: "replicated", cluster: "all" });
    expect(parseTopology("cloud")).toEqual(CLOUD);
  });

  test("refuses a cluster without a name, and anything unknown", () => {
    expect(() => parseTopology("cluster")).toThrow(/needs the cluster's name/);
    expect(() => parseTopology("single:x")).toThrow(/takes no argument/);
    expect(() => parseTopology("sharded")).toThrow(/unknown topology/);
  });
});

describe("the applier's own statements", () => {
  const declared = (type: ClickHouseEntityType, exportName: string, ddl: string): DeclaredObject => {
    const canonical = canonicalObject(ddl);
    return { exportName, type, key: canonical.database ? `${canonical.database}.${canonical.name}` : canonical.name, ddl, canonical, dependsOn: [] };
  };
  const table = declared(CLICKHOUSE_ENTITY_TYPES.table, "events", "CREATE TABLE db.events (id UInt64, x UInt8) ENGINE = MergeTree ORDER BY id");
  const marker = { stack: "s", env: "e" };
  const added: Change = { object: "events", field: "columns.x", after: "UInt8", rule: "SQLCH201", class: "metadata" };

  test("render for a cluster, with the marker comment and steps kept", () => {
    const create = renderStatement(createStatement(table, marker), CLUSTER);
    expect(create).toMatch(/^CREATE TABLE db\.events ON CLUSTER `main` \(id UInt64, x UInt8\) ENGINE = ReplicatedMergeTree\('\/clickhouse\/tables\/\{uuid\}\/\{shard\}', '\{replica\}'\) ORDER BY id COMMENT '/);
    const steps = renderSteps(alterSteps(table, [added]), CLUSTER);
    expect(steps).toEqual([{ sql: "ALTER TABLE `db`.`events` ON CLUSTER `main` ADD COLUMN x UInt8 AFTER `id`", rewrite: false }]);
    expect(renderStatement(dropStatement(CLICKHOUSE_ENTITY_TYPES.table, "db", "events"), CLUSTER)).toBe("DROP TABLE `db`.`events` ON CLUSTER `main` SYNC");
  });

  test("come back unchanged for a single node", () => {
    const create = createStatement(table, marker);
    expect(renderStatement(create, SINGLE)).toBe(create);
    const steps = alterSteps(table, [added]);
    expect(renderSteps(steps, SINGLE)).toEqual(steps);
  });
});
