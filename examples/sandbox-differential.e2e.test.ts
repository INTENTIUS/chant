import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { sortedJsonReplacer } from "@intentius/chant/utils";
import { parseYAML } from "@intentius/chant/yaml";
import {
  discoverCorpus,
  loadBuild,
  normalizeOutputs,
  outputsEqual,
  normalizeErrors,
  type CorpusEntry,
  type NormalizedOutputs,
  entryBuildParams,
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
 * chant #1045's acceptance criteria said fold coverage must stay at EXACTLY
 * the plain-`--fold` split — sandboxing changes HOW the run-fallback subset
 * executes, not WHAT folds — and the per-entry `foldDecisions` comparison
 * below checked it file for file.
 *
 * chant #1093 changes that on purpose. Fold executes none of a file's own
 * top-level code, but it does import and invoke the module behind a composite
 * factory / resource constructor / intrinsic tag, so a file reported as
 * "folded" could still execute PROJECT code in the CLI's process. Under
 * `--sandbox` those imports are now refused and the file demotes to the
 * (sandboxed) run path instead. So the invariant here is no longer equality
 * but a one-way refinement: every file the plain build runs, the sandboxed
 * build also runs; the sandboxed build may run MORE. The demotion is
 * measured and reported per entry (see the report at the bottom), and output
 * must still be byte-identical to the in-process run — which is the check
 * that actually matters, since a demoted file's factory runs in the child
 * with the same arguments and must produce the same spec.
 */

/**
 * chant #1020 hang fix, follow-up — this file's own default `testTimeout`
 * (20s, `vitest.config.ts`) is too tight for ONE specific corpus entry,
 * `lexicons/github/examples/deploy-pages`, and ONLY on a full `just test`
 * run (never reproduces running this file alone). Root-caused, not guessed:
 * instrumenting every `import()` `discover()` makes for the `run()` (fold:
 * false) build showed a single ~8s (locally) / ~33s (CI, slower hardware)
 * outlier for `deploy-pages`'s own `pipeline.ts` — every OTHER corpus
 * entry's first real import of ITS OWN lexicon package, including much
 * larger ones (`aws`, 242 files; `gcp`), stayed under 60ms. Bisecting which
 * PRECEDING entries were required to reproduce it (by slicing `CORPUS` to
 * start at different points) isolated the trigger to one specific earlier
 * entry: `examples/bedrock-agentcore-agent`, which has its OWN, unrelated,
 * pre-existing run-vs-sandboxed output mismatch (confirmed present on
 * `main` too) that makes `buildBothWays` below hit its `vi.resetModules()`
 * retry path. That retry is fast in isolation on both branches — the
 * problem is a LATER, unrelated import (github lexicon, 25 entries after)
 * paying for it, confirmed by A/B: instrumenting `main` the identical way
 * never shows a slow import anywhere in the corpus, while this branch shows
 * exactly one, always at `deploy-pages`, never anywhere else. That points
 * to `vi.resetModules()` leaving a lasting cost in vite-node's own SSR
 * module graph that a later cold import can pay for — not a resolveModulePath
 * gap (confirmed: `fastResolveBareSpecifier` in `../packages/core/src/
 * discovery/fold-import.ts` never misses for ANY package across the whole
 * corpus, checked directly). #1020's cross-file resolution reaching more
 * files' own real imports across the corpus (even after this PR's caching)
 * is almost certainly what tips vite-node's accumulated graph size over
 * whatever threshold makes that lingering cost land somewhere — `main`
 * has the same reset, just a smaller graph to carry after it. Scoped here,
 * not raised in `vitest.config.ts`: this is specific to a differential that
 * deliberately builds every corpus entry twice (sometimes four times, on a
 * mismatch retry) through real `vi.resetModules()` cycles other suites
 * don't exercise at this scale; a global bump would mask a genuinely hung
 * test everywhere else for no reason tied to this file's own behavior.
 */
vi.setConfig({ testTimeout: 60_000 });

const CORPUS = await discoverCorpus();

/**
 * Known, understood entries where sandboxed and in-process output are
 * allowed to differ (or to agree-by-both-erroring) instead of matching
 * byte-for-byte — mirrors `fold-differential.test.ts`'s `EXPECTED_FOLD` and
 * `json-boundary-differential.test.ts`'s round-trip gate. Empty today.
 *
 * `lexicons/aws/examples/core-concepts` used to need an entry here:
 * it re-declared the bare name `dataBucket` in two different files in the
 * same directory (`cross-ref-storage.ts` and `naming-shared-config.ts`,
 * demonstrating unrelated concepts), a genuine collision `collectEntities`
 * (`./collect.ts`) rejected on every build path. `discover()`'s sandboxed
 * merge step (`./index.ts`) detected the exact same collision but attributed
 * it to whichever file its own two-pass split happened to process SECOND,
 * not necessarily the same file a single unified `collectEntities` call
 * would blame — the same error, on a file that differs between the two
 * sides. chant #1067 fixed the underlying collision (renamed the unrelated
 * `naming-shared-config.ts` export to `sharedDataBucket`) rather than
 * leaving a shipped example broken, which removed the only corpus entry
 * that exercised this narrow attribution difference. No exclusion needed
 * until a new one demonstrates it.
 */
const EXPECTED_EXCLUSIONS: ReadonlyMap<string, string> = new Map([]);

interface ReportRow {
  name: string;
  identical: boolean;
  excluded: boolean;
  runFallbackFileCount: number;
  sandboxedMs: number;
  /** chant #1093 — how this entry classifies under plain `{ fold: true }`. */
  plainMode?: "fold" | "run-fallback" | "empty";
  /** chant #1093 — and under `{ fold: true, sandbox: true }`. A "fold" -> "run-fallback" pair is a demotion: the entry folds in-process but needs the child under `--sandbox`. */
  sandboxMode?: "fold" | "run-fallback" | "empty";
  /** chant #1093 — files this entry folds plainly but runs (in the child) under `--sandbox`. */
  demotedFileCount?: number;
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

/**
 * chant #1728 — every `process.env` read under `srcDir`, as `file:line`.
 *
 * The sandboxed child sees no ambient environment by design; the in-process
 * baseline sees the real one. A corpus entry that reads `process.env` in
 * project source therefore drifts exactly when the variable is exported in
 * the shell running the suite — and agrees only when it is not, which is a
 * differential of two builds nobody deploys. That is not a sandbox defect,
 * so a mismatch on such an entry is reported as the read it is (see the
 * pointed error in the test body) rather than as output drift. The fix is
 * always the same: declare the value in `chant.config.ts`'s `buildParams`
 * (with an `env:` mapping) and read it as `params.<name>`, which both sides
 * resolve through the same channel.
 *
 * Text scan, not AST: it cites Lambda-handler reads inside function bodies
 * too (`lexicons/aws/examples/lambda-*`), which never execute at build time.
 * That is fine — this list only turns into a failure message once an entry
 * has ALREADY drifted, where a false citation costs a sentence, never a
 * false failure.
 */
function ambientEnvReads(srcDir: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name !== "node_modules") walk(path);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(dirent.name)) continue;
      readFileSync(path, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          if (/\bprocess\.env\b/.test(line)) hits.push(`${relative(srcDir, path)}:${i + 1}`);
        });
    }
  };
  walk(srcDir);
  return hits;
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
  // chant #1112 — `build` is loaded per call, never captured once at module
  // scope, so the in-process baseline is always produced by the same
  // chant-core copy the project files were just loaded into. See
  // {@link loadBuild} for what a stale one silently drops.
  const buildParams = await entryBuildParams(entry);
  const run = async () =>
    (await loadBuild())(entry.srcDir, entry.serializers, undefined, { fold: false, buildParams });
  const sandboxed = async () =>
    (await loadBuild())(entry.srcDir, entry.serializers, undefined, {
      fold: true,
      sandbox: true,
      intrinsics: entry.intrinsics,
      lexicons: entry.lexicons,
      buildParams,
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

        // chant#1093: sandboxing may only DEMOTE (fold -> run), never
        // promote. Every file the plain `{ fold: true }` build runs must
        // still run under `{ fold: true, sandbox: true }`; the sandboxed
        // build may additionally run a file whose fold would have required
        // executing project code in this process.
        const plainFold = await (await loadBuild())(entry.srcDir, entry.serializers, undefined, {
          fold: true,
          intrinsics: entry.intrinsics,
          lexicons: entry.lexicons,
          buildParams: await entryBuildParams(entry),
        });
        const plainByFile = new Map(plainFold.foldDecisions.map((d) => [d.file, d.mode]));
        const promoted = sandboxedResult.foldDecisions
          .filter((d) => d.mode === "fold" && plainByFile.get(d.file) === "run")
          .map((d) => d.file);
        expect(promoted, `${entry.name}: sandboxing must never make a file fold that plain --fold ran`).toEqual([]);
        const demotedFileCount = sandboxedResult.foldDecisions.filter(
          (d) => d.mode === "run" && plainByFile.get(d.file) === "fold",
        ).length;

        report.push({
          name: entry.name,
          identical,
          excluded: false,
          runFallbackFileCount,
          sandboxedMs,
          plainMode: classifyMode(plainFold.foldDecisions),
          sandboxMode: classifyMode(sandboxedResult.foldDecisions),
          demotedFileCount,
        });

        // chant #1728 — a mismatch on an entry whose source reads
        // `process.env` is that read showing, not the sandbox misbehaving:
        // the child has no ambient environment by design, the baseline has
        // the shell's. Say so, naming the reads, before the generic
        // output-drift assertion gets to blame the sandbox.
        if (!identical) {
          const reads = ambientEnvReads(entry.srcDir);
          if (reads.length > 0) {
            throw new Error(
              `${entry.name}: sandboxed and in-process output differ, and this entry reads the ambient ` +
                `environment from project source (${reads.join(", ")}). The sandboxed child sees no ` +
                `environment by design, so the two sides only agree when the variable is unset in the shell ` +
                `running this suite. Declare the value in chant.config.ts's buildParams (with an env: mapping) ` +
                `and read it as params.<name> instead — see examples/cockroachdb-multi-region-gke.`,
            );
          }
        }

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
    // chant #1093 — the measured corpus cost of keeping project code out of
    // the CLI process: entries that fold fully under plain `--fold` but need
    // the sandboxed child for at least one file under `--sandbox`.
    const plainFoldCount = report.filter((r) => r.plainMode === "fold").length;
    const sandboxFoldCount = report.filter((r) => r.sandboxMode === "fold").length;
    const demotedEntries = report.filter((r) => r.plainMode === "fold" && r.sandboxMode !== "fold");
    const demotedFiles = report.reduce((sum, r) => sum + (r.demotedFileCount ?? 0), 0);

    const lines = [
      "",
      "── Sandbox differential report (chant #1045 Phase 2) ──────────────",
      `corpus: ${report.length}/${CORPUS.length} source directories built both ways`,
      `  identical: ${identicalCount}   excluded: ${excludedCount}   drift: ${driftCount}   entries with >=1 sandboxed file: ${sandboxedCount}`,
      `  sandboxed build wall time — total: ${totalSandboxedMs.toFixed(0)}ms   max single entry: ${maxSandboxedMs.toFixed(0)}ms`,
      `  #1093 fold coverage — plain --fold: ${plainFoldCount}   --sandbox: ${sandboxFoldCount}   demoted entries: ${demotedEntries.length}   demoted files: ${demotedFiles}`,
      ...(demotedEntries.length > 0
        ? [`  demoted under --sandbox: ${demotedEntries.map((r) => r.name).join(", ")}`]
        : []),
      ...report.map(
        (r) =>
          `  [${r.excluded ? "excluded " : r.identical ? "identical" : "DRIFT    "}] run-fallback-files:${r.runFallbackFileCount}${(r.demotedFileCount ?? 0) > 0 ? ` demoted:${r.demotedFileCount}` : ""} ${r.sandboxedMs.toFixed(0).padStart(5)}ms ${r.name}${r.error ? `  (${r.error})` : ""}`,
      ),
      "────────────────────────────────────────────────────────────────────",
    ];
    console.log(lines.join("\n"));
  });
});
