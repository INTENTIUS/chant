import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const hasGenerated = existsSync(join(pkgDir, "src", "generated", "lexicon-helm.json"));

describe.skipIf(!hasGenerated)("helmHover", () => {
  test("returns hover info for Chart", async () => {
    const { helmHover } = await import("./hover");
    const info = helmHover({ uri: "file:///test.ts", content: "", position: { line: 0, character: 0 }, word: "Chart", lineText: "" });

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Chart");
    expect(info!.contents).toContain("Helm::Chart");
  });

  test("shows resource kind for resource types", async () => {
    const { helmHover } = await import("./hover");
    const info = helmHover({ uri: "file:///test.ts", content: "", position: { line: 0, character: 0 }, word: "Values", lineText: "" });

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Resource");
  });

  test("returns undefined for unknown word", async () => {
    const { helmHover } = await import("./hover");
    const info = helmHover({ uri: "file:///test.ts", content: "", position: { line: 0, character: 0 }, word: "NotARealResource12345", lineText: "" });
    expect(info).toBeUndefined();
  });

  test("returns undefined for empty word", async () => {
    const { helmHover } = await import("./hover");
    const info = helmHover({ uri: "file:///test.ts", content: "", position: { line: 0, character: 0 }, word: "", lineText: "" });
    expect(info).toBeUndefined();
  });

  test("returns info for HelmHook property type", async () => {
    const { helmHover } = await import("./hover");
    const info = helmHover({ uri: "file:///test.ts", content: "", position: { line: 0, character: 0 }, word: "HelmHook", lineText: "" });

    expect(info).toBeDefined();
    expect(info!.contents).toContain("Helm::Hook");
  });
});
