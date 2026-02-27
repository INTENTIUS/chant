import { describe, test, expect } from "bun:test";
import { gcpSerializer } from "./serializer";

describe("gcpSerializer", () => {
  test("has correct name and rule prefix", () => {
    expect(gcpSerializer.name).toBe("gcp");
    expect(gcpSerializer.rulePrefix).toBe("WGC");
  });

  test("serialize returns empty string for empty entities", () => {
    const result = gcpSerializer.serialize(new Map());
    expect(result).toBe("");
  });
});
