import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { GRAFANA_SCHEMA_PIN, SCHEMA_NAMES, VENDORED_SCHEMA_NAMES, schemaUrl } from "./pin";
import { digestMismatches, loadSchema } from "./spec/schemas";
import { schemaModules } from "./codegen/generate";
import { schemaModule, tsType } from "./codegen/schema-types";
import { DASHBOARD_SCHEMA_VERSION } from "./schema/dashboard.gen";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe("the schema pin", () => {
  test("names a commit and a digest for every vendored schema", () => {
    expect(GRAFANA_SCHEMA_PIN.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(GRAFANA_SCHEMA_PIN.files).sort()).toEqual([...VENDORED_SCHEMA_NAMES].sort());
    // Types come from the classic schemas only; dashboardv2 is vendored for the importer (#2947).
    expect(VENDORED_SCHEMA_NAMES.filter((n) => !(SCHEMA_NAMES as readonly string[]).includes(n))).toEqual(["dashboardv2"]);
    expect(schemaUrl("stat")).toBe(`https://raw.githubusercontent.com/grafana/grafana-foundation-sdk/${GRAFANA_SCHEMA_PIN.commit}/jsonschema/stat.jsonschema.json`);
  });

  test("every vendored schema matches its pinned digest", () => {
    expect(digestMismatches()).toEqual([]);
  });

  test("the committed schema types are what generate writes", () => {
    for (const [rel, source] of Object.entries(schemaModules())) {
      expect({ rel, same: readFileSync(join(pkgDir, rel), "utf-8") === source }).toEqual({ rel, same: true });
    }
  });

  test("the emitted schemaVersion is the pinned dashboard schema's default", () => {
    const defs = loadSchema("dashboard").definitions as Record<string, { properties: Record<string, { default?: unknown }> }>;
    expect(DASHBOARD_SCHEMA_VERSION).toBe(defs.Dashboard.properties.schemaVersion.default);
  });
});

describe("schema-types", () => {
  test("maps the draft-07 subset cog emits", () => {
    expect(tsType({ type: "string" })).toBe("string");
    expect(tsType({ type: "integer" })).toBe("number");
    expect(tsType({ enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(tsType({ const: "row" })).toBe('"row"');
    expect(tsType({ $ref: "#/definitions/dataquery" })).toBe("Dataquery");
    expect(tsType({ anyOf: [{ type: "integer" }, { type: "null" }] })).toBe("number | null");
    expect(tsType({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } })).toBe("(string | number)[]");
    expect(tsType({ type: "object", additionalProperties: { type: "string" } })).toBe("Record<string, string>");
    expect(tsType({ type: "object", additionalProperties: {} })).toBe("Record<string, unknown>");
    expect(tsType({})).toBe("unknown");
  });

  test("keeps required, marks the rest optional, and carries descriptions and deprecations", () => {
    const { source, types } = schemaModule("text", {
      definitions: {
        Options: {
          type: "object",
          required: ["mode"],
          properties: {
            mode: { $ref: "#/definitions/TextMode", description: "How content renders" },
            "odd-key": { type: "boolean", deprecated: true },
          },
        },
        TextMode: { enum: ["html", "markdown"] },
      },
    });
    expect(types).toEqual(["Options", "TextMode"]);
    expect(source).toContain("export interface Options {");
    expect(source).toContain("  mode: TextMode;");
    expect(source).toContain('  "odd-key"?: boolean;');
    expect(source).toContain("   * How content renders");
    expect(source).toContain("   * @deprecated");
    expect(source).toContain('export type TextMode = "html" | "markdown";');
  });

  test("refuses a remote $ref", () => {
    expect(() => tsType({ $ref: "common.json#/definitions/X" })).toThrow(/local/);
  });
});
