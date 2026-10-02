/**
 * The import round trip, offline: a file of CREATE statements is imported as
 * declarations, the declarations are built back into statements, and importing
 * those gives the same declarations. Nothing the import writes is lost or
 * reordered by the build.
 *
 * The same schema runs against two live servers in `../live/roundtrip.e2e.test.ts`
 * (import, build, apply, catalog unchanged); this file is the part of that
 * round trip that needs no Docker.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { build } from "@intentius/chant/build";
import type { SerializerResult } from "@intentius/chant/serializer";
import { sqlPlugin } from "../../plugin";
import { CLICKHOUSE_DDL_FILE, sqlSerializer } from "../../serializer";
import { SCHEMA } from "../testing/roundtrip-schema";
import { ClickHouseGenerator } from "./generator";
import { splitStatements } from "./ir";
import { ClickHouseSqlParser } from "./parser";

// Inside the package, so the declarations resolve `@intentius/chant-lexicon-sql/clickhouse` as the e2e test does.
const dir = join(import.meta.dirname, "..", "..", "..", `.roundtrip-offline-tmp-${process.pid}`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const parser = new ClickHouseSqlParser();
const generator = new ClickHouseGenerator();

/** Whitespace folded: the build keeps an author's own line breaks and indent, and the import indents the text it writes. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** A generated file as its export declarations, whitespace folded and sorted: the order follows dependencies. */
const declarations = (content: string) => content.split(/^export const /m).slice(1).map(squash).sort();

/** Declarations to the statements the build writes, in the order it wrote them. */
async function buildStatements(name: string, source: string): Promise<string[]> {
  const project = join(dir, name);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "chant.config.ts"), 'export default { lexicons: ["sql"] };\n');
  writeFileSync(join(project, "src", "schema.ts"), source);
  const result = await build(join(project, "src"), [sqlSerializer], undefined, {
    fold: true,
    intrinsics: sqlPlugin.intrinsics!(),
    lexicons: ["sql"],
  });
  expect(result.errors).toEqual([]);
  return splitStatements((result.outputs.get("sql") as SerializerResult).files![CLICKHOUSE_DDL_FILE]!);
}

describe("import, build, import again", () => {
  const ir = parser.parse(SCHEMA.join(";\n"));
  const [file] = generator.generate(ir);

  test("every statement of the schema is imported", () => {
    expect(ir.warnings ?? []).toEqual([]);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "ClickHouse::Database",
      "ClickHouse::Table",
      "ClickHouse::Table",
      "ClickHouse::Table",
      "ClickHouse::MaterializedView",
      "ClickHouse::View",
      "ClickHouse::Table",
    ]);
    expect(file!.content).toContain("export const events = table`");
  });

  test("the declarations build back to one statement per object, dependencies first", async () => {
    const statements = await buildStatements("first", file!.content);
    expect(statements).toHaveLength(SCHEMA.length);
    const at = (needle: string) => statements.findIndex((s) => s.includes(needle));
    expect(at("CREATE DATABASE analytics")).toBeLessThan(at("analytics.events"));
    expect(at("analytics.events")).toBeLessThan(at("daily_mv"));
    expect(at("analytics.daily")).toBeLessThan(at("daily_mv"));
  });

  test("importing the built statements gives the same declarations", async () => {
    const statements = await buildStatements("second", file!.content);
    const again = generator.generate(parser.parse(statements.join(";\n")));
    expect(declarations(again[0]!.content)).toEqual(declarations(file!.content));
  });

  test("a second build writes the same statements, in whatever order dependencies allow", async () => {
    const first = await buildStatements("third", file!.content);
    const second = await buildStatements("fourth", generator.generate(parser.parse(first.join(";\n")))[0]!.content);
    expect(second.map(squash).sort()).toEqual(first.map(squash).sort());
  });
});
