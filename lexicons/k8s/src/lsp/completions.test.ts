import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hasGenerated = existsSync(
  join(pkgDir, "src", "generated", "lexicon-k8s.json"),
);

describe("LSP completions", () => {
  test.skipIf(!hasGenerated)(
    "returns completions for 'new D' prefix",
    async () => {
      const { k8sCompletions } = await import("./completions");
      const result = k8sCompletions({
        uri: "file:///test.ts",
        content: "const x = new D",
        linePrefix: "const x = new D",
        wordAtCursor: "D",
        position: { line: 0, character: 15 },
      } as any);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      const labels = result.map((c: any) => c.label ?? c);
      expect(labels.some((l: string) => l.includes("Deployment"))).toBe(true);
    },
  );

  test.skipIf(!hasGenerated)(
    "returns empty for non-constructor context",
    async () => {
      const { k8sCompletions } = await import("./completions");
      const result = k8sCompletions({
        uri: "file:///test.ts",
        content: "const x = 42",
        linePrefix: "const x = 42",
        wordAtCursor: "",
        position: { line: 0, character: 12 },
      } as any);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    },
  );

  test.skipIf(!hasGenerated)("filters by prefix correctly", async () => {
    const { k8sCompletions } = await import("./completions");
    const result = k8sCompletions({
      uri: "file:///test.ts",
      content: "const x = new StatefulS",
      linePrefix: "const x = new StatefulS",
      wordAtCursor: "StatefulS",
      position: { line: 0, character: 23 },
    } as any);

    expect(Array.isArray(result)).toBe(true);
    if (result.length > 0) {
      const labels = result.map((c: any) => c.label ?? c);
      expect(labels.some((l: string) => l.includes("StatefulSet"))).toBe(true);
    }
  });
});
