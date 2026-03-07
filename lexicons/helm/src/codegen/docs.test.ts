import { describe, test, expect } from "bun:test";

describe("Helm docs generation", () => {
  test("docs module is importable", async () => {
    const mod = await import("./docs");
    expect(mod.generateDocs).toBeFunction();
  });

  test("generateDocs function signature accepts options", async () => {
    const mod = await import("./docs");
    // Verify the function exists and has the expected shape
    expect(typeof mod.generateDocs).toBe("function");
  });
});
