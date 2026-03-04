import { describe, test, expect } from "bun:test";

describe("github completions", () => {
  test("completions module exports githubCompletions", async () => {
    const mod = await import("./completions");
    expect(mod.githubCompletions).toBeDefined();
    expect(typeof mod.githubCompletions).toBe("function");
  });
});
