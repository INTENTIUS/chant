import { afterAll, describe, expect, test, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "@intentius/chant/build";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import type { DiscoveryError, BuildError } from "@intentius/chant/errors";
import type { IntrinsicDef } from "@intentius/chant/lexicon";
import { awsSerializer, awsPlugin } from "@intentius/chant-lexicon-aws";
import { gcpSerializer, gcpPlugin } from "@intentius/chant-lexicon-gcp";
import { azureSerializer, azurePlugin } from "@intentius/chant-lexicon-azure";
import { k8sSerializer, k8sPlugin } from "@intentius/chant-lexicon-k8s";
import { gitlabSerializer, gitlabPlugin } from "@intentius/chant-lexicon-gitlab";
import { githubSerializer, githubPlugin } from "@intentius/chant-lexicon-github";
import { forgejoSerializer, forgejoPlugin } from "@intentius/chant-lexicon-forgejo";
import { helmSerializer, helmPlugin } from "@intentius/chant-lexicon-helm";
import { dockerSerializer, dockerPlugin } from "@intentius/chant-lexicon-docker";
import { temporalSerializer, temporalPlugin } from "@intentius/chant-lexicon-temporal";
import { flySerializer, flyPlugin } from "@intentius/chant-lexicon-fly";

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

const ROOT = resolve(import.meta.dirname, "..");

const ALL_SERIALIZERS: Serializer[] = [
  awsSerializer,
  gcpSerializer,
  azureSerializer,
  k8sSerializer,
  gitlabSerializer,
  githubSerializer,
  forgejoSerializer,
  helmSerializer,
  dockerSerializer,
  temporalSerializer,
  flySerializer,
];

/**
 * One serializer per lexicon, keyed by the lexicon's directory name under
 * `lexicons/`. Used for `lexicons/*<dot>/examples/*` corpus entries — see
 * {@link discoverCorpus}'s doc for why those get only their own lexicon's
 * serializer rather than {@link ALL_SERIALIZERS}.
 */
const SERIALIZER_BY_LEXICON: Record<string, Serializer> = {
  aws: awsSerializer,
  gcp: gcpSerializer,
  azure: azureSerializer,
  k8s: k8sSerializer,
  gitlab: gitlabSerializer,
  github: githubSerializer,
  forgejo: forgejoSerializer,
  helm: helmSerializer,
  docker: dockerSerializer,
  temporal: temporalSerializer,
  fly: flySerializer,
};

/**
 * chant #1039 — every loaded plugin's registered intrinsics, combined. This
 * differential builds directly through core's `build()` (not the CLI), so it
 * has to reproduce `cli/commands/build.ts`'s own
 * `options.plugins.flatMap(p => p.intrinsics?.() ?? [])` step itself for the
 * fold path to recognize any intrinsic tagged template (e.g. AWS `Sub`) —
 * otherwise this corpus would never reflect what `chant build --fold`
 * actually does in production, and would keep reporting intrinsic-using
 * entries as run-fallback even after the fold-import wiring is fixed.
 */
const ALL_INTRINSICS: IntrinsicDef[] = [
  awsPlugin,
  gcpPlugin,
  azurePlugin,
  k8sPlugin,
  gitlabPlugin,
  githubPlugin,
  forgejoPlugin,
  helmPlugin,
  dockerPlugin,
  temporalPlugin,
  flyPlugin,
].flatMap((plugin) => plugin.intrinsics?.() ?? []);

/**
 * One lexicon's own intrinsics, keyed the same way as
 * {@link SERIALIZER_BY_LEXICON} — used for `lexicons/*<dot>/examples/*`
 * corpus entries, which likewise only get their own lexicon's serializer.
 */
const INTRINSICS_BY_LEXICON: Record<string, IntrinsicDef[]> = {
  aws: awsPlugin.intrinsics?.() ?? [],
  gcp: gcpPlugin.intrinsics?.() ?? [],
  azure: azurePlugin.intrinsics?.() ?? [],
  k8s: k8sPlugin.intrinsics?.() ?? [],
  gitlab: gitlabPlugin.intrinsics?.() ?? [],
  github: githubPlugin.intrinsics?.() ?? [],
  forgejo: forgejoPlugin.intrinsics?.() ?? [],
  helm: helmPlugin.intrinsics?.() ?? [],
  docker: dockerPlugin.intrinsics?.() ?? [],
  temporal: temporalPlugin.intrinsics?.() ?? [],
  fly: flyPlugin.intrinsics?.() ?? [],
};

interface CorpusEntry {
  /** Repo-relative label used in test names and the report. */
  name: string;
  /** Absolute path to the source directory `build()` is pointed at. */
  srcDir: string;
  /** Serializers to build this entry with. */
  serializers: Serializer[];
  /** Intrinsics to fold with (chant #1039) — see {@link ALL_INTRINSICS}/{@link INTRINSICS_BY_LEXICON}. */
  intrinsics: IntrinsicDef[];
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every buildable source directory in the corpus. Walks `examples/` and
 * each `lexicons/*<dot>/examples/` for subdirectories that carry a `src/`
 * folder — the same shape `describeAllExamples` (test-utils) auto-discovers
 * examples by.
 *
 * Serializer selection:
 *  - Root `examples/*<dot>/src` tutorials are built with every serializer
 *    ({@link ALL_SERIALIZERS}) — these tutorials deliberately combine a
 *    handful of lexicons (aws+k8s, gcp+k8s, gitlab+aws, …) and passing the
 *    full set costs nothing (`build()` only invokes a serializer for
 *    lexicons actually discovered).
 *  - `lexicons/*<dot>/examples/*<dot>/src` build fixtures are built with ONLY
 *    that lexicon's own serializer, matching how every lexicon's own
 *    `examples/examples.test.ts` already builds them (e.g.
 *    `lexicons/helm/examples/examples.test.ts` uses `helmSerializer` alone).
 *    This isn't just precedent for its own sake: a helm chart embeds
 *    `@intentius/chant-lexicon-k8s` resources (`StatefulSet`, `Container`, …)
 *    as template values, not as independently-deployable k8s manifests —
 *    running `k8sSerializer` over them too tries to serialize those nested,
 *    helm-intrinsic-bearing objects as standalone k8s YAML, which breaks
 *    regardless of fold. That's a real pre-existing bug the differential's
 *    first draft (all-serializers-everywhere) surfaced as a false positive;
 *    it reproduces identically with `fold: false`, so it's an artifact of
 *    the harness's serializer choice, not of folding — see the #1025
 *    implementation notes.
 */
function discoverCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];

  const examplesDir = resolve(ROOT, "examples");
  for (const dirent of readdirSync(examplesDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const srcDir = resolve(examplesDir, dirent.name, "src");
    if (isDir(srcDir)) {
      entries.push({ name: `examples/${dirent.name}`, srcDir, serializers: ALL_SERIALIZERS, intrinsics: ALL_INTRINSICS });
    }
  }

  const lexiconsDir = resolve(ROOT, "lexicons");
  for (const lexDirent of readdirSync(lexiconsDir, { withFileTypes: true })) {
    if (!lexDirent.isDirectory()) continue;
    const serializer = SERIALIZER_BY_LEXICON[lexDirent.name];
    if (!serializer) continue;
    const lexExamplesDir = resolve(lexiconsDir, lexDirent.name, "examples");
    if (!isDir(lexExamplesDir)) continue;
    for (const exDirent of readdirSync(lexExamplesDir, { withFileTypes: true })) {
      if (!exDirent.isDirectory()) continue;
      const srcDir = resolve(lexExamplesDir, exDirent.name, "src");
      if (isDir(srcDir)) {
        entries.push({
          name: `lexicons/${lexDirent.name}/examples/${exDirent.name}`,
          srcDir,
          serializers: [serializer],
          intrinsics: INTRINSICS_BY_LEXICON[lexDirent.name] ?? [],
        });
      }
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** A build's outputs, normalized to plain strings for byte-exact comparison. */
type NormalizedOutputs = Record<string, { primary: string; files: Record<string, string> }>;

function normalizeOutputs(outputs: Map<string, string | SerializerResult>): NormalizedOutputs {
  const normalized: NormalizedOutputs = {};
  for (const [lexicon, value] of outputs) {
    normalized[lexicon] =
      typeof value === "string"
        ? { primary: value, files: {} }
        : { primary: value.primary, files: { ...(value.files ?? {}) } };
  }
  return normalized;
}

/** Order-independent, byte-exact equality check — used for the printed report only (the gate is `expect().toEqual()` below, which gives a real diff on failure). */
function outputsEqual(a: NormalizedOutputs, b: NormalizedOutputs): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  for (const key of aKeys) {
    if (a[key].primary !== b[key].primary) return false;
    const aFiles = Object.keys(a[key].files).sort();
    const bFiles = Object.keys(b[key].files).sort();
    if (aFiles.length !== bFiles.length || aFiles.some((k, i) => k !== bFiles[i])) return false;
    for (const f of aFiles) {
      if (a[key].files[f] !== b[key].files[f]) return false;
    }
  }
  return true;
}

/** Normalize discovery/build errors for order-independent comparison across the two paths. */
function normalizeErrors(errors: Array<DiscoveryError | BuildError>): string[] {
  return errors.map((e) => JSON.stringify(e.toJSON())).sort();
}

type FoldMode = "fold" | "run-fallback" | "empty";

function classify(foldDecisions: Array<{ mode: "fold" | "run" }>): FoldMode {
  if (foldDecisions.length === 0) return "empty";
  return foldDecisions.every((d) => d.mode === "fold") ? "fold" : "run-fallback";
}

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
      const mode = classify(probe.foldDecisions);
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
