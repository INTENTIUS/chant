import { describe, test, expect } from "vitest";
import { LexiconIndex, lexiconCompletions, type LexiconEntry } from "./lexicon-providers";
import type { CompletionContext } from "./types";

function resourceEntry(resourceType: string): LexiconEntry {
  return { resourceType, kind: "resource", lexicon: "test" };
}

/**
 * Index with 80 "Sample*" resources plus a common "StorageBucket" inserted
 * LAST — so in raw index order it lands well past the old 50-item cap. This is
 * the shape that made gcp v1.152 drop StorageBucket from a "new S" completion.
 */
function largeSPrefixIndex(): LexiconIndex {
  const entries: Record<string, LexiconEntry> = {};
  for (let i = 0; i < 80; i++) {
    entries[`Sample${String(i).padStart(3, "0")}`] = resourceEntry(`Test::Sample::N${i}`);
  }
  entries["StorageBucket"] = resourceEntry("Test::Storage::Bucket");
  return new LexiconIndex(entries);
}

const newCtx = (linePrefix: string, wordAtCursor: string): CompletionContext =>
  ({
    uri: "file:///t.ts",
    content: linePrefix,
    linePrefix,
    wordAtCursor,
    position: { line: 0, character: linePrefix.length },
  }) as unknown as CompletionContext;

describe("lexiconCompletions resource ranking (#600)", () => {
  test("a prefix returns every match — a common resource isn't truncated by a cap", () => {
    const items = lexiconCompletions(newCtx("const x = new S", "S"), largeSPrefixIndex(), "Test resource");
    const labels = items.map((i) => i.label);
    // 81 resources start with "S"; StorageBucket (inserted 81st, past the old
    // slice(0,50)) must still be present.
    expect(labels).toContain("StorageBucket");
    expect(labels.length).toBe(81);
  });

  test("results are sorted deterministically (alphabetical)", () => {
    const labels = lexiconCompletions(newCtx("const x = new S", "S"), largeSPrefixIndex(), "Test resource").map(
      (i) => i.label,
    );
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test("the unfiltered `new ` dump stays capped at 100", () => {
    const entries: Record<string, LexiconEntry> = {};
    for (let i = 0; i < 200; i++) entries[`R${String(i).padStart(3, "0")}`] = resourceEntry(`T::R::${i}`);
    const items = lexiconCompletions(newCtx("const x = new ", ""), new LexiconIndex(entries), "Test resource");
    expect(items.length).toBe(100);
  });
});
