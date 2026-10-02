/**
 * Sectioned by the serializer test table in lexicon-authoring/serializer.mdx.
 * Cases 5, 6, 8, 9 and 12 (derived names, defaults, the dialect's own output)
 * need the ClickHouse entity model and arrive with it.
 */
import { describe, expect, test } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { sqlSerializer } from "./serializer";

function mockResource(entityType: string, props: Record<string, unknown>): Declarable {
  return { [DECLARABLE_MARKER]: true, lexicon: "sql", entityType, kind: "resource", props } as unknown as Declarable;
}

function mockProperty(entityType: string, props: Record<string, unknown>): Declarable {
  return { [DECLARABLE_MARKER]: true, lexicon: "sql", entityType, kind: "property", props } as unknown as Declarable;
}

const parse = (out: unknown) => JSON.parse(out as string) as { objects: Array<{ export: string; type: string; props: unknown }> };

describe("sql serializer", () => {
  test("1. its name is the lexicon's", () => {
    expect(sqlSerializer.name).toBe("sql");
  });

  test("2. its rule prefix is SQL", () => {
    expect(sqlSerializer.rulePrefix).toBe("SQL");
  });

  test("3. an empty build serializes to an empty string", () => {
    expect(sqlSerializer.serialize(new Map())).toBe("");
  });

  test("4. one object is filed under its export name with its type and props", () => {
    const out = parse(sqlSerializer.serialize(new Map([["events", mockResource("ClickHouse::Table", { name: "events" })]])));
    expect(out.objects).toEqual([{ export: "events", type: "ClickHouse::Table", props: { name: "events" } }]);
  });

  test("7. several objects are all written", () => {
    const entities = new Map([
      ["users", mockResource("ClickHouse::Table", { name: "users" })],
      ["events", mockResource("ClickHouse::Table", { name: "events" })],
    ]);
    expect(parse(sqlSerializer.serialize(entities)).objects.map((o) => o.export)).toEqual(["events", "users"]);
  });

  test("10. a property entity is not written as an object of its own", () => {
    const entities = new Map([
      ["events", mockResource("ClickHouse::Table", { name: "events" })],
      ["column", mockProperty("ClickHouse::Column", { name: "ts" })],
    ]);
    expect(parse(sqlSerializer.serialize(entities)).objects.map((o) => o.export)).toEqual(["events"]);
  });

  test("11. objects come out in export-name order whatever order they were declared in", () => {
    const a = new Map([
      ["b", mockResource("ClickHouse::Table", {})],
      ["a", mockResource("ClickHouse::Table", {})],
    ]);
    const b = new Map([...a.entries()].reverse());
    expect(sqlSerializer.serialize(a)).toBe(sqlSerializer.serialize(b));
  });

  test("a reference to another declared object is written as that object's export name", () => {
    const users = mockResource("ClickHouse::Table", { name: "users" });
    const view = mockResource("ClickHouse::View", { reads: [users] });
    const out = parse(sqlSerializer.serialize(new Map([["users", users], ["activeUsers", view]])));
    expect(out.objects.find((o) => o.export === "activeUsers")?.props).toEqual({ reads: [{ ref: "users" }] });
  });
});
