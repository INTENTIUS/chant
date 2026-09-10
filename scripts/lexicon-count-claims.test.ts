import { describe, test, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LEXICONS_DIR = join(ROOT, "lexicons");
const DOCS_DIR = join(ROOT, "docs", "src", "content", "docs");

/** Every top-level directory under lexicons/ — the ground truth a prose count is checked against. */
function actualLexiconCount(): number {
  return readdirSync(LEXICONS_DIR).filter((name) => statSync(join(LEXICONS_DIR, name)).isDirectory()).length;
}

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];

function walkMdx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMdx(full));
    else if (entry.name.endsWith(".mdx")) out.push(full);
  }
  return out;
}

interface Claim {
  file: string;
  line: number;
  word: string;
  count: number;
  text: string;
}

/**
 * "<number word> (lexicons? )?ship today" is the recurring phrasing the docs
 * use to assert the total lexicon count in prose (`index.mdx`,
 * `comparison.mdx`). Anchoring on "ship today" rather than on "lexicon" keeps
 * this from also matching unrelated counts (skills, docs sites, corpus size)
 * that happen to sit near the word "lexicon" elsewhere in the docs.
 */
const CLAIM_PATTERN = /\b([A-Za-z]+)\s+(?:lexicons\s+)?ship\s+today\b/gi;

function findClaims(): Claim[] {
  const claims: Claim[] = [];
  for (const file of walkMdx(DOCS_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      for (const m of text.matchAll(CLAIM_PATTERN)) {
        const word = m[1].toLowerCase();
        const count = NUMBER_WORDS.indexOf(word);
        if (count < 0) continue; // not a number word (e.g. "they ship today")
        claims.push({ file, line: i + 1, word, count, text: text.trim() });
      }
    });
  }
  return claims;
}

/**
 * chant #2316 — `comparison.mdx` and `index.mdx` both asserted "Sixteen ...
 * ship today" and both omitted terraform from the lexicon list next to it.
 * `lexicons/overview.mdx` carries the authoritative table (seventeen rows)
 * and was correct; the two prose counts had drifted from it independently,
 * which is exactly the failure mode a directory-listing check catches.
 *
 * This does not check that every lexicon is *named* in the surrounding
 * sentence — the prose uses display names ("Kubernetes", "Forgejo Actions")
 * that do not map cleanly onto directory names, so a name-membership check
 * would be either fragile or would have to hardcode the mapping. The count
 * is the part that is cheap and unambiguous to check by machine; catching
 * that a specific lexicon was dropped from a list while the count still
 * happened to be right is left to review.
 */
const claims = findClaims();

describe("lexicon count claims in the docs match lexicons/ (#2316)", () => {
  test("at least one claim is found", () => {
    // Sanity on the scan itself, same shape as examples/readme-counts.test.ts:
    // a rewording that drops out of CLAIM_PATTERN would silently zero out
    // coverage rather than fail loudly.
    expect(claims.length).toBeGreaterThan(0);
  });

  for (const claim of claims) {
    const label = `${claim.file.replace(`${ROOT}/`, "")}:${claim.line}`;
    test(label, () => {
      const actual = actualLexiconCount();
      expect(
        claim.count,
        `${label} says "${claim.word}" (${claim.count}) but lexicons/ has ${actual} directories:\n  ${claim.text}`,
      ).toBe(actual);
    });
  }
});
