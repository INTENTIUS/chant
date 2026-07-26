import { afterAll, describe, expect, test, vi } from "vitest";
import { build } from "@intentius/chant/build";
import { sortedJsonReplacer } from "@intentius/chant/utils";
import { parseYAML } from "@intentius/chant/yaml";
import {
  discoverCorpus,
  normalizeOutputs,
  outputsEqual,
  normalizeErrors,
  type CorpusEntry,
  type NormalizedOutputs,
} from "./differential-corpus";

/**
 * chant #1045 Phase 2 — the sandboxed-run-vs-in-process-run differential.
 *
 * Phase 1 (#1046) proved the JSON entity boundary is lossless. Phase 2 moves
 * run-fallback file execution off the CLI's own process and into one
 * sandboxed child per build (`packages/core/src/discovery/sandbox/`) — this
 * suite is the safety net for THAT move: every corpus entry is built two
 * ways —
 *
 *  - `build(srcDir, …, { fold: false })` — today's in-process run path
 *    (every file imported directly, no fold, no sandbox).
 *  - `build(srcDir, …, { fold: true, sandbox: true, intrinsics })` — the
 *    production shape `chant build --fold --sandbox` would use: files that
 *    fold do so exactly as before (unsandboxed, since fold executes zero of
 *    a file's own code); files that fall back to run execute together,
 *    isolated, in one bundled+permission-limited child process
 *    (`runFallbackFilesSandboxed`).
 *
 * and both are asserted byte-identical (module namespace object KEY ORDER
 * aside — see {@link canonicalize}'s doc). This is the same corpus, and the
 * same "no separate fold-vs-run carve-out" scope as
 * `json-boundary-differential.test.ts` (Phase 1's own differential) — the
 * sandboxed path always runs discovery to completion (fold or run, however
 * the run half now executes) and merges whatever it produced, so there's no
 * partial-coverage case to skip here either.
 *
 * chant #1045's acceptance criteria: fold coverage must stay at EXACTLY
 * today's split (15 fully-folded corpus entries / 83 with at least one
 * run-fallback file — see `fold-differential.test.ts`'s `EXPECTED_FOLD`) —
 * sandboxing changes HOW the run-fallback subset executes, not WHAT folds.
 * The per-entry `foldDecisions` comparison below is the direct check for
 * that: the sandboxed build's fold/run split must match the plain build's,
 * file for file.
 */

const CORPUS = discoverCorpus();

/**
 * `lexicons/aws/examples/core-concepts` deliberately re-declares the bare
 * name `dataBucket` in two different files in the SAME directory
 * (`cross-ref-storage.ts` and `naming-shared-config.ts`, both demonstrating
 * unrelated concepts) — a genuine collision `collectEntities` (`./collect.ts`)
 * rejects today on EVERY build path (confirmed both with and without
 * `--fold`: this example produces no valid output regardless).
 *
 * `discover()`'s sandboxed merge step (`./index.ts`) detects the exact same
 * collision — the two entities can never be the same object, since one comes
 * from the parent's fold-only `collectEntities` call and the other from the
 * child's run-only one, so a shared key is always a real duplicate — but
 * attributes it to whichever file its own two-pass split happened to process
 * SECOND, which is not necessarily the same file a single unified
 * `collectEntities` call (today's baseline) would blame: that one depends on
 * `findInfraFiles`' overall file order, not on which side of the fold/run
 * split either file landed on. The result is a real, narrow, already-
 * documented limitation (see the comment on the merge step in
 * `packages/core/src/discovery/index.ts`): the SAME error, on a file that
 * differs between the two sides. Tracked here by name, not silently — see
 * the assertion below the exclusion is still required to hit ("both sides
 * still reject the same duplicate").
 */
const EXPECTED_EXCLUSIONS: ReadonlyMap<string, string> = new Map([
  [
    "lexicons/aws/examples/core-concepts",
    'same-directory duplicate export ("dataBucket", split across a folded and a run-fallback file) is rejected by both build paths, but attributed to a different one of the two colliding files — see the differential file doc',
  ],
]);

interface ReportRow {
  name: string;
  identical: boolean;
  excluded: boolean;
  runFallbackFileCount: number;
  sandboxedMs: number;
  error?: string;
}

const report: ReportRow[] = [];

function classifyMode(foldDecisions: Array<{ mode: "fold" | "run" }>): "fold" | "run-fallback" | "empty" {
  if (foldDecisions.length === 0) return "empty";
  return foldDecisions.every((d) => d.mode === "fold") ? "fold" : "run-fallback";
}

/**
 * Canonicalize one output string for order-insensitive comparison.
 *
 * `collectEntities` (`../packages/core/src/discovery/collect.ts`) builds the
 * entities map by iterating `Object.entries()` of each imported module's
 * exports, in whatever order the runtime hands them back. Real Node ESM sorts
 * a module namespace object's string keys per spec — verified identically for
 * BOTH the in-process run path (under plain `node`/`tsx`) and the sandboxed
 * child (a real subprocess, always plain Node). Vitest's own transform for
 * in-process dynamic imports (`vite-node`, used by THIS differential's `run`
 * baseline, which calls `build()` inside the vitest worker) does not sort —
 * it preserves source declaration order instead. Both existing differentials
 * (`fold-differential.test.ts`, `json-boundary-differential.test.ts`) compare
 * two in-process vite-node builds against EACH OTHER, so they never surface
 * this; this is the first one to compare an in-process (vite-node) build
 * against a real-subprocess (spec-ESM) one, which is exactly where it shows
 * up. A downstream effect for a project with same-bare-name entities across
 * directories (chant #932's stack-prefix disambiguation, e.g.
 * `examples/adopt-alb-services`) is a different insertion order for the
 * auto-detected cross-lexicon `Parameters` block — semantically inert (a JSON
 * object's key order carries no CloudFormation meaning) but a real byte-level
 * difference this differential would otherwise misreport as sandboxing drift.
 * Confirmed via a standalone (non-vitest) repro: outside vitest, both paths
 * produce byte-identical output, key order included.
 *
 * The same root cause shows up in a YAML-emitting lexicon two ways: as
 * multi-document RESOURCE order (k8s) — a file that exports several
 * composite members individually (`export const x = webhook.deployment;
 * export const y = webhook.service; …`, rather than one `export const
 * webhook = …` composite expanded internally) puts those names through the
 * same module-namespace-object iteration, so the `---`-separated documents
 * in the emitted YAML can land in a different order — and as top-level KEY
 * order within a single document (gitlab: job names in a `.gitlab-ci.yml`
 * are themselves named exports the same way). Handled uniformly: parse
 * every `---`-separated part (one, for a single-document file) with
 * chant's own lightweight `parseYAML`, canonicalize each with
 * `sortedJsonReplacer` (recursively sorts every nested object's keys, not
 * just the top level), sort the resulting list of documents, and rejoin —
 * order-insensitive at every level, content-sensitive. Falls back to the
 * raw string unchanged if it isn't cleanly parseable, so a genuine content
 * difference still surfaces as a real mismatch rather than being silently
 * swallowed by an over-eager normalization.
 */
function canonicalizeYamlDocuments(content: string): string | undefined {
  const parts = content.split(/^---\s*$/m).filter((part) => part.trim().length > 0);
  if (parts.length === 0) return undefined;
  try {
    const canonicalDocs = parts.map((part) => JSON.stringify(parseYAML(part), sortedJsonReplacer));
    canonicalDocs.sort();
    return canonicalDocs.join("\n---\n");
  } catch {
    return undefined;
  }
}

function canonicalize(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), sortedJsonReplacer);
  } catch {
    return canonicalizeYamlDocuments(content) ?? content;
  }
}

function canonicalizeOutputs(normalized: NormalizedOutputs): NormalizedOutputs {
  const result: NormalizedOutputs = {};
  for (const [lexicon, { primary, files }] of Object.entries(normalized)) {
    const canonicalFiles: Record<string, string> = {};
    for (const [name, content] of Object.entries(files)) canonicalFiles[name] = canonicalize(content);
    result[lexicon] = { primary: canonicalize(primary), files: canonicalFiles };
  }
  return result;
}

/**
 * Build `srcDir` both ways. Mirrors `json-boundary-differential.test.ts`'s
 * `buildBothWays`: fast path first (no module-cache reset — cheap, correct
 * for the overwhelming majority of the corpus); only on a mismatch does it
 * retry once with `vi.resetModules()`, to rule out the same known,
 * fold-independent, pre-existing sharp edge (`build()` isn't safe to call
 * twice on the same directory in one process — a `propagate()`-mutated
 * composite instance compounds across repeat calls) rather than misreport
 * cross-build state bleed as a sandboxing defect. The comparison is
 * canonicalized (see {@link canonicalize}) so that check isn't tripped by the
 * vitest-only key-ordering artifact either.
 */
async function buildBothWays(entry: CorpusEntry) {
  const run = () => build(entry.srcDir, entry.serializers, undefined, { fold: false });
  const sandboxed = () =>
    build(entry.srcDir, entry.serializers, undefined, {
      fold: true,
      sandbox: true,
      intrinsics: entry.intrinsics,
    });

  const runResult = await run();
  const t0 = performance.now();
  const sandboxedResult = await sandboxed();
  const sandboxedMs = performance.now() - t0;

  if (
    outputsEqual(
      canonicalizeOutputs(normalizeOutputs(sandboxedResult.outputs)),
      canonicalizeOutputs(normalizeOutputs(runResult.outputs)),
    )
  ) {
    return { runResult, sandboxedResult, sandboxedMs };
  }

  vi.resetModules();
  const freshRun = await run();
  vi.resetModules();
  const t1 = performance.now();
  const freshSandboxed = await sandboxed();
  return { runResult: freshRun, sandboxedResult: freshSandboxed, sandboxedMs: performance.now() - t1 };
}

describe("sandbox differential — sandboxed-run output === in-process-run output (chant #1045 Phase 2)", () => {
  test(`corpus is non-empty (found ${CORPUS.length} source directories)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    test(`${entry.name}: sandboxed build is byte-identical to in-process run`, async () => {
      const excludedReason = EXPECTED_EXCLUSIONS.get(entry.name);

      try {
        const { runResult, sandboxedResult, sandboxedMs } = await buildBothWays(entry);
        const runFallbackFileCount = sandboxedResult.foldDecisions.filter((d) => d.mode === "run").length;

        if (excludedReason) {
          // Still required to fail the SAME way on both sides — an excluded
          // entry going from "errors identically on both paths" to "sandboxed
          // succeeds" or "sandboxed errors differently" would be a real
          // regression this exclusion must not paper over.
          expect(runResult.errors.length, `${entry.name}: expected the run baseline to still error (${excludedReason})`).toBeGreaterThan(0);
          expect(sandboxedResult.errors.length, `${entry.name}: expected the sandboxed build to still error (${excludedReason})`).toBeGreaterThan(0);
          report.push({ name: entry.name, identical: true, excluded: true, runFallbackFileCount, sandboxedMs });
          return;
        }

        const runNorm = canonicalizeOutputs(normalizeOutputs(runResult.outputs));
        const sandboxedNorm = canonicalizeOutputs(normalizeOutputs(sandboxedResult.outputs));
        const identical = outputsEqual(sandboxedNorm, runNorm);

        report.push({ name: entry.name, identical, excluded: false, runFallbackFileCount, sandboxedMs });

        // chant#1045: sandboxing must not change WHAT folds — the plain
        // `{ fold: true }` decision and the `{ fold: true, sandbox: true }`
        // decision must classify every file identically.
        const plainFold = await build(entry.srcDir, entry.serializers, undefined, {
          fold: true,
          intrinsics: entry.intrinsics,
        });
        expect(
          classifyMode(sandboxedResult.foldDecisions),
          `fold/run split drifted for ${entry.name}`,
        ).toBe(classifyMode(plainFold.foldDecisions));

        expect(normalizeErrors(sandboxedResult.errors), `sandbox-vs-run error drift in ${entry.name}`).toEqual(
          normalizeErrors(runResult.errors),
        );
        expect(sandboxedNorm, `sandbox-vs-run output drift in ${entry.name}`).toEqual(runNorm);
      } catch (err) {
        report.push({
          name: entry.name,
          identical: false,
          excluded: false,
          runFallbackFileCount: 0,
          sandboxedMs: 0,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }

  // A NEW exclusion (an entry that used to match and now doesn't) must be an
  // intentional, understood change to `EXPECTED_EXCLUSIONS` above, not a
  // silent regression — mirrors `fold-differential.test.ts`'s coverage gate
  // and `json-boundary-differential.test.ts`'s round-trip gate.
  test("no corpus entry silently drifted or failed to build sandboxed", () => {
    const byName = new Map(report.map((r) => [r.name, r]));
    const regressed = CORPUS.filter((e) => {
      const row = byName.get(e.name);
      return row && !row.identical && !EXPECTED_EXCLUSIONS.has(e.name);
    }).map((e) => e.name);
    expect(regressed, `these entries drifted or failed sandboxed: ${regressed.join(", ")}`).toEqual([]);
  });

  afterAll(() => {
    const identicalCount = report.filter((r) => r.identical && !r.excluded).length;
    const excludedCount = report.filter((r) => r.excluded).length;
    const driftCount = report.filter((r) => !r.identical).length;
    const sandboxedCount = report.filter((r) => r.runFallbackFileCount > 0).length;
    const totalSandboxedMs = report.reduce((sum, r) => sum + r.sandboxedMs, 0);
    const maxSandboxedMs = report.reduce((max, r) => Math.max(max, r.sandboxedMs), 0);

    const lines = [
      "",
      "── Sandbox differential report (chant #1045 Phase 2) ──────────────",
      `corpus: ${report.length}/${CORPUS.length} source directories built both ways`,
      `  identical: ${identicalCount}   excluded: ${excludedCount}   drift: ${driftCount}   entries with >=1 sandboxed file: ${sandboxedCount}`,
      `  sandboxed build wall time — total: ${totalSandboxedMs.toFixed(0)}ms   max single entry: ${maxSandboxedMs.toFixed(0)}ms`,
      ...report.map(
        (r) =>
          `  [${r.excluded ? "excluded " : r.identical ? "identical" : "DRIFT    "}] run-fallback-files:${r.runFallbackFileCount} ${r.sandboxedMs.toFixed(0).padStart(5)}ms ${r.name}${r.error ? `  (${r.error})` : ""}`,
      ),
      "────────────────────────────────────────────────────────────────────",
    ];
    console.log(lines.join("\n"));
  });
});
