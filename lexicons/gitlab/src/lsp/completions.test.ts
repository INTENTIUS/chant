import { describe, test, expect } from "bun:test";
import { gitlabCompletions } from "./completions";
import type { CompletionContext } from "@intentius/chant/lsp/types";

function makeCtx(overrides: Partial<CompletionContext>): CompletionContext {
  return {
    uri: "file:///test.ts",
    content: "",
    position: { line: 0, character: 0 },
    wordAtCursor: "",
    linePrefix: "",
    ...overrides,
  };
}

describe("gitlabCompletions", () => {
  test("returns resource completions for 'new ' prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const j = new Job",
      wordAtCursor: "Job",
      content: "const j = new Job",
      position: { line: 0, character: 17 },
    });

    const items = gitlabCompletions(ctx);
    expect(items.length).toBeGreaterThan(0);
    const job = items.find((i) => i.label === "Job");
    expect(job).toBeDefined();
    expect(job!.kind).toBe("resource");
  });

  test("returns all resource completions when no filter", () => {
    const ctx = makeCtx({
      linePrefix: "const x = new ",
      wordAtCursor: "",
      content: "const x = new ",
      position: { line: 0, character: 14 },
    });

    const items = gitlabCompletions(ctx);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Job");
    expect(labels).toContain("Default");
    expect(labels).toContain("Workflow");
  });

  test("filters completions by prefix", () => {
    const ctx = makeCtx({
      linePrefix: "const x = new D",
      wordAtCursor: "D",
      content: "const x = new D",
      position: { line: 0, character: 15 },
    });

    const items = gitlabCompletions(ctx);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Default");
    expect(labels).not.toContain("Job");
  });

  test("returns empty for non-constructor context", () => {
    const ctx = makeCtx({
      linePrefix: "const x = foo(",
      wordAtCursor: "",
      content: "const x = foo(",
      position: { line: 0, character: 14 },
    });

    const items = gitlabCompletions(ctx);
    expect(items).toHaveLength(0);
  });

  test("completion items have detail with resource type", () => {
    const ctx = makeCtx({
      linePrefix: "const j = new Job",
      wordAtCursor: "Job",
      content: "const j = new Job",
      position: { line: 0, character: 17 },
    });

    const items = gitlabCompletions(ctx);
    const job = items.find((i) => i.label === "Job");
    expect(job!.detail).toContain("GitLab::CI::Job");
  });
});
