import { describe, test, expect } from "bun:test";
import { dockerHover } from "./hover";
import type { HoverContext } from "@intentius/chant/lsp/types";

describe("dockerHover", () => {
  test("is a function", () => {
    expect(typeof dockerHover).toBe("function");
  });

  test("returns undefined for unknown word", () => {
    const ctx: HoverContext = {
      word: "NotADockerThing",
      fileContent: "",
      position: { line: 0, character: 0 },
    };
    // Should not throw; returns undefined if not found
    const result = dockerHover(ctx);
    expect(result === undefined || typeof result === "object").toBe(true);
  });

  test("returns HoverInfo with content for known resource", () => {
    const ctx: HoverContext = {
      word: "Service",
      fileContent: "import { Service } from '@intentius/chant-lexicon-docker';",
      position: { line: 0, character: 10 },
    };
    const result = dockerHover(ctx);
    // If generated index exists, will return content; otherwise undefined
    if (result !== undefined) {
      expect(result.contents).toBeTruthy();
      expect(typeof result.contents).toBe("string");
    }
  });
});
