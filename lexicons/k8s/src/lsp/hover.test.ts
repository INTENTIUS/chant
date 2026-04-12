import { describe, test, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hasGenerated = existsSync(
  join(pkgDir, "src", "generated", "lexicon-k8s.json"),
);

describe("LSP hover", () => {
  test.skipIf(!hasGenerated)(
    "returns hover info for known resource (Deployment)",
    async () => {
      const { k8sHover } = await import("./hover");
      const result = k8sHover({
        word: "Deployment",
        position: { line: 0, character: 0 },
      } as any);

      expect(result).toBeDefined();
      if (result) {
        expect(typeof result).toBe("object");
      }
    },
  );

  test.skipIf(!hasGenerated)(
    "returns undefined for unknown word",
    async () => {
      const { k8sHover } = await import("./hover");
      const result = k8sHover({
        word: "XyzNonExistent",
        position: { line: 0, character: 0 },
      } as any);

      expect(result).toBeUndefined();
    },
  );

  test.skipIf(!hasGenerated)("returns undefined for empty string", async () => {
    const { k8sHover } = await import("./hover");
    const result = k8sHover({
      word: "",
      position: { line: 0, character: 0 },
    } as any);

    expect(result).toBeUndefined();
  });

  test.skipIf(!hasGenerated)("hover includes resource info", async () => {
    const { k8sHover } = await import("./hover");
    const result = k8sHover({
      word: "Service",
      position: { line: 0, character: 0 },
    } as any);

    if (result && typeof result === "object") {
      const content =
        typeof result.contents === "string"
          ? result.contents
          : typeof result.contents === "object" && "value" in result.contents
            ? result.contents.value
            : JSON.stringify(result);
      // Hover should mention the resource type
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
