import { describe, expect, test } from "vitest";
import { classifyPgStatements } from "./statements";

const one = (sql: string) => classifyPgStatements([sql])[0]!;
const rules = (sql: string) => one(sql).changes.map((c) => c.rule);

describe("Postgres statements", () => {
  test("CREATE INDEX without CONCURRENTLY is SQLPG241 with its SHARE lock", () => {
    const v = one("CREATE INDEX orders_status_idx ON app.orders (status)");
    expect(v.outcome).toBe("classified");
    expect(v.changes).toMatchObject([{ rule: "SQLPG241", class: "concurrently", lock: "SHARE" }]);
  });

  test("CREATE INDEX CONCURRENTLY is SQLPG240", () => {
    expect(one("CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)").changes).toMatchObject([{ rule: "SQLPG240", lock: "SHARE UPDATE EXCLUSIVE" }]);
  });

  test("an index on a table the file creates needs no CONCURRENTLY", () => {
    const [t, i] = classifyPgStatements(["CREATE TABLE t (id bigint PRIMARY KEY, a int)", "CREATE INDEX i ON t (a)"]);
    expect(t!.changes[0]!.rule).toBe("SQLPG200");
    expect(i!.changes[0]!.rule).toBe("SQLPG200");
  });

  test("ADD COLUMN splits by what the table must compute", () => {
    expect(rules("ALTER TABLE t ADD COLUMN a int")).toEqual(["SQLPG201"]);
    expect(rules("ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0")).toEqual(["SQLPG201"]);
    expect(rules("ALTER TABLE t ADD COLUMN a int NOT NULL")).toEqual(["SQLPG203"]);
    expect(rules("ALTER TABLE t ADD COLUMN a uuid DEFAULT gen_random_uuid()")).toEqual(["SQLPG202"]);
    expect(rules("ALTER TABLE t ADD COLUMN a int GENERATED ALWAYS AS (b + 1) STORED")).toEqual(["SQLPG202"]);
  });

  test("a column type change is undecided between SQLPG206 and SQLPG207", () => {
    const v = one("ALTER TABLE t ALTER COLUMN a TYPE bigint");
    expect(v.outcome).toBe("undecided");
    expect(v.candidates!.map((c) => c.rule)).toEqual(["SQLPG206", "SQLPG207"]);
    expect(one("ALTER TABLE t ALTER COLUMN a TYPE int USING a::int").candidates!.map((c) => c.rule)).toEqual(["SQLPG206", "SQLPG207", "SQLPG208"]);
  });

  test("several actions in one ALTER TABLE are each classified", () => {
    expect(rules("ALTER TABLE t ADD COLUMN a int, DROP COLUMN b, ALTER COLUMN c SET NOT NULL")).toEqual(["SQLPG201", "SQLPG204", "SQLPG210"]);
    expect(one("ALTER TABLE t DROP COLUMN b").changes[0]!.destructive).toBe(true);
  });

  test("constraints", () => {
    expect(rules("ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u (id) NOT VALID")).toEqual(["SQLPG217"]);
    expect(rules("ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES u (id)")).toEqual(["SQLPG219"]);
    expect(rules("ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0)")).toEqual(["SQLPG218"]);
    expect(rules("ALTER TABLE t ADD PRIMARY KEY (id)")).toEqual(["SQLPG221"]);
    expect(rules("ALTER TABLE t VALIDATE CONSTRAINT fk")).toEqual(["SQLPG220"]);
    expect(rules("ALTER TABLE t DROP CONSTRAINT fk")).toEqual(["SQLPG223"]);
  });

  test("renames", () => {
    expect(rules("ALTER TABLE t RENAME COLUMN a TO b")).toEqual(["SQLPG205"]);
    expect(rules("ALTER TABLE t RENAME TO u")).toEqual(["SQLPG228"]);
    expect(rules("ALTER INDEX i RENAME TO j")).toEqual(["SQLPG229"]);
  });

  test("DROP, GRANT, COMMENT and row security go through the parser or the verb", () => {
    expect(rules("DROP INDEX CONCURRENTLY i")).toEqual(["SQLPG242"]);
    expect(rules("DROP TABLE t")).toEqual(["SQLPG270"]);
    expect(rules("GRANT SELECT ON TABLE t TO reader")).toEqual(["SQLPG296"]);
    expect(rules("REVOKE SELECT ON TABLE t FROM reader")).toEqual(["SQLPG297"]);
    expect(rules("COMMENT ON TABLE t IS 'x'")).toEqual(["SQLPG216"]);
    expect(rules("ALTER TABLE t ENABLE ROW LEVEL SECURITY")).toEqual(["SQLPG293"]);
  });

  test("functions and views", () => {
    expect(rules("CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ select 1; $$")).toEqual(["SQLPG280"]);
    expect(one("CREATE OR REPLACE VIEW v AS SELECT 1 AS a").candidates!.map((c) => c.rule)).toEqual(["SQLPG250", "SQLPG251"]);
    expect(rules("CREATE VIEW v AS SELECT 1 AS a")).toEqual(["SQLPG200"]);
  });

  test("data statements and unknown ALTERs", () => {
    expect(one("UPDATE t SET a = 1").outcome).toBe("data");
    expect(one("ALTER TABLE t OWNER TO app").outcome).toBe("unclassified");
  });
});
