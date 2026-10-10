/**
 * Dictionaries (#3682): the `dictionary` tag, the declaration and the
 * server's `SHOW CREATE` compared equal, every change but a comment
 * replacing the dictionary (SQLCH245), and the statements for each
 * topology. `live/dictionaries.e2e.test.ts` runs them against a server.
 */

import { describe, expect, test } from "vitest";
import { dictionary, table, CLICKHOUSE_ENTITY_TYPES } from "./entities";
import { canonicalObject, canonicalDictionaryClause, canonicalLifetime } from "./plan/normalize";
import { diffSchemas } from "./plan/diff";
import { CLASSIFIER_RULES } from "./plan/rules";
import { alterSteps, createStatement, dropStatement, planStatements, type DeclaredObject } from "./apply/statements";
import { renderStatement } from "./topology";
import { SqlTemplateError } from "../core/template";

const DECLARED = `CREATE DICTIONARY shop.rates_dict (
  code String,
  rate Float64 DEFAULT 1,
  label String DEFAULT '' EXPRESSION upper(code) INJECTIVE
)
PRIMARY KEY code
SOURCE(clickhouse(table 'rates' db 'shop' password 'secret'))
LAYOUT(complex_key_hashed())
LIFETIME(300)
COMMENT 'exchange rates'`;

// What clickhouse-server 26.8.15.10 prints for DECLARED.
const SHOWN = `CREATE DICTIONARY shop.rates_dict
(
    \`code\` String,
    \`rate\` Float64 DEFAULT 1,
    \`label\` String DEFAULT '' EXPRESSION upper(code) INJECTIVE
)
PRIMARY KEY code
SOURCE(CLICKHOUSE(TABLE 'rates' DB 'shop' PASSWORD '[HIDDEN]'))
LIFETIME(MIN 0 MAX 300)
LAYOUT(COMPLEX_KEY_HASHED())
COMMENT 'exchange rates'`;

const declared = (ddl: string, exportName = "ratesDict"): DeclaredObject => {
  const canonical = canonicalObject(ddl);
  return { exportName, type: CLICKHOUSE_ENTITY_TYPES.dictionary, key: `${canonical.database}.${canonical.name}`, ddl, canonical, dependsOn: [] };
};

describe("the dictionary tag", () => {
  test("parses attributes, key, source, layout, lifetime and comment into props", () => {
    const d = dictionary([DECLARED] as unknown as TemplateStringsArray);
    expect(d.entityType).toBe("ClickHouse::Dictionary");
    expect(d.sqlName).toBe("shop.rates_dict");
    expect(d.props).toMatchObject({
      name: "rates_dict",
      database: "shop",
      primaryKey: "code",
      dataSource: "clickhouse(table 'rates' db 'shop' password 'secret')",
      layout: "complex_key_hashed()",
      lifetime: "300",
      comment: "exchange rates",
      columns: [
        { name: "code", type: "String" },
        { name: "rate", type: "Float64", default: "1" },
        { name: "label", type: "String", default: "''", expression: "upper(code)", flags: ["INJECTIVE"] },
      ],
    });
    expect(Object.keys(d.columns)).toEqual(["code", "rate", "label"]);
  });

  test("a range layout with its columns referenced, and settings", () => {
    const rates = table`CREATE TABLE shop.rates (code String, rate Float64, start Date, end Date) ENGINE = MergeTree ORDER BY code`;
    const d = dictionary`CREATE DICTIONARY shop.rates_by_day (code String, start Date, end Date, rate Float64)
      PRIMARY KEY code SOURCE(CLICKHOUSE(TABLE 'rates' DB 'shop')) LAYOUT(COMPLEX_KEY_RANGE_HASHED())
      RANGE(MIN ${rates.columns.start} MAX ${rates.columns.end}) LIFETIME(MIN 10 MAX 20) SETTINGS(format_csv_allow_single_quotes = 0)`;
    expect(d.props.range).toBe("MIN start MAX end");
    expect(d.props.settings).toEqual({ format_csv_allow_single_quotes: "0" });
    expect(d.props.dataSource).toBe("CLICKHOUSE(TABLE 'rates' DB 'shop')");
  });

  test("a dictionary needs a key, a source and a layout; another statement names its tag", () => {
    expect(() => dictionary(["CREATE DICTIONARY d (id UInt64) SOURCE(NULL()) LAYOUT(FLAT())"] as unknown as TemplateStringsArray)).toThrow(/PRIMARY KEY/);
    expect(() => dictionary(["CREATE DICTIONARY d (id UInt64) PRIMARY KEY id LAYOUT(FLAT())"] as unknown as TemplateStringsArray)).toThrow(/SOURCE/);
    expect(() => dictionary(["CREATE TABLE t (id UInt64) ENGINE = Memory"] as unknown as TemplateStringsArray)).toThrow(SqlTemplateError);
    expect(() => table(["CREATE DICTIONARY d (id UInt64) PRIMARY KEY id SOURCE(NULL()) LAYOUT(FLAT())"] as unknown as TemplateStringsArray)).toThrow(/use the dictionary tag/);
  });
});

describe("a dictionary compared with the server's", () => {
  test("the declaration and what the server prints for it compare equal", () => {
    expect(diffSchemas([{ key: "d", canonical: canonicalObject(SHOWN) }], [{ key: "d", canonical: canonicalObject(DECLARED) }]).changes).toEqual([]);
  });

  test("the server's rewrites are undone: key words upper case, a password hidden, a lifetime as MIN and MAX", () => {
    expect(canonicalDictionaryClause("clickhouse(table src db 'x' user 'u' password 'p')")).toBe("CLICKHOUSE ( TABLE src DB 'x' USER 'u' PASSWORD '[HIDDEN]' )");
    expect(canonicalDictionaryClause("hashed")).toBe("HASHED");
    expect(canonicalDictionaryClause("flat(initial_array_size 100)")).toBe("FLAT ( INITIAL_ARRAY_SIZE 100 )");
    expect(canonicalLifetime("300")).toBe("MIN 0 MAX 300");
    expect(canonicalLifetime("max 20 min 10")).toBe("MIN 10 MAX 20");
  });

  test("every change but the comment replaces the dictionary (SQLCH245)", () => {
    const before = canonicalObject(SHOWN);
    const after = canonicalObject(
      DECLARED.replace("complex_key_hashed()", "complex_key_sparse_hashed()").replace("LIFETIME(300)", "LIFETIME(600)").replace("rate Float64 DEFAULT 1", "rate Float64 DEFAULT 0").replace("'exchange rates'", "'rates'"),
    );
    const changes = diffSchemas([{ key: "d", canonical: before }], [{ key: "d", canonical: after }]).changes;
    expect(changes.map((c) => [c.field, c.rule])).toEqual([
      ["comment", "SQLCH203"],
      ["columns.rate", "SQLCH245"],
      ["layout", "SQLCH245"],
      ["lifetime", "SQLCH245"],
    ]);
    expect(CLASSIFIER_RULES.SQLCH245.class).toBe("metadata");
  });
});

describe("a dictionary's statements", () => {
  const marker = { stack: "shop", env: "prod" };

  test("created with chant's marker in its comment, replaced whole, dropped and renamed as a dictionary", () => {
    const obj = declared(DECLARED);
    expect(createStatement(obj, marker)).toMatch(/^CREATE DICTIONARY shop\.rates_dict[\s\S]*COMMENT 'exchange rates \[chant[^']*stack=shop env=prod[^']*\]'$/);
    const changes = diffSchemas([{ key: obj.key, canonical: canonicalObject(SHOWN) }], [{ key: obj.key, canonical: canonicalObject(DECLARED.replace("LIFETIME(300)", "LIFETIME(600)")) }]).changes;
    const plan = planStatements({ declared: [declared(DECLARED.replace("LIFETIME(300)", "LIFETIME(600)"))], changes, current: new Map([[obj.key, canonicalObject(SHOWN)]]), marker });
    const entry = plan.objects[0]!;
    expect(entry.verdict).toBe("alter");
    const steps = entry.verdict === "alter" ? entry.steps : [];
    expect(steps.map((s) => s.rule)).toEqual(["SQLCH245"]);
    expect(steps[0]!.sql).toMatch(/^CREATE OR REPLACE DICTIONARY shop\.rates_dict[\s\S]*LIFETIME\(600\)[\s\S]*stack=shop/);
    expect(dropStatement(CLICKHOUSE_ENTITY_TYPES.dictionary, "shop", "rates_dict")).toBe("DROP DICTIONARY `shop`.`rates_dict` SYNC");
    const renamed = alterSteps(obj, [{ object: obj.key, field: "name", rule: "SQLCH230", class: "metadata", before: "shop.old_rates", after: "shop.rates_dict" } as never]);
    expect(renamed.map((s) => s.sql)).toEqual(["RENAME DICTIONARY `shop`.`old_rates` TO `shop`.`rates_dict`"]);
  });

  test("a comment alone is restamped with ALTER, not replaced", () => {
    const obj = declared(DECLARED.replace("'exchange rates'", "'rates'"));
    const changes = diffSchemas([{ key: obj.key, canonical: canonicalObject(SHOWN) }], [{ key: obj.key, canonical: obj.canonical }]).changes;
    const plan = planStatements({ declared: [obj], changes, current: new Map([[obj.key, canonicalObject(SHOWN)]]), marker });
    const entry = plan.objects[0]!;
    expect(entry.verdict === "alter" ? entry.steps.map((s) => s.sql) : []).toEqual([expect.stringMatching(/^ALTER TABLE `shop`\.`rates_dict` MODIFY COMMENT 'rates \[chant/)]);
  });

  test("ON CLUSTER on a cluster, none in a Replicated database or on a single node", () => {
    const sql = createStatement(declared(DECLARED), marker);
    expect(renderStatement(sql, { kind: "cluster", cluster: "main" })).toMatch(/^CREATE DICTIONARY shop\.rates_dict ON CLUSTER `main`\s*\(/);
    expect(renderStatement(sql, { kind: "replicated", cluster: "main" })).not.toMatch(/ON CLUSTER/);
    expect(renderStatement(sql, { kind: "single" })).toBe(sql);
    expect(renderStatement(dropStatement(CLICKHOUSE_ENTITY_TYPES.dictionary, "shop", "rates_dict"), { kind: "cluster", cluster: "main" })).toBe(
      "DROP DICTIONARY `shop`.`rates_dict` ON CLUSTER `main` SYNC",
    );
  });

  test("dropped before the tables it reads, after the views", () => {
    const current = new Map([
      ["shop.rates", canonicalObject("CREATE TABLE shop.rates (code String) ENGINE = MergeTree ORDER BY code")],
      ["shop.rates_dict", canonicalObject(SHOWN)],
      ["shop.v", canonicalObject("CREATE VIEW shop.v AS SELECT dictGet('shop.rates_dict', 'rate', 'x')")],
    ]);
    const changes = diffSchemas([...current].map(([key, canonical]) => ({ key, canonical })), []).changes;
    const plan = planStatements({ declared: [], changes, current, allowDestructive: true });
    expect(plan.drops.map((d) => d.key)).toEqual(["shop.v", "shop.rates_dict", "shop.rates"]);
  });
});

describe("importing a dictionary", () => {
  test("the server's statement becomes a dictionary declaration that builds the same dictionary", async () => {
    const { ClickHouseSqlParser } = await import("./import/parser");
    const { ClickHouseGenerator } = await import("./import/generator");
    const ir = new ClickHouseSqlParser().parse(`CREATE DATABASE shop;\n${SHOWN};`);
    expect(ir.resources.map((r) => [r.logicalId, r.type])).toEqual([
      ["shopDb", "ClickHouse::Database"],
      ["ratesDict", "ClickHouse::Dictionary"],
    ]);
    const [file] = new ClickHouseGenerator().generate(ir);
    expect(file!.content).toContain('import { database, dictionary } from "@intentius/chant-lexicon-sql/clickhouse";');
    expect(file!.content).toContain("export const ratesDict = dictionary`");
    expect(file!.content).toContain("CREATE DICTIONARY ${shopDb}.rates_dict");
  });
});
