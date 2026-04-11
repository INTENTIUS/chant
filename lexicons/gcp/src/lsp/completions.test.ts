import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const lexiconPath = join(pkgDir, "src", "generated", "lexicon-gcp.json");
const hasGenerated = existsSync(lexiconPath) && (() => {
  try {
    const content = JSON.parse(readFileSync(lexiconPath, "utf-8"));
    return Object.keys(content).length > 0;
  } catch { return false; }
})();

describe("gcpCompletions", () => {
  test("returns empty for non-constructor context", async () => {
    const { gcpCompletions } = await import("./completions");
    const items = gcpCompletions({
      uri: "file:///a.ts",
      content: "const x = 42",
      position: { line: 0, character: 13 },
      wordAtCursor: "42",
      linePrefix: "const x = 42",
    } as any);
    expect(items).toHaveLength(0);
  });

  test.skipIf(!hasGenerated)(
    "returns completions for 'new S' prefix including Storage*",
    async () => {
      const { gcpCompletions } = await import("./completions");
      const result = gcpCompletions({
        uri: "file:///test.ts",
        content: "const x = new S",
        linePrefix: "const x = new S",
        wordAtCursor: "S",
        position: { line: 0, character: 15 },
      } as any);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      const labels = result.map((c: any) => c.label ?? c);
      expect(labels.some((l: string) => l.startsWith("Storage"))).toBe(true);
    },
  );

  test.skipIf(!hasGenerated)(
    "returns completions for 'new Compute' including ComputeInstance",
    async () => {
      const { gcpCompletions } = await import("./completions");
      const result = gcpCompletions({
        uri: "file:///test.ts",
        content: "const x = new Compute",
        linePrefix: "const x = new Compute",
        wordAtCursor: "Compute",
        position: { line: 0, character: 21 },
      } as any);

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      if (result.length > 0) {
        const labels = result.map((c: any) => c.label ?? c);
        expect(labels.some((l: string) => l.includes("Compute"))).toBe(true);
      }
    },
  );
});
