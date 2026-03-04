import { describe, test, expect } from "bun:test";

describe("github hover", () => {
  test("hover module exports githubHover", async () => {
    const mod = await import("./hover");
    expect(mod.githubHover).toBeDefined();
    expect(typeof mod.githubHover).toBe("function");
  });
});
