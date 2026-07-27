import { describe, test, expect } from "vitest";
import { forgejoHover } from "./hover";
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

describe("forgejoHover", () => {
  test("delegates to github's hover info for Job", () => {
    const ctx = makeCtx({ word: "Job" });
    const info = forgejoHover(ctx);
    expect(info).toBeDefined();
    expect(info!.contents).toContain("GitHub::Actions::Job");
  });

  test("returns undefined for an unknown word", () => {
    const ctx = makeCtx({ word: "NotARealForgejoOrGithubThing12345" });
    expect(forgejoHover(ctx)).toBeUndefined();
  });

  test("returns undefined for an empty word", () => {
    const ctx = makeCtx({ word: "" });
    expect(forgejoHover(ctx)).toBeUndefined();
  });
});
