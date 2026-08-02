/**
 * chant #1062 (epic #1019) — the published fold-coverage count and the
 * marker-delimited block it lives in inside
 * `docs/src/content/docs/concepts/typescript-as-data.mdx`.
 *
 * One render function, called from the two places that must never disagree:
 *
 *  - `examples/fold-differential.test.ts`'s own guard test compares this
 *    function's output — built from THAT RUN's already-computed `report`,
 *    no second corpus build — against what's committed in the doc, and
 *    fails with a "run `npm run generate:fold-coverage`" message on drift.
 *    Same shape as `packages/core/src/codegen/post-synth-barrel-guards.test.ts`:
 *    a generated artifact asserted current, not regenerated silently.
 *  - `scripts/generate-fold-coverage.ts` is the one place that pays the cost
 *    of an actual corpus build, on demand, to refresh the committed number
 *    after an intentional fold or corpus change.
 *
 * Deliberately numerator-and-denominator, never a bare percentage: the
 * corpus is chant's own maintained example suite, not a sample of
 * real-world source, and its size and composition can change (an example
 * rewritten into a foldable shape, one added, one dropped) for reasons that
 * have nothing to do with what `chant build --fold` is capable of. "21 of
 * 98" stays legible after a corpus change; "21%" would silently start
 * meaning something else. The surrounding doc prose carries that caveat —
 * this module only owns the number and the block it sits in.
 */

// MDX (unlike plain Markdown) parses `<` as the start of a JSX-like tag, so
// an HTML comment (`<!-- ... -->`) fails to parse where this block lives
// (docs/.../typescript-as-data.mdx is `.mdx`, not `.md`). `{/* ... */}` is
// MDX's own comment form — a JS expression, invisible in the rendered page.
export const FOLD_COVERAGE_START = "{/* GENERATED:fold-coverage:start */}";
export const FOLD_COVERAGE_END = "{/* GENERATED:fold-coverage:end */}";

/** Render the marker-delimited fold-coverage block for `foldCount` of `total` corpus entries. */
export function renderFoldCoverageBlock(foldCount: number, total: number): string {
  const fallbackCount = total - foldCount;
  return [
    FOLD_COVERAGE_START,
    `As of this measurement, **${foldCount} of ${total}** example projects in the corpus fold completely — every file in them reduces to a value with zero module execution. The remaining **${fallbackCount}** have at least one file that falls back to running.`,
    FOLD_COVERAGE_END,
  ].join("\n");
}

/** Extract the current marker-delimited block (markers included) from a doc's raw text. */
export function extractFoldCoverageBlock(doc: string): string {
  const start = doc.indexOf(FOLD_COVERAGE_START);
  const end = doc.indexOf(FOLD_COVERAGE_END);
  if (start === -1 || end === -1) {
    throw new Error(
      `fold-coverage markers not found — expected both "${FOLD_COVERAGE_START}" and "${FOLD_COVERAGE_END}" in the doc`,
    );
  }
  return doc.slice(start, end + FOLD_COVERAGE_END.length);
}

/** Replace the marker-delimited block in `doc` with a freshly rendered one. */
export function replaceFoldCoverageBlock(doc: string, foldCount: number, total: number): string {
  const current = extractFoldCoverageBlock(doc);
  return doc.replace(current, renderFoldCoverageBlock(foldCount, total));
}

/**
 * Every doc that publishes the fold-coverage count, relative to the repo root.
 *
 * More than one page has reason to state it, and the second one is exactly how
 * this drifts: `architecture/sandbox.mdx` carried a hand-typed "55 of 101" for
 * long enough that the generated block next door had moved to 76 of 102 — a
 * generated number and a hand-maintained copy of the same number, side by side,
 * with only the generated one guarded.
 *
 * So the list is the contract: the generator refreshes every entry, and
 * `fold-differential.test.ts` asserts every entry. Adding a page that states
 * the count means adding it here — and forgetting to means the markers simply
 * are not there, which `extractFoldCoverageBlock` reports rather than skips.
 */
export const FOLD_COVERAGE_DOCS = [
  "docs/src/content/docs/concepts/typescript-as-data.mdx",
  "docs/src/content/docs/architecture/sandbox.mdx",
] as const;
