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
    expect(info?.contents).toContain("`runtime`: `claude` | `codex` | `gemini` | `opencode` | `acp`");
  });

  it("documents the kinds added in v0.16.0", () => {
    expect(hover(ctx("Teammate"))?.contents).toContain("Fountain::V1::Teammate");
    expect(hover(ctx("Teammate"))?.contents).toContain("typed reference");
    expect(hover(ctx("Schedule"))?.contents).toContain("five fields in UTC");
    expect(hover(ctx("Webhook"))?.contents).toContain("RFC1918");
  });

  it("describes the acp runtime without calling it an extension", () => {
    const agent = hover(ctx("Agent"))?.contents;
    expect(agent).toContain("runtime_command");
    expect(agent).toContain("FTN023");
    expect(agent).not.toContain("#1634");
  });

  it("points an Environment's setup timeout at FTN024", () => {
    expect(hover(ctx("Environment"))?.contents).toContain("FTN024");
  });

  it("marks property types as non-declarable", () => {
    const info = hover(ctx("Repository"));

    expect(info?.contents).toContain("Property type");
  });
});
