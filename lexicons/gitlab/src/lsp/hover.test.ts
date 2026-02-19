import { describe, test, expect } from "bun:test";
import { gitlabHover } from "./hover";
import type { HoverContext } from "@intentius/chant/lsp/types";

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
  test("returns hover for Job class", () => {
    const ctx = makeCtx({ word: "Job" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("**Job**");
    expect(hover!.contents).toContain("GitLab::CI::Job");
    expect(hover!.contents).toContain("Resource entity");
  });

  test("returns hover for property entity", () => {
    const ctx = makeCtx({ word: "Cache" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("**Cache**");
    expect(hover!.contents).toContain("GitLab::CI::Cache");
    expect(hover!.contents).toContain("Property entity");
  });

  test("returns hover for Default", () => {
    const ctx = makeCtx({ word: "Default" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("GitLab::CI::Default");
  });

  test("returns hover for Artifacts", () => {
    const ctx = makeCtx({ word: "Artifacts" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("GitLab::CI::Artifacts");
  });

  test("returns undefined for unknown word", () => {
    const ctx = makeCtx({ word: "UnknownEntity" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeUndefined();
  });

  test("returns undefined for empty word", () => {
    const ctx = makeCtx({ word: "" });
    const hover = gitlabHover(ctx);
    expect(hover).toBeUndefined();
  });
});
