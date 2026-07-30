import { describe, expect, it } from "vitest";
import type { HoverContext } from "@intentius/chant/lsp/types";
import { hover } from "./hover";

function ctx(word: string): HoverContext {
  return {
    uri: "file:///infra.ts",
    content: "",
    position: { line: 0, character: 0 },
    word,
    lineText: "",
  };
}

describe("LSP hover", () => {
  it("returns undefined for an unknown word", () => {
    expect(hover(ctx("Conversation"))).toBeUndefined();
    expect(hover(ctx(""))).toBeUndefined();
  });

  it("describes a resource with its fountain type", () => {
    const info = hover(ctx("Environment"));

    expect(info?.contents).toContain("**Environment**");
    expect(info?.contents).toContain("Fountain::V1::Environment");
  });

  it("carries the networking semantics an author cannot infer from the prop name", () => {
    const info = hover(ctx("Environment"));

    expect(info?.contents).toContain("denies all egress");
    expect(info?.contents).toContain("`networking_type`: `unrestricted` | `limited`");
  });

  it("spells out allowed_vault_ids' three-state meaning", () => {
    const info = hover(ctx("Agent"));

    expect(info?.contents).toContain("allowed_vault_ids");
    expect(info?.contents).toContain("`runtime`: `claude` | `codex` | `gemini` | `opencode`");
  });

  it("marks property types as non-declarable", () => {
    const info = hover(ctx("Repository"));

    expect(info?.contents).toContain("Property type");
  });
});
