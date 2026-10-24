import { describe, expect, test } from "vitest";
import { MERGE_TREE_SETTINGS, TABLE_ENGINES, TYPE_FAMILIES } from "../generated/clickhouse";
import {
  CDC_DELETED_COLUMN,
  CDC_VERSION_COLUMN,
  REVIEW_RULES,
  constraintReview,
  engineReview,
  findingText,
  lowCardinalityReview,
  nullableReview,
  sortKeyReview,
} from "./review-catalog";

const types = { id: "Int64", ts: "DateTime64(3)", tenant: "String", maybe: "Nullable(Int32)" };

describe("sortKeyReview", () => {
  test("a columnstore ORDER outranks a clustering key, a primary key and a unique key", () => {
    const r = sortKeyReview({
      object: "t",
      columnTypes: types,
      candidates: [
        { kind: "unique-key", columns: ["tenant"], source: "UNIQUE u" },
        { kind: "primary-key", columns: ["id"], source: "PRIMARY KEY pk" },
        { kind: "clustering-key", columns: ["ts"], source: "CLUSTERED INDEX cx" },
        { kind: "explicit-order", columns: ["tenant", "ts"], source: "COLUMNSTORE ORDER" },
      ],
    });
    expect(r.orderBy).toEqual(["tenant", "ts"]);
    expect(r.finding.ruleId).toBe("SQLRV001");
    expect(r.finding.evidence[0]).toBe("COLUMNSTORE ORDER (tenant, ts)");
    // The three it passed over are named in the order of their rank.
    expect(r.finding.evidence.slice(1)).toEqual(["passed over: CLUSTERED INDEX cx (ts)", "passed over: PRIMARY KEY pk (id)", "passed over: UNIQUE u (tenant)"]);
  });

  test("with no candidate the key is tuple() and the finding says why", () => {
    const r = sortKeyReview({ object: "t", columnTypes: types, candidates: [] });
    expect(r.orderBy).toEqual([]);
    expect(r.finding.message).toContain("tuple()");
    expect(r.finding.evidence).toEqual(["no clustering key, primary key or unique key in the source"]);
  });

  test("a Nullable key column sets allow_nullable_key, a setting the pinned server has", () => {
    const r = sortKeyReview({ object: "t", columnTypes: types, candidates: [{ kind: "primary-key", columns: ["maybe"], source: "PRIMARY KEY pk" }] });
    expect(r.settings).toEqual({ allow_nullable_key: "1" });
    expect(Object.keys(MERGE_TREE_SETTINGS)).toContain("allow_nullable_key");
    expect(r.finding.evidence.join(" ")).toContain("allow_nullable_key = 1");
  });

  test("a descending column is said to be ascending here", () => {
    const r = sortKeyReview({ object: "t", columnTypes: types, candidates: [{ kind: "clustering-key", columns: ["ts"], descending: ["ts"], source: "CLUSTERED INDEX cx" }] });
    expect(r.finding.evidence).toContain("descending in the source, ascending here: ts");
  });
});

describe("engineReview", () => {
  test("an append table is MergeTree and adds no column", () => {
    const r = engineReview({ object: "t", mode: "append", uniqueKey: ["id"] });
    expect(r.engine).toBe("MergeTree");
    expect(r.extraColumns).toEqual([]);
    expect(r.finding.evidence).toContain("the source enforces uniqueness on (id); MergeTree does not");
  });

  test("a CDC mirror is ReplacingMergeTree(_version, _deleted) with the two columns", () => {
    const r = engineReview({ object: "t", mode: "cdc", uniqueKey: ["id"] });
    expect(r.engine).toBe("ReplacingMergeTree(_version, _deleted)");
    expect(r.extraColumns).toEqual([CDC_VERSION_COLUMN, CDC_DELETED_COLUMN]);
  });

  test("the engines it writes exist in the pinned catalog and take the arguments it gives", () => {
    expect(Object.keys(TABLE_ENGINES)).toContain("MergeTree");
    const replacing = TABLE_ENGINES.ReplacingMergeTree;
    expect(replacing.args?.map((a) => a.name)).toEqual(["ver", "is_deleted"]);
    expect(replacing.mergeTree).toBe(true);
    expect(CDC_VERSION_COLUMN.type in TYPE_FAMILIES).toBe(true);
    expect(CDC_DELETED_COLUMN.type in TYPE_FAMILIES).toBe(true);
  });
});

describe("nullableReview", () => {
  test("a NOT NULL column keeps its type and raises nothing", () => {
    expect(nullableReview({ object: "t", column: "id", type: "Int64", sourceNullable: false })).toEqual({ type: "Int64" });
  });

  test("a nullable column with a default says the default could replace Nullable", () => {
    const r = nullableReview({ object: "t", column: "n", type: "Int32", sourceNullable: true, defaultExpr: "0" });
    expect(r.type).toBe("Nullable(Int32)");
    expect(r.finding?.evidence).toEqual(["n allows NULL in the source", "it has the default 0"]);
    expect(r.finding?.suggestion).toContain("Int32 DEFAULT 0");
  });

  test("a nullable column with no default says so", () => {
    const r = nullableReview({ object: "t", column: "n", type: "String", sourceNullable: true });
    expect(r.type).toBe("Nullable(String)");
    expect(r.finding?.evidence).toEqual(["n allows NULL in the source", "it has no default"]);
  });

  test("Nullable is a family of the pinned catalog", () => {
    expect("Nullable" in TYPE_FAMILIES && "LowCardinality" in TYPE_FAMILIES).toBe(true);
  });
});

describe("lowCardinalityReview", () => {
  const at = (column: string, type = "String", maxLength?: number) => lowCardinalityReview({ object: "t", column, type, ...(maxLength !== undefined ? { maxLength } : {}) });

  test("a String column named for a small set is a candidate and keeps its type", () => {
    for (const name of ["status", "order_status", "OrderStatus", "country_code", "currency"]) {
      const f = at(name);
      expect(f?.ruleId, name).toBe("SQLRV004");
      expect(f?.message).toContain("stays String");
    }
  });

  test("the declared length is evidence when it is short", () => {
    expect(at("status", "String", 20)?.evidence).toContain("the declared length is 20");
    expect(at("status", "String", 4000)?.evidence.join(" ")).not.toContain("declared length");
  });

  test("other names, other types and words that merely end the same way are not candidates", () => {
    expect(at("name")).toBeUndefined();
    expect(at("birthday")).toBeUndefined();
    expect(at("prostatus")).toBeUndefined();
    expect(at("status", "Int32")).toBeUndefined();
  });

  test("a Nullable(String) column is a candidate and the suggestion names the nested form", () => {
    expect(at("status", "Nullable(String)")?.suggestion).toContain("LowCardinality(Nullable(String))");
  });
});

describe("constraintReview", () => {
  test("a foreign key, a unique constraint and a check are comments and findings", () => {
    const r = constraintReview({
      object: "t",
      constraints: [
        { kind: "foreign-key", name: "fk", columns: ["a"], references: { table: "u", columns: ["id"] } },
        { kind: "unique", name: "uq", columns: ["b", "c"] },
        { kind: "check", name: "ck", expression: "([x] > 0\n AND [x] < 10)" },
      ],
    });
    expect(r.comments).toEqual(["-- FOREIGN KEY fk (a) REFERENCES u (id)", "-- UNIQUE uq (b, c)", "-- CHECK ck ([x] > 0 AND [x] < 10)"]);
    expect(r.findings.map((f) => f.ruleId)).toEqual(["SQLRV005", "SQLRV005", "SQLRV005"]);
    expect(r.findings[0]?.column).toBe("a");
    expect(r.findings[1]?.column).toBeUndefined();
    expect(r.comments.every((c) => !c.includes("\n"))).toBe(true);
  });
});

describe("the rules", () => {
  test("every rule has a unique id and a name", () => {
    const names = Object.values(REVIEW_RULES).map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [id, r] of Object.entries(REVIEW_RULES)) expect(r.id).toBe(id);
  });

  test("findingText leads with the object and column, then evidence and suggestion", () => {
    expect(findingText({ ruleId: "SQLRV003", severity: "warning", object: "t", column: "c", message: "m.", evidence: ["a", "b"], suggestion: "s." })).toBe("t.c: m. Evidence: a; b. Suggestion: s.");
  });
});
