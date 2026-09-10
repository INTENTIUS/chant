import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * fold-depth-bound-claims.test.ts — chant #2367.
 *
 * `concepts/typescript-as-data.mdx`'s "Fold depth bounds" table states the
 * value of `MAX_FUNCTION_CALL_DEPTH` (`packages/core/src/fold/fold.ts`),
 * `MAX_INTERPRETATION_DEPTH`, and `MAX_RESOLUTION_DEPTH` (both
 * `packages/core/src/discovery/fold-import.ts`) in prose. Nothing stops that
 * prose from drifting the moment one of the three constants changes in
 * source — the same class of problem `scripts/lexicon-count-claims.test.ts`
 * (#2316) exists to catch for a different claim. This is that guard for the
 * depth bounds: read each constant straight out of its source file, read the
 * doc's own table, and assert the two agree.
 *
 * Deliberately NOT a generated block (unlike `### Fold coverage today`'s
 * `{/* GENERATED:... *\/}` markers a few sections up): these three numbers
 * only change when someone edits a `const` declaration in `fold.ts` or
 * `fold-import.ts`, which is exactly the moment this test is designed to
 * catch — a hand-maintained doc row read back against ground truth, not a
 * value chant re-derives on every build.
 */

const ROOT = join(import.meta.dirname, "..");
const DOC_PATH = join(ROOT, "docs", "src", "content", "docs", "concepts", "typescript-as-data.mdx");
const FOLD_TS_PATH = join(ROOT, "packages", "core", "src", "fold", "fold.ts");
const FOLD_IMPORT_TS_PATH = join(ROOT, "packages", "core", "src", "discovery", "fold-import.ts");

const doc = readFileSync(DOC_PATH, "utf8");
const foldTs = readFileSync(FOLD_TS_PATH, "utf8");
const foldImportTs = readFileSync(FOLD_IMPORT_TS_PATH, "utf8");

/** The three bounds this guard checks, and which source file each is declared in. */
const BOUNDS = [
  { name: "MAX_FUNCTION_CALL_DEPTH", source: foldTs, sourceLabel: "packages/core/src/fold/fold.ts" },
  {
    name: "MAX_INTERPRETATION_DEPTH",
    source: foldImportTs,
    sourceLabel: "packages/core/src/discovery/fold-import.ts",
  },
  { name: "MAX_RESOLUTION_DEPTH", source: foldImportTs, sourceLabel: "packages/core/src/discovery/fold-import.ts" },
] as const;

/** The exact `const <NAME> = <number>;` declaration — fails loudly if the constant is renamed, removed, or no longer a numeric literal. */
function actualValue(name: string, source: string, sourceLabel: string): number {
  const m = source.match(new RegExp(`const ${name} = (\\d+);`));
  if (!m) {
    throw new Error(
      `fold-depth-bound-claims: "${name}" not found as \`const ${name} = <number>;\` in ${sourceLabel} — was it renamed, removed, or rewritten to a non-literal? Update this test to match.`,
    );
  }
  return Number(m[1]);
}

/** The doc's own claimed value — a `| \`<NAME>\` | <number> |` row in the "Fold depth bounds" table. */
function claimedValue(name: string): number {
  const m = doc.match(new RegExp(`\\| \`${name}\` \\| (\\d+) \\|`));
  if (!m) {
    throw new Error(
      `fold-depth-bound-claims: no "| \`${name}\` | <number> |" row found in ${DOC_PATH} — was the "Fold depth bounds" table renamed or reformatted? Update this test to match.`,
    );
  }
  return Number(m[1]);
}

describe("fold depth bound claims in typescript-as-data.mdx match source (#2367)", () => {
  for (const bound of BOUNDS) {
    test(bound.name, () => {
      const actual = actualValue(bound.name, bound.source, bound.sourceLabel);
      const claimed = claimedValue(bound.name);
      expect(
        claimed,
        `docs/.../typescript-as-data.mdx claims ${bound.name} is ${claimed}, but ${bound.sourceLabel} declares \`const ${bound.name} = ${actual};\``,
      ).toBe(actual);
    });
  }
});
