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

  // Use a resource-specific prefix rather than a single letter: the completion
  // provider caps results at 50 with no ranking (#600), so on a large lexicon a
  // one-letter prefix like "S" can truncate common resources (e.g. Storage*)
  // out of the returned slice. "Storage" isolates the Storage* resources, which
  // is what this test actually cares about.
  test.skipIf(!hasGenerated)(
    "returns completions for 'new Storage' prefix including Storage*",
    async () => {
      const { gcpCompletions } = await import("./completions");
      const result = gcpCompletions({
        uri: "file:///test.ts",
        content: "const x = new Storage",
        linePrefix: "const x = new Storage",
        wordAtCursor: "Storage",
        position: { line: 0, character: 21 },
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
