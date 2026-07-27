import { afterAll, describe, expect, test, vi } from "vitest";
import {
  discoverCorpus,
  loadBuild,
  loadEntityWireBuild,
  normalizeOutputs,
  outputsEqual,
  normalizeErrors,
} from "./differential-corpus";

/**
 * chant #1045 (Phase 1, epic #1019 follow-on) — the JSON-entity-boundary
 * differential.
 *
 * #1045 extracts "run these files, produce named ref-resolved entity specs"
 * (`discoverEntitySetJson`, `packages/core/src/discovery/entity-wire.ts`)
 * into a standalone entry point that emits pure JSON instead of a live,
 * identity-bearing `Map<string, Declarable>`. The wire data is round-tripped
 * through a REAL `JSON.stringify`/`JSON.parse` below (not just handed across
 * in-process) to prove it is actually JSON, not merely "JSON-shaped" — the
 * property this phase needs to prove before #1045 Phase 2 can put a process
 * boundary at this exact cut point.
 *
 * This suite reuses the #1025 differential's corpus (`differential-corpus.ts`)
 * and comparison scope (serialized `outputs` + `errors`, not `manifest`) —
 * the same 98 source directories, built two ways:
 *
 *  - `build(srcDir, …, { fold: false })` — today's in-process run path.
 *  - `discoverEntitySetJson(srcDir)` → `JSON.stringify`/`JSON.parse` →
 *    `buildFromEntitiesJson(...)` — discover, wire-encode, cross a REAL JSON
 *    round trip, decode, and run the exact same post-discovery build
 *    pipeline (`buildFromDiscoveryResult` inside `build.ts`) that `build()`
 *    itself uses.
 *
 * Every corpus entry is expected to round-trip byte-identically — unlike the
 * fold differential, there is no "run-fallback is out of scope" carve-out
 * here: the JSON path always runs discovery once (`discover()`, fold or not)
 * and encodes whatever it produced, so there's no separate fold-vs-run
 * distinction for this differential to make. A corpus entry that cannot
 * round-trip (e.g. it uses `nestedStack()` — `ChildProjectInstance` isn't
 * supported by the JSON boundary yet, see `entity-wire.ts`) is a finding to
 * report, not something to skip quietly; see {@link EXPECTED_EXCLUSIONS}.
 */

const CORPUS = discoverCorpus();

/**
 * Corpus entries known NOT to round-trip today, with why — checked by name,
 * not by count, for the same reason `fold-differential.test.ts`'s
 * `EXPECTED_FOLD` is: so a NEW exclusion (a regression) is caught by name,
 * distinct from an entry that was already excluded. Empty as of this PR — see
 * the PR description for the differential result across all 98 entries.
 */
const EXPECTED_EXCLUSIONS: ReadonlyMap<string, string> = new Map([]);

interface ReportRow {
  name: string;
  identical: boolean;
  excluded: boolean;
  error?: string;
}

const report: ReportRow[] = [];

/**
 * Build `srcDir` both ways. Mirrors `fold-differential.test.ts`'s
 * `buildBothWays`: the fast path runs both builds back to back with no
 * module-cache reset (cheap, correct for almost every entry); only on a
 * mismatch does it retry once with `vi.resetModules()` to rule out the same
 * known, fold-independent, pre-existing sharp edge (`build()` isn't safe to
 * call twice on the same directory in one process — a `propagate()`-mutated
 * composite instance compounds across repeat calls) rather than misreport
 * cross-build state bleed as a JSON-boundary defect.
 */
async function buildBothWays(entry: ReturnType<typeof discoverCorpus>[number]) {
  // chant #1112 — both sides are loaded per call, never captured once at
  // module scope, so neither is built by a chant-core copy the project files
  // were not loaded into. See {@link loadBuild} for what a stale one silently
  // drops.
  const run = async () => (await loadBuild())(entry.srcDir, entry.serializers, undefined, { fold: false });
  const viaJson = async () => {
    const { discoverEntitySetJson, buildFromEntitiesJson } = await loadEntityWireBuild();
    const json = await discoverEntitySetJson(entry.srcDir, { fold: false });
    // The actual "is this pure JSON" proof — a real wire round trip, not just
    // handing the in-memory object across.
    const wire = JSON.parse(JSON.stringify(json)) as typeof json;
    return buildFromEntitiesJson(wire, entry.serializers, entry.name);
  };

  const runResult = await run();
  const jsonResult = await viaJson();

  if (outputsEqual(normalizeOutputs(jsonResult.outputs), normalizeOutputs(runResult.outputs))) {
    return { runResult, jsonResult };
  }

  vi.resetModules();
  const freshRun = await run();
  vi.resetModules();
  const freshJson = await viaJson();
  return { runResult: freshRun, jsonResult: freshJson };
}

describe("JSON entity-boundary differential — JSON round trip === run output (chant #1045 Phase 1)", () => {
  test(`corpus is non-empty (found ${CORPUS.length} source directories)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
  });

  for (const entry of CORPUS) {
    test(`${entry.name}: JSON round trip is byte-identical to run output`, async () => {
      const excludedReason = EXPECTED_EXCLUSIONS.get(entry.name);
      if (excludedReason) {
        report.push({ name: entry.name, identical: true, excluded: true, error: excludedReason });
        return;
      }

      try {
        const { runResult, jsonResult } = await buildBothWays(entry);
        const runNorm = normalizeOutputs(runResult.outputs);
        const jsonNorm = normalizeOutputs(jsonResult.outputs);
        const identical = outputsEqual(jsonNorm, runNorm);
        report.push({ name: entry.name, identical, excluded: false });

        expect(normalizeErrors(jsonResult.errors), `JSON-vs-run error drift in ${entry.name}`).toEqual(
          normalizeErrors(runResult.errors),
        );
        expect(jsonNorm, `JSON-vs-run output drift in ${entry.name}`).toEqual(runNorm);
      } catch (err) {
        report.push({ name: entry.name, identical: false, excluded: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  }

  // A NEW exclusion (an entry that used to round-trip and now doesn't) must
  // be an intentional, understood change to `EXPECTED_EXCLUSIONS` above, not
  // a silent regression — mirrors `fold-differential.test.ts`'s coverage
  // gate.
  test("no corpus entry silently stopped round-tripping", () => {
    const byName = new Map(report.map((r) => [r.name, r]));
    const regressed = CORPUS.filter((e) => {
      const row = byName.get(e.name);
      return row && !row.identical && !EXPECTED_EXCLUSIONS.has(e.name);
    }).map((e) => e.name);
    expect(regressed, `these entries drifted or failed to round-trip: ${regressed.join(", ")}`).toEqual([]);
  });

  afterAll(() => {
    const identicalCount = report.filter((r) => r.identical && !r.excluded).length;
    const excludedCount = report.filter((r) => r.excluded).length;
    const driftCount = report.filter((r) => !r.identical).length;

    const lines = [
      "",
      "── JSON entity-boundary differential report (chant #1045 Phase 1) ──",
      `corpus: ${report.length}/${CORPUS.length} source directories built both ways`,
      `  identical: ${identicalCount}   excluded: ${excludedCount}   drift/error: ${driftCount}`,
      ...report.map(
        (r) =>
          `  [${r.excluded ? "excluded " : r.identical ? "identical" : "DRIFT    "}] ${r.name}${r.error ? `  (${r.error})` : ""}`,
      ),
      "──────────────────────────────────────────────────────────────────",
    ];
    console.log(lines.join("\n"));
  });
});
