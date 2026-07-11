import { describe, expect, it } from "vitest";
import { flySerializer } from "./serializer";

describe("fly serializer", () => {
  it("serializes an empty map to valid JSON", () => {
    const result = flySerializer.serialize(new Map());
    expect(typeof result).toBe("string");
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("has the correct name", () => {
    expect(flySerializer.name).toBe("fly");
  });
});
