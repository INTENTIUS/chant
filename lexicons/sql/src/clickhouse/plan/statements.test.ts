import { describe, expect, test } from "vitest";
import { classifyClickHouseStatements } from "./statements";

const one = (sql: string) => classifyClickHouseStatements([sql])[0]!;
const rules = (sql: string) => one(sql).changes.map((c) => c.rule);

describe("ClickHouse statements", () => {
  test("a sort-key change is SQLCH220, a rebuild", () => {
    const v = one("ALTER TABLE events MODIFY ORDER BY (user_id, ts)");
    expect(v.outcome).toBe("classified");
    expect(v.changes).toMatchObject([{ rule: "SQLCH220", class: "rebuild", label: "REBUILD" }]);
  });

  test("appending the column the same ALTER adds is undecided between SQLCH216 and SQLCH220", () => {
    const v = one("ALTER TABLE events ADD COLUMN region String, MODIFY ORDER BY (user_id, region)");
    expect(v.outcome).toBe("undecided");
    expect(v.candidates!.map((c) => c.rule)).toEqual(["SQLCH216", "SQLCH220"]);
    expect(v.changes.map((c) => c.rule)).toEqual(["SQLCH201"]);
  });

  test("a table created in the same file decides the key questions", () => {
    const create = "CREATE TABLE events (user_id UInt64, ts DateTime, region String) ENGINE = MergeTree ORDER BY (user_id, ts)";
    const [, appended] = classifyClickHouseStatements([create, "ALTER TABLE events ADD COLUMN extra String, MODIFY ORDER BY (user_id, ts, extra)"]);
    expect(appended!.outcome).toBe("classified");
    expect(appended!.changes.map((c) => c.rule)).toEqual(["SQLCH201", "SQLCH216"]);
    expect(classifyClickHouseStatements([create, "ALTER TABLE events MODIFY COLUMN user_id UInt32"])[1]!.changes[0]!.rule).toBe("SQLCH211");
    expect(classifyClickHouseStatements([create, "ALTER TABLE events MODIFY COLUMN region LowCardinality(String)"])[1]!.changes[0]!.rule).toBe("SQLCH210");
  });

  test("a column type change on a table the file does not create is undecided", () => {
    const v = one("ALTER TABLE events MODIFY COLUMN user_id UInt32");
    expect(v.outcome).toBe("undecided");
    expect(v.candidates!.map((c) => c.rule)).toEqual(["SQLCH210", "SQLCH211"]);
    expect(one("ALTER TABLE events DROP COLUMN a").candidates!.map((c) => c.rule)).toEqual(["SQLCH202", "SQLCH213"]);
    expect(one("ALTER TABLE events RENAME COLUMN a TO b").candidates!.map((c) => c.rule)).toEqual(["SQLCH212", "SQLCH213"]);
  });

  test("metadata and rewrite changes", () => {
    expect(rules("ALTER TABLE events ADD COLUMN IF NOT EXISTS a String DEFAULT ''")).toEqual(["SQLCH201"]);
    expect(rules("ALTER TABLE events ON CLUSTER c MODIFY COLUMN a DEFAULT 'x'")).toEqual(["SQLCH207"]);
    expect(rules("ALTER TABLE events MODIFY TTL ts + INTERVAL 30 DAY")).toEqual(["SQLCH205"]);
    expect(rules("ALTER TABLE events ADD INDEX i a TYPE minmax GRANULARITY 1")).toEqual(["SQLCH204"]);
    expect(rules("ALTER TABLE events MODIFY SETTING ttl_only_drop_parts = 1")).toEqual(["SQLCH206"]);
    expect(rules("ALTER TABLE events MODIFY COMMENT 'x'")).toEqual(["SQLCH203"]);
  });

  test("create, drop, rename", () => {
    expect(rules("CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a")).toEqual(["SQLCH200"]);
    expect(rules("CREATE MATERIALIZED VIEW mv TO t AS SELECT a FROM s")).toEqual(["SQLCH200"]);
    expect(rules("CREATE USER u IDENTIFIED WITH no_password")).toEqual(["SQLCH200"]);
    expect(one("DROP TABLE t").changes[0]).toMatchObject({ rule: "SQLCH250", destructive: true });
    expect(rules("RENAME TABLE a TO b")).toEqual(["SQLCH230"]);
    expect(rules("GRANT SELECT ON db.* TO r")).toEqual(["SQLCH273"]);
  });

  test("mutations are data; partition operations have no rule", () => {
    expect(one("ALTER TABLE t UPDATE a = 1 WHERE b = 2").outcome).toBe("data");
    expect(one("ALTER TABLE t DROP PARTITION 2024").outcome).toBe("unclassified");
    expect(one("INSERT INTO t VALUES (1)").outcome).toBe("data");
  });
});
