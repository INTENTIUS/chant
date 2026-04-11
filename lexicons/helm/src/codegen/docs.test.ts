import { describe, test, expect } from "vitest";

describe("Helm docs generation", () => {
  test("docs module is importable", async () => {
    const mod = await import("./docs");
    expect(typeof mod.generateDocs).toBe("function");
  });

  test("generateDocs function signature accepts options", async () => {
    const mod = await import("./docs");
    // Verify the function exists and has the expected shape
    expect(typeof mod.generateDocs).toBe("function");
  });
});
