import { describe, test, expect } from "vitest";
import {
  applyPropertyOverlay,
  assertPropertyOverlayCoverage,
  propertyOverlayEntries,
  redundantPropertyOverlayWarnings,
  type PropertyOverlayEntry,
} from "./property-overlay";

const entry = (over: Partial<PropertyOverlayEntry> = {}): PropertyOverlayEntry => ({
  type: "AWS::Test::Resource",
  property: "Version",
  issue: 1,
  source: "https://example.invalid",
  reviewed: "2026-10-12",
  schema: { type: "string", maxLength: 8 },
  ...over,
});

const schema = (properties: Record<string, unknown> = { Name: { type: "string" } }) =>
  JSON.stringify({ typeName: "AWS::Test::Resource", properties, additionalProperties: false });

describe("applyPropertyOverlay", () => {
  test("adds a property the schema lacks, leaving the rest alone", () => {
    const { data, applications } = applyPropertyOverlay(schema(), [entry()]);
    expect(applications.map((a) => a.outcome)).toEqual(["applied"]);
    const doc = JSON.parse(data as string);
    expect(doc.properties.Version).toEqual({ type: "string", maxLength: 8 });
    expect(doc.properties.Name).toEqual({ type: "string" });
  });

  test("the spec wins once it declares the property", () => {
    const upstream = schema({ Version: { type: "string", maxLength: 128 } });
    const { data, applications } = applyPropertyOverlay(upstream, [entry()]);
    expect(data).toBe(upstream);
    expect(applications.map((a) => a.outcome)).toEqual(["redundant"]);
    expect(redundantPropertyOverlayWarnings(applications)).toHaveLength(1);
  });

  test("keeps the input's encoding", () => {
    const { data } = applyPropertyOverlay(Buffer.from(schema()), [entry()]);
    expect(Buffer.isBuffer(data)).toBe(true);
  });
});

describe("assertPropertyOverlayCoverage", () => {
  test("a strict run refuses an entry on a type it never saw", () => {
    expect(() => assertPropertyOverlayCoverage([entry()], new Set(), true)).toThrow(/AWS::Test::Resource/);
    expect(() => assertPropertyOverlayCoverage([entry()], new Set(), false)).not.toThrow();
  });
});

describe("property-overlay.json", () => {
  test("every entry names a top-level property and a schema with a type", () => {
    for (const e of propertyOverlayEntries()) {
      expect(e.type).toMatch(/^AWS::\w+::\w+$/);
      expect(e.property).toMatch(/^[A-Z]\w*$/);
      expect(typeof e.schema.type).toBe("string");
    }
  });
});
