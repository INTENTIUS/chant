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

describe("gcpHover", () => {
  test("returns undefined for unknown word", async () => {
    const { gcpHover } = await import("./hover");
    const info = gcpHover({
      uri: "file:///a.ts",
      content: "xyz",
      position: { line: 0, character: 1 },
      word: "NotAResource12345",
      lineText: "xyz",
    } as any);
    expect(info).toBeUndefined();
  });

  test.skipIf(!hasGenerated)(
    "returns hover info for StorageBucket",
    async () => {
      const { gcpHover } = await import("./hover");
      const result = gcpHover({
        word: "StorageBucket",
        position: { line: 0, character: 0 },
      } as any);

      expect(result).toBeDefined();
      if (result) {
        expect(typeof result).toBe("object");
      }
    },
  );

  test.skipIf(!hasGenerated)(
    "returns hover info for ComputeInstance",
    async () => {
      const { gcpHover } = await import("./hover");
      const result = gcpHover({
        word: "ComputeInstance",
        position: { line: 0, character: 0 },
      } as any);

      expect(result).toBeDefined();
    },
  );

  test.skipIf(!hasGenerated)("returns undefined for empty string", async () => {
    const { gcpHover } = await import("./hover");
    const result = gcpHover({
      word: "",
      position: { line: 0, character: 0 },
    } as any);

    expect(result).toBeUndefined();
  });
});
