import { describe, expect, it } from "vitest";
import type { HoverContext } from "@intentius/chant/lsp/types";
import { hover } from "./hover";

function ctx(word: string): HoverContext {
  const lineText = `const x = new ${word}({});`;
  return {
    uri: "file:///infra.ts",
    content: lineText,
    position: { line: 0, character: lineText.indexOf(word) + 1 },
    word,
    lineText,
  };
}

describe("cpln LSP hover", () => {
  it("returns nothing for an unknown identifier", () => {
    expect(hover(ctx("NotACplnThing"))).toBeUndefined();
  });

  it("names the Control Plane type and manifest kind for a resource", () => {
    const info = hover(ctx("Workload"));
    expect(info?.contents).toContain("Cpln::Core::Workload");
    expect(info?.contents).toContain("kind: `workload`".replace("kind: ", "Manifest kind: "));
  });

  it("says a GVC-scoped kind needs a gvc", () => {
    expect(hover(ctx("Workload"))?.contents).toContain("GVC-scoped");
    expect(hover(ctx("VolumeSet"))?.contents).toContain("GVC-scoped");
    expect(hover(ctx("Gvc"))?.contents).not.toContain("GVC-scoped —");
  });

  it("carries the silent-failure notes the types cannot express", () => {
    // These are the reason hover exists here: the property list is already in
    // the types; what an author cannot see is which mistakes fail quietly.
    expect(hover(ctx("Identity"))?.contents).toContain("silently ignored");
    expect(hover(ctx("Secret"))?.contents).toContain("fails silently");
    expect(hover(ctx("VolumeSet"))?.contents).toContain("immutable");
    expect(hover(ctx("Workload"))?.contents).toContain("immutable");
  });

  it("spells out enumerated properties", () => {
    const info = hover(ctx("Secret"));
    expect(info?.contents).toContain("Enumerated properties:");
    expect(info?.contents).toContain("`opaque`");
  });

  it("marks a property type as nested and names its owner", () => {
    const info = hover(ctx("WorkloadSpecContainers"));
    expect(info?.contents).toContain("Property type");
    expect(info?.contents).toContain("Workload");
  });
});
