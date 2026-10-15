import { describe, expect, it } from "vitest";
import type { CompletionContext } from "@intentius/chant/lsp/types";
import { completions } from "./completions";

function ctx(partial: Partial<CompletionContext>): CompletionContext {
  return {
    uri: "file:///infra.ts",
    content: "",
    position: { line: 0, character: 0 },
    wordAtCursor: "",
    linePrefix: "",
    ...partial,
  };
}

describe("LSP completions", () => {
  it("suggests the fountain kinds after `new `", () => {
    const items = completions(ctx({ linePrefix: "export const e = new " }));
    const labels = items.map((i) => i.label);

    for (const kind of ["Environment", "Vault", "Agent"]) {
      expect(labels).toContain(kind);
    }
    // Retired upstream (managoat/managoat#2793): still importable, so an old
    // project builds far enough for FTN025, but never suggested.
    for (const kind of ["Teammate", "Schedule", "Webhook"]) {
      expect(labels).not.toContain(kind);
    }
    expect(items.every((i) => i.kind === "resource")).toBe(true);
  });

  it("narrows on a typed prefix", () => {
    const items = completions(ctx({ linePrefix: "new Env", wordAtCursor: "Env" }));

    expect(items.map((i) => i.label)).toEqual(["Environment"]);
    expect(items[0].detail).toBe("Fountain::V1::Environment");
  });

  it("suggests properties inside a constructor", () => {
    const content = "const a = new Agent({\n  ";
    const items = completions(
      ctx({ content, position: { line: 1, character: 2 }, linePrefix: "  " }),
    );
    const labels = items.map((i) => i.label);

    // Property names come off the generated `props` list, merged with
    // propertyConstraints. A rename of either silently empties this.
    expect(labels).toContain("runtime");
    expect(labels).toContain("model");
    expect(labels).toContain("runtime_command");
    expect(items.every((i) => i.kind === "property")).toBe(true);
  });

  it("offers unconstrained props, which constraint-derived completion would drop", () => {
    const content = "const a = new Agent({\n  ";
    const labels = completions(ctx({ content, position: { line: 1, character: 2 }, linePrefix: "  " })).map(
      (i) => i.label,
    );
    // Neither carries a constraint upstream, so only the generated `props`
    // list puts them here.
    expect(labels).toEqual(expect.arrayContaining(["system", "allowed_vault_ids"]));
  });

  it("returns nothing in an unrelated position", () => {
    expect(completions(ctx({ linePrefix: "const x = 1" }))).toEqual([]);
  });
});
