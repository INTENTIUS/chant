import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { build } from "@intentius/chant/build";
import {
  discoverCorpus,
  normalizeOutputs,
  outputsEqual,
  normalizeErrors,
  classifyFoldMode,
  type CorpusEntry,
  type FoldMode,
} from "./differential-corpus";
import { extractFoldCoverageBlock, renderFoldCoverageBlock } from "./fold-coverage";

/**
 * chant #1025 (epic #1019) — the fold-vs-run differential safety net.
 *
 * The fold path (#1026 reducer + #1021 real ref/intrinsic support + #1022
 * build integration) is only safe to promote if it is provably
 * indistinguishable from the run path it is meant to replace. This suite
 * builds every source directory in the corpus BOTH ways —
 * `{ fold: false }` (import/execute, the original path) and
 * `{ fold: true }` (static fold with per-file run-fallback, #1022) — and
 * asserts the serialized output is byte-identical between them.
 *
 * Corpus = every `examples/*<dot>/src` tutorial plus every lexicon's own
 * `examples/*<dot>/src` build fixtures, discovered by walking the
 * filesystem rather than a hardcoded list, so a newly added example or
 * fixture enters the differential automatically the moment its `src/`
 * directory exists (#1025 acceptance criteria) — no per-file wiring.
 *
 * A corpus entry that still has any file fall back to the run path (a
 * composite factory call, a non-`new` export, …) is expected and allowed —
 * that's exactly what #1022's per-file fallback is for. The strict
 * byte-for-byte gate applies to entries that fold cleanly (mode "fold"); for
 * "run-fallback" entries the fold path uses the run path on the fallen-back
 * file(s), so any difference there is run-vs-run build non-idempotency
 * (chant#1032), a separate core bug this fold suite deliberately does not gate
 * on. Fallback entries are still built and reported (drift visible), and once
 * #1023 (module→Composite folding) lands they become "fold" and re-enter the
 * strict gate automatically. What is NEVER allowed is drift on a folded entry.
 *
 * chant #1039 — every `{ fold: true }` build below passes `intrinsics`,
 * reproducing the CLI's own `options.plugins.flatMap(p => p.intrinsics?.() ??
 * [])` step (`cli/commands/build.ts`). Without this the differential doesn't
 * reflect what `chant build --fold` actually does in production: a file using
 * a registered intrinsic tagged template (e.g. AWS `Sub`) would be reported
 * as run-fallback here even once the fold-import wiring recognizes it.
 */

const CORPUS = discoverCorpus();

interface ReportRow {
  name: string;
  mode: FoldMode;
  identical: boolean;
  fileCount: number;
  /** True when the fast (no-reset) comparison drifted and a module-isolated retry was needed to tell real fold-vs-run drift apart from cross-build state bleed. See {@link buildBothWays}'s doc. */
  neededIsolation: boolean;
}

const report: ReportRow[] = [];

/**
 * chant #1039 — fold COVERAGE regression gate.
 *
 * The byte-identical assertion below only fires for entries that already
 * fold (mode "fold") — an entry that quietly stops folding and falls back to
 * run instead reports `identical: true` (run-vs-run has no drift by
 * definition) and the whole suite stays green. That is a real, silent
 * coverage regression the differential's original design (#1025) had no gate
 * for at all.
 *
 * This is the committed baseline: every corpus entry that folds today (as of
 * this branch — see the PR that introduced this list for the exact
 * before/after against `main`). A name-by-name check, not just a count,
 * because a count alone can't tell "A regressed, B started folding" apart
 * from "nothing changed" — exactly the failure mode a bare total would hide.
 * Update this list only when you've confirmed (via `just fold-differential
 * --reporter=verbose`, comparing the full per-entry classification against
 * `main`, not just the summary line) that a removal is an intentional,
 * understood behavior change — never to silence a red run.
 *
 * chant #1020 (epic #1019) grew this from 15 to 21 by resolving identifiers
 * across the module graph — an imported `const`, or an imported resource
 * referenced via `.attr`, now folds instead of failing the whole importing
 * file on the first identifier it doesn't recognize. The 6 entries added
 * here (`alert-triage`, `bedrock-agentcore-agent`, `getting-started`,
 * `temporal-stack`, `lifecycle-reconcile-aws`, `layered-config`) were
 * exactly the corpus entries where cross-file resolution was the ONLY
 * remaining blocker; most of the run-fallback corpus needs #1044
 * (call-as-a-value) too, or an unrelated shape gap (a resource constructor
 * whose first argument isn't the props object literal, a nested `new` used
 * as a value — pre-existing #1022-era limitations, not cross-file), so this
 * PR doesn't move those, by design.
 */
const EXPECTED_FOLD: readonly string[] = [
  "examples/alert-triage",
  "examples/bedrock-agentcore-agent",
  "examples/components-aws-e2e",
  "examples/getting-started",
  "examples/local-cloud-trio",
  "examples/temporal-stack",
  "lexicons/aws/examples/lifecycle-reconcile-aws",
  "lexicons/docker/examples/basic-app",
  "lexicons/gitlab/examples/node-pipeline",
  "lexicons/gitlab/examples/python-pipeline",
  "lexicons/helm/examples/composites-basic",
  "lexicons/helm/examples/composites-infrastructure",
  "lexicons/helm/examples/composites-production",
  "lexicons/helm/examples/helm-render-external-secrets",
  "lexicons/helm/examples/microservice-chart",
  "lexicons/helm/examples/web-app-with-ingress",
  "lexicons/k8s/examples/batch-workers",
  "lexicons/k8s/examples/layered-config",
  "lexicons/k8s/examples/namespace-rbac",
  "lexicons/k8s/examples/org-policy",
  "lexicons/k8s/examples/web-platform",
];

/**
 * Build `srcDir` both ways and return normalized outputs for comparison.
 *
 * The fast path builds run-then-fold back to back with no module-cache
 * reset, which is correct for the overwhelming majority of the corpus and
 * cheap (no re-transformation of chant's own framework/lexicon modules).
 *
 * A handful of corpus entries use a composite helper (`propagate()`,
 * ../packages/core/src/composite.ts) that mutates its instance in place
 * rather than copying it — building the SAME directory twice in one process
 * (as every entry here is, once per fold mode) can observe that mutation
 * compounding across the two calls, which looks exactly like drift but has
 * nothing to do with fold: it reproduces identically for two `fold: false`
 * builds run back to back. That's a real, pre-existing, fold-independent
 * sharp edge (`build()` isn't safe to call twice on the same directory in
 * one process today) — not something #1025 is chartered to fix, and not
 * something this harness should misreport as a fold regression.
 *
 * So: only when the fast comparison finds a mismatch, retry once with
 * `vi.resetModules()` before each build, forcing every source file this
 * directory imports to be freshly re-evaluated instead of served from
 * vitest's module cache. A genuine fold bug drifts either way (resetting
 * modules doesn't change what fold does); a cross-build state artifact
 * disappears once both sides start from a clean module graph. This keeps
 * the isolation cost — real, since it re-transforms the whole module graph —
 * paid only by the entries that actually need it, not by all ~100.
 */
async function buildBothWays(
  entry: CorpusEntry,
): Promise<{ run: Awaited<ReturnType<typeof build>>; fold: Awaited<ReturnType<typeof build>>; neededIsolation: boolean }> {
  const run = await build(entry.srcDir, entry.serializers, undefined, { fold: false });
  const fold = await build(entry.srcDir, entry.serializers, undefined, { fold: true, intrinsics: entry.intrinsics });

  if (outputsEqual(normalizeOutputs(fold.outputs), normalizeOutputs(run.outputs))) {
    return { run, fold, neededIsolation: false };
  }

  vi.resetModules();
  const freshRun = await build(entry.srcDir, entry.serializers, undefined, { fold: false });
  vi.resetModules();
  const freshFold = await build(entry.srcDir, entry.serializers, undefined, { fold: true, intrinsics: entry.intrinsics });
  return { run: freshRun, fold: freshFold, neededIsolation: true };
}

describe("fold differential — fold output === run output (#1025, epic #1019)", () => {
  test(`corpus is non-empty (found ${CORPUS.length} source directories)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    test(`${entry.name}: fold output is byte-identical to run output`, async () => {
      // Classify with a SINGLE fold build first. An entry that doesn't fully
      // fold (mode "run-fallback"/"empty") is out of this fold suite's scope —
      // its fold-vs-run difference would be run-vs-run build non-idempotency
      // (chant#1032), not a fold defect. Record it and skip the expensive
      // both-ways comparison + module-reset retry; that retry (which reloads the
      // whole module graph) is what makes the full corpus intractable now that
      // many entries fall back, and it buys nothing for entries we don't gate.
      const probe = await build(entry.srcDir, entry.serializers, undefined, { fold: true, intrinsics: entry.intrinsics });
      const mode = classifyFoldMode(probe.foldDecisions);
      if (mode !== "fold") {
        report.push({ name: entry.name, mode, identical: true, fileCount: probe.foldDecisions.length, neededIsolation: false });
        return;
      }

      // Fully-folded entry: the real fold-correctness gate.
      const { run: runResult, fold: foldResult, neededIsolation } = await buildBothWays(entry);
      const runNorm = normalizeOutputs(runResult.outputs);
      const foldNorm = normalizeOutputs(foldResult.outputs);
      report.push({ name: entry.name, mode, identical: outputsEqual(foldNorm, runNorm), fileCount: foldResult.foldDecisions.length, neededIsolation });

      // Same errors either way (usually none) — the fold path must not
      // silently swallow or invent a discovery/build failure.
      expect(normalizeErrors(foldResult.errors), `fold-vs-run error drift in ${entry.name}`).toEqual(
        normalizeErrors(runResult.errors),
      );

      // The actual safety net: byte-identical serialized specs.
      expect(foldNorm, `fold-vs-run output drift in ${entry.name}`).toEqual(runNorm);
    });
  }

  // Runs last (vitest executes tests within a `describe` in declaration
  // order) — by now every corpus entry above has pushed its classification
  // into `report`. See {@link EXPECTED_FOLD}'s doc for why this checks names,
  // not just a total.
  test("fold coverage regression gate — every entry known to fold today still folds", () => {
    const byName = new Map(report.map((r) => [r.name, r]));
    const regressed = EXPECTED_FOLD.filter((name) => byName.get(name)?.mode !== "fold");
    expect(regressed, `these entries folded before but fell back to run: ${regressed.join(", ")}`).toEqual([]);
  });

  // chant #1062 — the fold-coverage count published in the docs
  // (typescript-as-data.mdx) must match what THIS run actually found, not a
  // hand-typed snapshot from whenever someone last remembered to update it.
  // Reuses `report`, already fully populated by the per-entry tests above —
  // no second corpus build. A drift here (the corpus grew/shrank, or fold
  // coverage moved) is expected to happen and is meant to fail loudly: run
  // `npm run generate:fold-coverage` to refresh the committed number, then
  // commit the result alongside whatever changed it.
  test("published fold coverage count matches this run's live count", () => {
    const docPath = join(
      import.meta.dirname,
      "..",
      "docs",
      "src",
      "content",
      "docs",
      "concepts",
      "typescript-as-data.mdx",
    );
    const doc = readFileSync(docPath, "utf-8");
    const foldCount = report.filter((r) => r.mode === "fold").length;
    const expected = renderFoldCoverageBlock(foldCount, report.length);
    const actual = extractFoldCoverageBlock(doc);
    expect(
      actual,
      `published fold coverage is stale (live: ${foldCount} of ${report.length}) — run \`npm run generate:fold-coverage\` and commit docs/src/content/docs/concepts/typescript-as-data.mdx`,
    ).toBe(expected);
  });

  afterAll(() => {
    const foldCount = report.filter((r) => r.mode === "fold").length;
    const fallbackCount = report.filter((r) => r.mode === "run-fallback").length;
    const emptyCount = report.filter((r) => r.mode === "empty").length;
    const driftCount = report.filter((r) => !r.identical).length;
    const isolatedCount = report.filter((r) => r.neededIsolation).length;

    const lines = [
      "",
      "── Fold differential report (#1025) ──────────────────────────────",
      `corpus: ${report.length}/${CORPUS.length} source directories built both ways`,
      `  fold: ${foldCount}   run-fallback: ${fallbackCount}   empty: ${emptyCount}   drift: ${driftCount}   isolated-retry: ${isolatedCount}`,
      ...report.map(
        (r) =>
          `  [${r.identical ? "identical" : "DRIFT    "}] ${r.mode.padEnd(12)} ${r.name}${r.neededIsolation ? "  (needed isolated retry)" : ""}`,
      ),
      "───────────────────────────────────────────────────────────────────",
    ];
    console.log(lines.join("\n"));
  });
});
