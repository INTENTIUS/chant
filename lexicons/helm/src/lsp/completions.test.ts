import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hasGenerated = existsSync(join(pkgDir, "src", "generated", "lexicon-helm.json"));

describe.skipIf(!hasGenerated)("helmCompletions", () => {
  test("returns resource completions for `new ` prefix", async () => {
    const { helmCompletions } = await import("./completions");
    const ctx = {
      uri: "file:///test.ts",
      content: "const c = new Chart",
      position: { line: 0, character: 19 },
      wordAtCursor: "Chart",
      linePrefix: "const c = new Chart",
    };

    const items = helmCompletions(ctx);
    expect(items.length).toBeGreaterThan(0);

    const chartItem = items.find((i) => i.label === "Chart");
    expect(chartItem).toBeDefined();
    expect(chartItem?.kind).toBe("resource");
    expect(chartItem?.detail).toContain("Helm::Chart");
  });

  test("filters resource completions by prefix", async () => {
    const { helmCompletions } = await import("./completions");
    const ctx = {
      uri: "file:///test.ts",
      content: "const h = new Helm",
      position: { line: 0, character: 18 },
      wordAtCursor: "Helm",
      linePrefix: "const h = new Helm",
    };

    const items = helmCompletions(ctx);
    for (const item of items) {
      expect(item.label.toLowerCase().startsWith("helm")).toBe(true);
    }
  });

  test("limits results to 50", async () => {
    const { helmCompletions } = await import("./completions");
    const ctx = {
      uri: "file:///test.ts",
      content: "const x = new ",
      position: { line: 0, character: 14 },
      wordAtCursor: "",
      linePrefix: "const x = new ",
    };

    const items = helmCompletions(ctx);
    expect(items.length).toBeLessThanOrEqual(50);
  });

  test("returns empty for non-matching context", async () => {
    const { helmCompletions } = await import("./completions");
    const ctx = {
      uri: "file:///test.ts",
      content: "const x = 42",
      position: { line: 0, character: 13 },
      wordAtCursor: "42",
      linePrefix: "const x = 42",
    };

    const items = helmCompletions(ctx);
    expect(items.length).toBe(0);
  });
});
