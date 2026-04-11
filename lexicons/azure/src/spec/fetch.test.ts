import { describe, it, expect } from "vitest";
import { getCachePath } from "./fetch";

describe("fetchArmSchemas", () => {
  it("returns a valid cache path", () => {
    const path = getCachePath();
    expect(path).toContain(".chant");
    expect(path).toContain("azure-resource-manager-schemas");
  });
});
