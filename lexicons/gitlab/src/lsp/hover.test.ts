import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { HoverContext } from "@intentius/chant/lsp/types";

const generatedDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-gitlab.json"));

function makeCtx(overrides: Partial<HoverContext>): HoverContext {
  return {
    uri: "file:///test.ts",
    content: "",
    position: { line: 0, character: 0 },
    word: "",
    lineText: "",
    ...overrides,
  };
}

describe("gitlabHover", () => {
  test.skipIf(!hasGenerated)("returns hover for Job class", async () => {
    const { gitlabHover } = await import("./hover");
    const ctx = makeCtx({ word: "Job" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("**Job**");
    expect(hover!.contents).toContain("GitLab::CI::Job");
    expect(hover!.contents).toContain("Resource entity");
  });

  test.skipIf(!hasGenerated)("returns hover for property entity", async () => {
    const { gitlabHover } = await import("./hover");
    const ctx = makeCtx({ word: "Cache" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("**Cache**");
    expect(hover!.contents).toContain("GitLab::CI::Cache");
    expect(hover!.contents).toContain("Property entity");
  });

  test.skipIf(!hasGenerated)("returns hover for Default", async () => {
    const { gitlabHover } = await import("./hover");
    const ctx = makeCtx({ word: "Default" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("GitLab::CI::Default");
  });

  test.skipIf(!hasGenerated)("returns hover for Artifacts", async () => {
    const { gitlabHover } = await import("./hover");
    const ctx = makeCtx({ word: "Artifacts" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("GitLab::CI::Artifacts");
  });

  test.skipIf(!hasGenerated)("returns undefined for unknown word", async () => {
    const { gitlabHover } = await import("./hover");
    const ctx = makeCtx({ word: "UnknownEntity" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeUndefined();
  });

  test.skipIf(!hasGenerated)("returns undefined for empty word", async () => {
    const { gitlabHover } = await import("./hover");
    const ctx = makeCtx({ word: "" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeUndefined();
  });
});
