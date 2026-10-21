/**
 * chant #4215: the checks from the example gates that build nothing. They read
 * the directory tree, the docs and the classification lists, so they run in the
 * unit project on every pull request instead of only in release-suites after a
 * merge. A new example with no row on contributing/examples.mdx, or a new corpus
 * entry in neither fold list, fails here before it reaches main.
 *
 * What needs a build stays in the e2e files: root-examples-gate.e2e.test.ts
 * builds and lints each example, and fold-differential.e2e.test.ts checks that
 * each list still matches what folds and that the published count matches the
 * live one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { discoverCorpus } from "./differential-corpus";
import { EXPECTED_FOLD, EXPECTED_RUN_FALLBACK } from "./fold-classification";
import { extractFoldCoverageBlock, FOLD_COVERAGE_DOCS, renderFoldCoverageBlock } from "./fold-coverage";
import { ALLOWLIST, chantProjects, exampleDirectories, namesOnPage } from "./root-examples";

describe("the root-examples allowlist", () => {
  test("names only directories that are there", () => {
    const onDisk = new Set(exampleDirectories());
    const orphans = Object.keys(ALLOWLIST).filter((name) => !onDisk.has(name));
    expect(orphans, `allowlist entries with no directory: ${orphans.join(", ")}`).toEqual([]);
  });

  test("accounts for every directory the gate does not enumerate", () => {
    const enumerated = new Set(chantProjects());
    const unaccounted = exampleDirectories().filter(
      (name) => !enumerated.has(name) && ALLOWLIST[name]?.kind !== "no-config",
    );
    expect(
      unaccounted,
      `directories under examples/ with no chant.config and no allowlist entry: ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  test('carries no "no-config" entry for a directory that has one', () => {
    const enumerated = new Set(chantProjects());
    const stale = Object.entries(ALLOWLIST)
      .filter(([name, entry]) => entry.kind === "no-config" && enumerated.has(name))
      .map(([name]) => name);
    expect(
      stale,
      `these now hold a chant.config and are built by the gate; delete their ALLOWLIST entries: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

describe("docs/src/content/docs/contributing/examples.mdx", () => {
  test("names every example the root-examples gate enumerates", () => {
    const listed = new Set(namesOnPage());
    const missing = chantProjects().filter((name) => !listed.has(name));
    expect(missing, `not listed on contributing/examples.mdx: ${missing.join(", ")}`).toEqual([]);
  });

  test("names nothing that is not on disk", () => {
    const onDisk = new Set(exampleDirectories());
    const stale = [...new Set(namesOnPage())].filter((name) => !onDisk.has(name));
    expect(stale, `listed on contributing/examples.mdx but gone: ${stale.join(", ")}`).toEqual([]);
  });
});

describe("the fold classification lists", () => {
  test("every corpus entry is in EXPECTED_FOLD or EXPECTED_RUN_FALLBACK", async () => {
    const corpus = await discoverCorpus();
    const unclassified = corpus
      .map((e) => e.name)
      .filter((name) => !EXPECTED_FOLD.includes(name) && !EXPECTED_RUN_FALLBACK.has(name));
    expect(
      unclassified,
      "a new corpus entry must be added to EXPECTED_FOLD in examples/fold-classification.ts if it " +
        "folds, or to EXPECTED_RUN_FALLBACK with a one-line reason if it does not " +
        "(`just fold-differential` says which)",
    ).toEqual([]);
  });

  test("no entry is in both lists", () => {
    const both = EXPECTED_FOLD.filter((name) => EXPECTED_RUN_FALLBACK.has(name));
    expect(both, `listed as both folding and falling back: ${both.join(", ")}`).toEqual([]);
  });

  test("every listed name is a corpus entry", async () => {
    const names = new Set((await discoverCorpus()).map((e) => e.name));
    const gone = [...EXPECTED_FOLD, ...EXPECTED_RUN_FALLBACK.keys()].filter((name) => !names.has(name));
    expect(gone, `listed but no longer in the corpus, drop them: ${gone.join(", ")}`).toEqual([]);
  });

  // The e2e differential holds each list to what folds, so with every entry
  // classified the fold count is EXPECTED_FOLD's length and the total is the
  // corpus size. The published block must state those numbers.
  test.each([...FOLD_COVERAGE_DOCS])("%s publishes the count the lists give", async (relPath) => {
    const total = (await discoverCorpus()).length;
    const doc = readFileSync(join(import.meta.dirname, "..", relPath), "utf8");
    expect(
      extractFoldCoverageBlock(doc),
      `the published fold coverage is not ${EXPECTED_FOLD.length} of ${total}: run \`npm run generate:fold-coverage\` and commit ${relPath}`,
    ).toBe(renderFoldCoverageBlock(EXPECTED_FOLD.length, total));
  });
});
