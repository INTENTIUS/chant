import { basename, resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  ALL_INTRINSICS,
  ALL_LEXICONS,
  ALL_SERIALIZERS,
  loadBuild,
  normalizeErrors,
  normalizeOutputs,
} from "../differential-corpus";

/**
 * chant #2347 — what the fold/run differential cannot say about
 * `examples/fold-adversarial` on its own.
 *
 * The shared differential (`../fold-differential.test.ts`) builds this entry
 * both ways and compares bytes. That is the claim the docs make and the claim
 * worth gating on, and it is also anonymous: it says the entry agrees, not
 * WHICH file folded, which fell back, or why. For a corpus of happy-path
 * examples anonymity costs nothing. For an entry whose whole reason to exist
 * is that some of its files must fall back, it costs everything — nine files
 * all falling back would agree byte-for-byte too, and would prove nothing at
 * all.
 *
 * So this file names the split. Every source file in `src/` appears in
 * {@link EXPECTED_SPLIT} with its decision and, for a run decision, whether
 * `planFoldTaint` is what put it there. A fixture that stops exercising its
 * decision point — a folder change that starts folding the spread of a
 * non-object, a taint edge that stops firing — moves a row here and fails,
 * instead of quietly becoming another happy-path example.
 *
 * The three taint rows are the ones #2347 was filed for. `planFoldTaint`'s
 * bidirectional fixpoint only does anything inside a MIXED entry, and before
 * this fixture no corpus entry was designed to make it do anything: #2345
 * taught the differential to compare mixed entries at all, and every mixed
 * entry it then compared was mixed by accident.
 */

const SRC = resolve(import.meta.dirname, "src");

type Split = { mode: "fold" } | { mode: "run"; taintForced: boolean };

/**
 * Every file in `src/`, the decision point it targets, and the fold/run
 * outcome that decision produces.
 *
 * `taintForced` is `FoldDecision.reverseTainted`
 * (`packages/core/src/discovery/index.ts`): true when the file's OWN fold
 * attempt succeeded and `planFoldTaint` overruled it, false when the file
 * could not fold on its own. It is the only thing that tells a taint casualty
 * apart from a blocker, and it is the assertion the taint fixtures live for.
 */
const EXPECTED_SPLIT: ReadonlyMap<string, { decisionPoint: string; split: Split }> = new Map([
  [
    "nullish-property-read.ts",
    {
      decisionPoint: "L3.10 F-Div-Nullish — property read on a nullish object (#2328)",
      split: { mode: "run", taintForced: false } as Split,
    },
  ],
  [
    "optional-chain-short-circuit.ts",
    {
      decisionPoint: "L3.21 — `?.` on a nullish object, short-circuit through the rest of the chain",
      split: { mode: "fold" } as Split,
    },
  ],
  [
    "helper-name-shadowed.ts",
    {
      decisionPoint: "L5.3 F-Eval-Ident — a local `const` defeats a registered helper or intrinsic name",
      split: { mode: "fold" } as Split,
    },
  ],
  [
    "spread-non-object.ts",
    {
      decisionPoint: "L3.4 F-Div-SpreadType — object spread of a non-object",
      split: { mode: "run", taintForced: false } as Split,
    },
  ],
  [
    "function-call-depth-bound.ts",
    {
      decisionPoint: "L5.8 F-Depth — MAX_FUNCTION_CALL_DEPTH = 32",
      split: { mode: "run", taintForced: false } as Split,
    },
  ],
  [
    "taint-run-only-importer.ts",
    {
      decisionPoint: "L5.4 S-FnBody — early return in a project-local function body; the fixpoint's SEED",
      split: { mode: "run", taintForced: false } as Split,
    },
  ],
  [
    "taint-shared-config.ts",
    {
      decisionPoint: "L8.6 F-Succ forward — the importer of a non-folding file taints what it imports",
      split: { mode: "run", taintForced: true } as Split,
    },
  ],
  [
    "taint-capturing-sibling.ts",
    {
      decisionPoint: "L8.7 F-Succ backward — a captured object's source taints the file that captured it",
      split: { mode: "run", taintForced: true } as Split,
    },
  ],
  [
    "taint-independent.ts",
    {
      decisionPoint: "L8.8 F-Taint/F-Fix — no edge reaches it, so the fixpoint leaves it alone",
      split: { mode: "fold" } as Split,
    },
  ],
]);

async function buildOnce(srcDir: string, fold: boolean) {
  // Modules are reset around every build. The shared differentials pay for
  // this only on a mismatch (it re-transforms the whole graph); here it is
  // unconditional, because the entry holds a file that throws on import and
  // only the FIRST build in a process reports that — see chant #2368, filed
  // with this entry as its reproduction. Comparing errors without isolating
  // would be comparing build order.
  vi.resetModules();
  return (await loadBuild())(srcDir, ALL_SERIALIZERS, undefined, {
    fold,
    intrinsics: ALL_INTRINSICS,
    lexicons: ALL_LEXICONS,
    buildParams: [],
  });
}

describe("examples/fold-adversarial — the fold/run split is the fixture (chant #2347)", () => {
  test("every file lands on the side its decision point puts it on", async () => {
    const result = await buildOnce(SRC, true);

    const actual = new Map(
      result.foldDecisions.map((d) => [
        basename(d.file),
        d.mode === "fold" ? ({ mode: "fold" } as Split) : ({ mode: "run", taintForced: d.reverseTainted === true } as Split),
      ]),
    );

    // Named, not counted: a file added to `src/` without a row here fails,
    // and so does a row whose file is gone.
    expect([...actual.keys()].sort(), "src/ and EXPECTED_SPLIT disagree about which files exist").toEqual(
      [...EXPECTED_SPLIT.keys()].sort(),
    );

    for (const [file, { decisionPoint, split }] of EXPECTED_SPLIT) {
      expect(actual.get(file), `${file} (${decisionPoint})`).toEqual(split);
    }
  });

  /**
   * The three-node claim, stated as a walk rather than as three independent
   * facts, because the fixpoint is what makes it one claim.
   *
   * `taint-run-only-importer.ts` cannot fold (early return in `tier`), so it
   * seeds the taint set. It imports `taint-shared-config.ts`, and forward taint
   * runs along import edges from importer to imported, so `taint-shared-config.ts`
   * is forced to run even though it folds perfectly well alone.
   * `taint-capturing-sibling.ts` also folds alone, and while folding it
   * captured `sharedLabels` — a non-primitive, so it has identity and
   * `liveSources` records the capture. That capture is a REVERSE edge, from
   * source to capturer, and it is the only edge that reaches this file: its own
   * import of `taint-shared-config.ts` points the other way. So the reverse
   * half of the fixpoint, and nothing else, is what puts it on the run path.
   *
   * `taint-independent.ts` folds throughout, which is what makes the other
   * three rows mean "taint did this" rather than "this entry does not fold".
   */
  test("the taint fixpoint, and only the taint fixpoint, moves three of the four taint files", async () => {
    const result = await buildOnce(SRC, true);
    const by = (name: string) => result.foldDecisions.find((d) => basename(d.file) === name)!;

    const seed = by("taint-run-only-importer.ts");
    expect(seed.mode, "the seed must fail its own fold — it is what starts the walk").toBe("run");
    expect(seed.reverseTainted, "the seed was never overruled by the fixpoint; it could not fold").toBe(false);
    expect(seed.reason, "the seed's reason must be its own, not the fixpoint's").toContain("in a function body is not foldable");

    for (const [name, edge] of [
      ["taint-shared-config.ts", "forward: an importer that runs pulls its imports back"],
      ["taint-capturing-sibling.ts", "reverse: a captured object's source pulls the capturer back"],
    ] as const) {
      const d = by(name);
      expect(d.mode, `${name} (${edge})`).toBe("run");
      expect(d.reverseTainted, `${name} folds in isolation; only the fixpoint puts it on the run path (${edge})`).toBe(
        true,
      );
      expect(d.reason, `${name} (${edge})`).toContain("would fold in isolation, but a file that imports it");
    }

    const control = by("taint-independent.ts");
    expect(control.mode, "the control must fold, or the three rows above prove nothing").toBe("fold");
  });

  /**
   * The #2328 class, asserted where the shared differential cannot assert it.
   *
   * `nullish-property-read.ts` throws a `TypeError` when it is imported, so
   * both paths must report the identical `DiscoveryError` and neither may
   * produce a value for it. `../fold-differential.test.ts` compares this entry
   * too, and catches the #2328 regression through OUTPUT drift — revert
   * `fold()`'s nullish refusal and the fold side answers `undefined`, folds the
   * file, and emits a ConfigMap the run side never produced. What it cannot
   * reliably compare is the error itself: only the first build in a process
   * sees it (chant #2368), and by the time its both-ways comparison starts, its
   * own classification probe has already been that first build.
   *
   * Here both builds are module-isolated, so both are first builds.
   */
  test("the nullish read: same error both ways, and no value from either", async () => {
    const fold = await buildOnce(SRC, true);
    const run = await buildOnce(SRC, false);

    const foldErrors = normalizeErrors(fold.errors);
    expect(foldErrors, "fold-vs-run error parity on the #2328 fixture").toEqual(normalizeErrors(run.errors));

    expect(foldErrors, "the fixture must actually throw, or this test is vacuous").toHaveLength(1);
    expect(foldErrors[0]).toContain("nullish-property-read.ts");
    expect(foldErrors[0]).toContain("Cannot read properties of undefined (reading 'vpcId')");

    // The refusal is only worth anything if it stops a value being invented.
    // A folded `undefined` would have emitted this ConfigMap with `vpcId`
    // dropped, which is the shape #1535 shipped as `Principal: {}`.
    const rendered = JSON.stringify(normalizeOutputs(fold.outputs));
    expect(rendered, "the fold path produced a ConfigMap for a file whose run throws").not.toContain(
      "nullish-property-read",
    );
    expect(normalizeOutputs(fold.outputs), "and it agrees with run on everything it did produce").toEqual(
      normalizeOutputs(run.outputs),
    );
  });
});
