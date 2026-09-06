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

    for (const kind of ["Environment", "Vault", "Agent", "Teammate", "Schedule", "Webhook"]) {
      expect(labels).toContain(kind);
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

  it("offers unconstrained props on the new kinds", () => {
    // `cron` and `url` carry an example rather than a pattern upstream, so
    // constraint-derived completion would drop exactly the two props these
    // kinds exist for.
    const propsOf = (className: string) => {
      const content = `const a = new ${className}({\n  `;
      return completions(ctx({ content, position: { line: 1, character: 2 }, linePrefix: "  " })).map(
        (i) => i.label,
      );
    };

    expect(propsOf("Schedule")).toEqual(
      expect.arrayContaining(["cron", "prompt", "teammate", "one_off", "enabled", "name"]),
    );
    expect(propsOf("Webhook")).toEqual(expect.arrayContaining(["url", "event_types", "description"]));
    expect(propsOf("Teammate")).toEqual(expect.arrayContaining(["agent", "environment", "vault", "name"]));
  });

  it("returns nothing in an unrelated position", () => {
    expect(completions(ctx({ linePrefix: "const x = 1" }))).toEqual([]);
  });
});
