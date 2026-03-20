import { describe, test, expect } from "bun:test";
import { dockerCompletions } from "./completions";
import type { CompletionContext } from "@intentius/chant/lsp/types";

describe("dockerCompletions", () => {
  test("is a function", () => {
    expect(typeof dockerCompletions).toBe("function");
  });

  test("returns array for non-constructor context", () => {
    const ctx: CompletionContext = {
      word: "Ser",
      isConstructorContext: false,
      prefix: "",
      fileContent: "",
      position: { line: 0, character: 3 },
    };
    // May return [] if generated index not present, but should not throw
    const result = dockerCompletions(ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  test("returns array for constructor context", () => {
    const ctx: CompletionContext = {
      word: "Service",
      isConstructorContext: true,
      prefix: "new ",
      fileContent: "import { Service } from '@intentius/chant-lexicon-docker';",
      position: { line: 0, character: 10 },
    };
    const result = dockerCompletions(ctx);
    expect(Array.isArray(result)).toBe(true);
  });
});
