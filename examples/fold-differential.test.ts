import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import type { build } from "@intentius/chant/build";
import {
  discoverCorpus,
  loadBuild,
  normalizeOutputs,
  outputsEqual,
  normalizeErrors,
  classifyFoldMode,
  type CorpusEntry,
  type FoldMode,
  entryBuildParams,
} from "./differential-corpus";
import { extractFoldCoverageBlock, renderFoldCoverageBlock, FOLD_COVERAGE_DOCS } from "./fold-coverage";
import { foldExecutionCounts, resetFoldExecutionCounts } from "../packages/core/src/discovery/fold-import";

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
  /**
   * chant #1023 — what this entry's plain `--fold` probe build actually
   * EXECUTED, and what it interpreted instead. `projectFactoryInvocations` is
   * the number the epic cares about: a composite factory owned by the project,
   * imported and called in the CLI's own process while the calling file is
   * nonetheless reported as `[fold:fold]`. That is chant #1093's residual, and
   * the report below is where it is now visible for plain `--fold` — the
   * `--sandbox` half has had `sandbox-execution-boundary.test.ts` since #1111.
   */
  factoryInvocations: number;
  projectFactoryInvocations: number;
  factoryInterpretations: number;
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
 *
 * chant #1082 grew it from 21 to 24. The three added entries (`fargate-alb`,
 * `multi-service-alb`, `vpc`) are the corpus's `new Parameter("String",
 * {...})` users: the AWS deploy-time `Parameter` takes `(type, props)`, and
 * `foldResource` used to require argument 0 to be the props object literal,
 * so no `new Parameter(...)` could fold anywhere. Constructor arguments now
 * fold positionally. The same PR made chant's own registered authoring
 * helpers (`phase`, `output`, …) foldable, which doesn't move any corpus
 * entry on its own — the corpus has no component-authoring entry gated
 * solely on one — but is what unblocks real component-using applications.
 *
 * chant #1044 grew it from 24 to 32. The eight added entries are the AWS
 * examples whose only blocker was `Ref(...)` used as a value — seven
 * `lambda-*` plus `rds-postgres` — now that a registered intrinsic's
 * plain-call form folds when its lexicon opts it in. Two more AWS entries
 * (`shared-alb-api`, `shared-alb-ui`) cleared their `Ref` blocker and stopped
 * on the next one (a nested `new Parameter(...)` as a composite argument),
 * and both azure entries whose only blocker was `Concat(...)` cleared it and
 * stopped on `Azure.ResourceGroupLocation` — a lexicon-package namespace
 * access, #1063. That is the measured ceiling this PR reports: azure's
 * remaining corpus is gated on #1063, not on #1044.
 *
 * chant #1112 grew it from 53 to 54 by ADDING an entry, not by folding an
 * existing one: `lexicons/aws/examples/stack-outputs` declares all three
 * output shapes (`output(ref, …)`, `output(intrinsic, …)`, `stackOutput(ref)`)
 * in a file separate from the resources they reference, which is what fold
 * was silently dropping. Thirteen corpus entries already had an `output(...)`
 * in a folding file and still reported `[identical]` — see this suite's
 * `buildBothWays`/`loadBuild` for why, and the #1112 PR for the before/after.
 *
 * chant #1169 grew it from 55 to 76 — the largest single jump so far, by
 * lifting the rejection of a `new Type(...)` used as a VALUE. That one cause
 * was the corpus's biggest gate (64 files, the sole blocker in 22 entries), and
 * it covered two authoring shapes the old reason string conflated: the
 * construction written inline (`image: new Image({...})`), which now folds to a
 * `{__resource}` envelope the bridge constructs for real, and the far more
 * common one that names it first (`const nodeImage = new Image({...})` then
 * `image: nodeImage`), which needed the same-file resource pre-pass in
 * `fold-import.ts`. The 21 added entries are every corpus entry whose remaining
 * blockers were that cause plus the taint it induced: the five k8s
 * `new Container(...)`/`new Probe(...)` examples, four gitlab pipelines, the
 * four fly deploys, `fly/getting-started`, and the seven aws/gitlab shared-ALB
 * entries whose `params.ts`/`network.ts` were only falling back because a
 * sibling did. Two entries in that class did NOT flip and are honest about
 * why: `gitlab/monorepo-pipeline` (`workspaces.map(...)`) and
 * `github/release-please` (`Checkout(...)`) each stop on a function call as a
 * value, one blocker behind the one this change removed.
 *
 * chant #1063 grew it from 32 to 53 — the largest jump before that, and
 * the whole of azure's and gcp's corpora at once. The 21 added entries are
 * every azure example (13) and every gcp example (8): each had exactly one
 * file, failing on `Azure.<PseudoParameter>` / `GCP.<PseudoParameter>` — an
 * identifier imported from the LEXICON PACKAGE rather than from a sibling
 * project file, which #1020's cross-file resolution skipped by construction
 * (it followed relative specifiers only). Following a bare specifier into an
 * ACTIVE lexicon package also cleared every remaining `S3Actions` (aws),
 * `CI` (gitlab) and value-position `AWS` (aws) failure in the corpus, but
 * those all live in `docs-snippets` entries carrying several unrelated
 * blockers apiece, so they move no entry on their own.
 *
 * chant #1174 grew the corpus's folding count from 82 to 89 (the corpus
 * itself had also grown, 101 -> 108, from unrelated additions between #1169
 * and this PR — this list only tracks what #1174 itself moved). Two
 * independent mechanisms shared one cause string, "function call as a value
 * is not foldable", and both needed closing:
 *
 *   - **A composite factory call narrowed to `.step`** — `Checkout({...}).step`,
 *     `SetupNode({...}).step` — every lexicon's single-action `Composite()`
 *     wrapper, embedded inline in a `Job`'s `steps` array exactly as
 *     composites.mdx documents. `fold()` gained a narrow, EVL-parity-matched
 *     case for exactly this shape (chant #1544's `allowCompositeStepAccess`
 *     already carved the identical shape out of EVL001 as a documented,
 *     correct fallback — this is the fold-side counterpart that actually
 *     reduces it). The four added entries: `lexicons/github/examples/getting-started`,
 *     `deploy-pages`, `release-please`, and `lexicons/forgejo/examples/ci-workflow`.
 *     Four more github entries (`docker-build`, `matrix-test`, `node-ci`,
 *     `reusable-workflow`) have a Checkout call too but do NOT flip — each
 *     stops on a DIFFERENT, unrelated blocker one step behind it: a `.toString()`
 *     method call on `github.actor`/`matrix(...)`/`inputs(...)` (an
 *     Expression-returning helper, not a registered intrinsic), or an array
 *     `.join(...)` inside a step's `run:` string. Method-call folding is a
 *     separate, unscoped gap this PR does not attempt.
 *   - **Helm's call-form intrinsics opted into `foldsAsCall`** — `include`,
 *     `printf`, and `toYaml` (plus `required`/`helmDefault`/`quote`/`tpl`/
 *     `lookup`/`filesGet`/`filesGlob`/`filesAsConfig`/`filesAsSecrets`,
 *     audited the same way but not exercised by the corpus) were registered
 *     with `isTag: false` and no `foldsAsCall` — helm has no tagged
 *     templates at all, so before this PR literally zero helm intrinsic
 *     calls ever folded. The three added entries — `lexicons/helm/examples/cron-job`,
 *     `multi-container`, `stateful-service` — each used `include`/`printf`/
 *     `toYaml` together, so all three needed opting in before any of them
 *     could flip.
 */
const EXPECTED_FOLD: readonly string[] = [
  "examples/adopt-alb-services",
  "examples/alert-triage",
  "examples/bedrock-agentcore-agent",
  "examples/components-aws-e2e",
  "examples/fly-deploy-rollback",
  "examples/fly-durable-deploy",
  "examples/fly-reconcile",
  "examples/getting-started",
  "examples/gitlab-aws-alb-api",
  "examples/gitlab-aws-alb-infra",
  "examples/gitlab-aws-alb-ui",
  "examples/local-cloud-trio",
  "examples/local-fly",
  "examples/temporal-stack",
  "lexicons/aws/examples/fargate-alb",
  "lexicons/aws/examples/lambda-dynamodb",
  "lexicons/aws/examples/lambda-eventbridge",
  "lexicons/aws/examples/lambda-function",
  "lexicons/aws/examples/lambda-s3",
  "lexicons/aws/examples/lambda-scheduled",
  "lexicons/aws/examples/lambda-sns",
  "lexicons/aws/examples/lambda-sqs",
  "lexicons/aws/examples/lifecycle-reconcile-aws",
  "lexicons/aws/examples/multi-service-alb",
  "lexicons/aws/examples/rds-postgres",
  "lexicons/aws/examples/shared-alb",
  "lexicons/aws/examples/shared-alb-api",
  "lexicons/aws/examples/shared-alb-ui",
  "lexicons/aws/examples/stack-outputs",
  "lexicons/aws/examples/vpc",
  "lexicons/azure/examples/aks-cluster",
  "lexicons/azure/examples/basic-storage",
  "lexicons/azure/examples/container-instance",
  "lexicons/azure/examples/cosmos-db",
  "lexicons/azure/examples/function-app",
  "lexicons/azure/examples/key-vault",
  "lexicons/azure/examples/multi-resource",
  "lexicons/azure/examples/private-endpoint",
  "lexicons/azure/examples/redis-cache",
  "lexicons/azure/examples/service-bus",
  "lexicons/azure/examples/sql-database",
  "lexicons/azure/examples/vnet-vms",
  "lexicons/azure/examples/web-app",
  "lexicons/docker/examples/basic-app",
  "lexicons/fly/examples/getting-started",
  "lexicons/gcp/examples/basic-bucket",
  "lexicons/gcp/examples/cloud-function",
  "lexicons/gcp/examples/cloud-run",
  "lexicons/gcp/examples/cloud-sql",
  "lexicons/gcp/examples/cloud-storage-lifecycle",
  "lexicons/gcp/examples/gke-cluster",
  "lexicons/gcp/examples/pubsub",
  "lexicons/gcp/examples/vpc-network",
  "lexicons/forgejo/examples/ci-workflow",
  "lexicons/github/examples/deploy-pages",
  "lexicons/github/examples/getting-started",
  "lexicons/github/examples/release-please",
  "lexicons/gitlab/examples/docker-build",
  "lexicons/gitlab/examples/getting-started",
  "lexicons/gitlab/examples/multi-stage-deploy",
  "lexicons/gitlab/examples/node-pipeline",
  "lexicons/gitlab/examples/python-pipeline",
  "lexicons/gitlab/examples/review-app",
  "lexicons/helm/examples/composites-basic",
  "lexicons/helm/examples/composites-infrastructure",
  "lexicons/helm/examples/composites-production",
  "lexicons/helm/examples/cron-job",
  "lexicons/helm/examples/helm-render-external-secrets",
  "lexicons/helm/examples/microservice-chart",
  "lexicons/helm/examples/multi-container",
  "lexicons/helm/examples/stateful-service",
  "lexicons/helm/examples/web-app-with-ingress",
  "lexicons/k8s/examples/basic-deployment",
  "lexicons/k8s/examples/batch-workers",
  "lexicons/k8s/examples/configmap-secret",
  "lexicons/k8s/examples/cronjob-cleanup",
  "lexicons/k8s/examples/ingress-tls",
  "lexicons/k8s/examples/layered-config",
  "lexicons/k8s/examples/namespace-rbac",
  "lexicons/k8s/examples/org-policy",
  "lexicons/k8s/examples/statefulset",
  "lexicons/k8s/examples/web-platform",
  "lexicons/temporal/examples/local-dev-server",
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
  // chant #1112 — `build` is loaded per call, never captured once at module
  // scope, so the run baseline is always produced by the same chant-core copy
  // the project files were just loaded into. See {@link loadBuild}.
  const buildParams = await entryBuildParams(entry);
  const runOnce = async () =>
    (await loadBuild())(entry.srcDir, entry.serializers, undefined, { fold: false, buildParams });
  const foldOnce = async () =>
    (await loadBuild())(entry.srcDir, entry.serializers, undefined, {
      fold: true,
      intrinsics: entry.intrinsics,
      lexicons: entry.lexicons,
      buildParams,
    });

  const run = await runOnce();
  const fold = await foldOnce();

  if (outputsEqual(normalizeOutputs(fold.outputs), normalizeOutputs(run.outputs))) {
    return { run, fold, neededIsolation: false };
  }

  vi.resetModules();
  const freshRun = await runOnce();
  vi.resetModules();
  const freshFold = await foldOnce();
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
      // chant #1023 — counted around the PROBE build only. It is one plain
      // `--fold` build of the entry, which is exactly the figure the report
      // wants; the both-ways comparison below would double it.
      resetFoldExecutionCounts();
      const probe = await (await loadBuild())(entry.srcDir, entry.serializers, undefined, { fold: true, intrinsics: entry.intrinsics, lexicons: entry.lexicons, buildParams: await entryBuildParams(entry) });
      const counts = foldExecutionCounts();
      const mode = classifyFoldMode(probe.foldDecisions);
      if (mode !== "fold") {
        report.push({ name: entry.name, mode, identical: true, fileCount: probe.foldDecisions.length, neededIsolation: false, ...counts });
        return;
      }

      // Fully-folded entry: the real fold-correctness gate.
      const { run: runResult, fold: foldResult, neededIsolation } = await buildBothWays(entry);
      const runNorm = normalizeOutputs(runResult.outputs);
      const foldNorm = normalizeOutputs(foldResult.outputs);
      report.push({ name: entry.name, mode, identical: outputsEqual(foldNorm, runNorm), fileCount: foldResult.foldDecisions.length, neededIsolation, ...counts });

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
  // Every doc in FOLD_COVERAGE_DOCS, not just the first: the second page is
  // precisely how this drifted before (sandbox.mdx hand-typed "55 of 101" while
  // the guarded block next door had moved to 76 of 102).
  test.each([...FOLD_COVERAGE_DOCS])("published fold coverage in %s matches this run's live count", (relPath) => {
    const docPath = join(import.meta.dirname, "..", relPath);
    const doc = readFileSync(docPath, "utf-8");
    const foldCount = report.filter((r) => r.mode === "fold").length;
    const expected = renderFoldCoverageBlock(foldCount, report.length);
    const actual = extractFoldCoverageBlock(doc);
    expect(
      actual,
      `published fold coverage is stale (live: ${foldCount} of ${report.length}) — run \`npm run generate:fold-coverage\` and commit ${relPath}`,
    ).toBe(expected);
  });

  afterAll(() => {
    const foldCount = report.filter((r) => r.mode === "fold").length;
    const fallbackCount = report.filter((r) => r.mode === "run-fallback").length;
    const emptyCount = report.filter((r) => r.mode === "empty").length;
    const driftCount = report.filter((r) => !r.identical).length;
    const isolatedCount = report.filter((r) => r.neededIsolation).length;
    const sum = (pick: (r: ReportRow) => number): number => report.reduce((total, r) => total + pick(r), 0);

    const lines = [
      "",
      "── Fold differential report (#1025) ──────────────────────────────",
      `corpus: ${report.length}/${CORPUS.length} source directories built both ways`,
      `  fold: ${foldCount}   run-fallback: ${fallbackCount}   empty: ${emptyCount}   drift: ${driftCount}   isolated-retry: ${isolatedCount}`,
      `  #1023 plain --fold execution — factory invocations: ${sum((r) => r.factoryInvocations)}` +
        `   of which PROJECT-owned: ${sum((r) => r.projectFactoryInvocations)}` +
        `   factory bodies interpreted: ${sum((r) => r.factoryInterpretations)}`,
      ...report.map(
        (r) =>
          `  [${r.identical ? "identical" : "DRIFT    "}] ${r.mode.padEnd(12)} ${r.name}${r.neededIsolation ? "  (needed isolated retry)" : ""}`,
      ),
      "───────────────────────────────────────────────────────────────────",
    ];
    console.log(lines.join("\n"));
  });
});
