import { describe, test, expect } from "vitest";
import { buildListMapKeyTable, parsedListMapKeyPairs, generateListMapKeysJSON } from "./generate-list-map-keys";
import type { K8sParseResult, ParsedProperty } from "../spec/parse";

/**
 * chant #1441 — the table the drift engine reads instead of six hardcoded
 * property names.
 */

function prop(name: string, over: Partial<ParsedProperty> = {}): ParsedProperty {
  return { name, tsType: "any[]", required: false, constraints: {}, ...over };
}

function result(properties: ParsedProperty[], propertyTypeProps: ParsedProperty[] = []): K8sParseResult {
  return {
    resource: { typeName: "K8s::Test", properties, attributes: [], deprecatedProperties: [] },
    propertyTypes: propertyTypeProps.length
      ? [{ name: "Nested", defType: "io.k8s.Nested", properties: propertyTypeProps }]
      : [],
    enums: [],
    gvk: { group: "", version: "v1", kind: "Test" },
  };
}

describe("buildListMapKeyTable", () => {
  test("folds pairs into a by-name table with sorted key fields", () => {
    expect(buildListMapKeyTable([["ports", ["protocol", "containerPort"]]])).toEqual({
      ports: [["containerPort", "protocol"]],
    });
  });

  test("keeps both variants when one name is keyed two ways", () => {
    // The real case: container ports vs Service ports. Collapsing these would
    // silently mis-identify one of them.
    const table = buildListMapKeyTable([
      ["ports", ["containerPort", "protocol"]],
      ["ports", ["port", "protocol"]],
    ]);
    expect(table.ports).toEqual([
      ["containerPort", "protocol"],
      ["port", "protocol"],
    ]);
  });

  test("deduplicates the same key set seen on many definitions", () => {
    // `conditions` is keyed by `type` at 31 sites in v1.36.2.
    const pairs: Array<[string, string[]]> = Array.from({ length: 31 }, () => ["conditions", ["type"]]);
    expect(buildListMapKeyTable(pairs)).toEqual({ conditions: [["type"]] });
  });

  test("orders candidates longest-first, so a specific set is tried before a shorter one", () => {
    const table = buildListMapKeyTable([
      ["devices", ["driver"]],
      ["devices", ["device", "driver", "pool", "shareID"]],
    ]);
    expect(table.devices[0]).toHaveLength(4);
  });

  test("merges independent sources", () => {
    const table = buildListMapKeyTable([["containers", ["name"]]], [["conditions", ["type"]]]);
    expect(Object.keys(table).sort()).toEqual(["conditions", "containers"]);
  });

  test("names are emitted in sorted order, so regeneration produces a stable file", () => {
    const table = buildListMapKeyTable([
      ["zeta", ["name"]],
      ["alpha", ["name"]],
    ]);
    expect(Object.keys(table)).toEqual(["alpha", "zeta"]);
  });
});

describe("parsedListMapKeyPairs", () => {
  test("collects from resource properties and nested property types alike", () => {
    const pairs = parsedListMapKeyPairs([
      result(
        [prop("conditions", { listType: "map", listMapKeys: ["type"] })],
        [prop("containers", { listType: "map", listMapKeys: ["name"] })],
      ),
    ]);
    expect(pairs).toEqual([
      ["conditions", ["type"]],
      ["containers", ["name"]],
    ]);
  });

  test("ignores atomic and set lists, and map lists with no keys", () => {
    const pairs = parsedListMapKeyPairs([
      result([
        prop("args", { listType: "atomic" }),
        prop("finalizers", { listType: "set" }),
        prop("broken", { listType: "map" }),
        prop("plain"),
      ]),
    ]);
    expect(pairs).toEqual([]);
  });
});

describe("generateListMapKeysJSON", () => {
  test("emits both sources and ends with a newline", () => {
    const json = generateListMapKeysJSON(
      [["ports", ["port", "protocol"]]],
      [result([prop("myItems", { listType: "map", listMapKeys: ["id"] })])],
    );
    expect(json.endsWith("\n")).toBe(true);
    expect(JSON.parse(json)).toEqual({
      myItems: [["id"]],
      ports: [["port", "protocol"]],
    });
  });
});
