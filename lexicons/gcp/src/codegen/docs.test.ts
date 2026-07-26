import { describe, test, expect } from "vitest";
import { generateDocs } from "./docs";

describe("generateDocs", () => {
  test("generateDocs function exists and is callable", () => {
    expect(typeof generateDocs).toBe("function");
  });

  // Asserted from the declaration rather than by calling it: generateDocs
  // writes the real docs tree under lexicons/gcp/docs, so invoking it here
  // rewrote tracked .mdx files (index.mdx's "Lexicon version") on every
  // `vitest run` — and did it in a floating promise, off the test's timeline.
  test("generateDocs is async, so it returns a promise", () => {
    expect(generateDocs.constructor.name).toBe("AsyncFunction");
  });
});
