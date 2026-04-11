import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { CompletionContext } from "@intentius/chant/lsp/types";

const generatedDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-gitlab.json"));

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
  test.skipIf(!hasGenerated)("returns resource completions for 'new ' prefix", async () => {
    const { gitlabCompletions } = await import("./completions");
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

  test.skipIf(!hasGenerated)("returns all resource completions when no filter", async () => {
    const { gitlabCompletions } = await import("./completions");
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

  test.skipIf(!hasGenerated)("filters completions by prefix", async () => {
    const { gitlabCompletions } = await import("./completions");
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

  test.skipIf(!hasGenerated)("returns empty for non-constructor context", async () => {
    const { gitlabCompletions } = await import("./completions");
    const ctx = makeCtx({
      linePrefix: "const x = foo(",
      wordAtCursor: "",
      content: "const x = foo(",
      position: { line: 0, character: 14 },
    });

    const items = gitlabCompletions(ctx);
    expect(items).toHaveLength(0);
  });

  test.skipIf(!hasGenerated)("completion items have detail with resource type", async () => {
    const { gitlabCompletions } = await import("./completions");
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
