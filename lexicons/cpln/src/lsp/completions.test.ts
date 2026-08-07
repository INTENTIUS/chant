import { describe, expect, it } from "vitest";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

function ctx(content: string, linePrefix = content.split("\n").pop() ?? ""): CompletionContext {
  const lines = content.split("\n");
  return {
    uri: "file:///infra.ts",
    content,
    position: { line: lines.length - 1, character: lines[lines.length - 1].length },
    wordAtCursor: "",
    linePrefix,
  };
}

describe("cpln LSP completions", () => {
  it("returns an array", () => {
    expect(Array.isArray(completions(ctx("")))).toBe(true);
  });

  it("offers the resource classes after `new `", () => {
    const labels = completions(ctx("const w = new ")).map((item) => item.label);
    for (const kind of ["Gvc", "Workload", "Identity", "VolumeSet", "Secret", "Policy", "Domain", "IpSet"]) {
      expect(labels, `${kind} missing from completions`).toContain(kind);
    }
  });

  it("offers a workload's property names inside its constructor", () => {
    const labels = completions(ctx("const w = new Workload({\n  ", "  ")).map((item) => item.label);
    expect(labels).toContain("name");
    expect(labels).toContain("spec");
    // The property GVC-scoped kinds carry, which the OpenAPI document does not.
    expect(labels).toContain("gvc");
  });

  it("does not offer read-only attributes as properties", () => {
    // These are attributes, not authoring surface — and Control Plane rejects a
    // manifest carrying them, which is why they must not be suggested.
    const labels = completions(ctx("const w = new Workload({\n  ", "  ")).map((item) => item.label);
    for (const attribute of ["id", "status", "created", "lastModified", "links"]) {
      expect(labels, `${attribute} is an attribute, not authoring surface`).not.toContain(attribute);
    }
  });
});
