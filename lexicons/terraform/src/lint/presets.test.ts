/**
 * `terraformPlugin.lintPresets()` (chant #2113): `recommended`/`all`, and
 * that `lint.presets` + core's `resolvePresetIds`/`applyConfiguredPreset`
 * filter a terraform post-synth finding end to end: a report-only rule is
 * not reported under `recommended` and is reported under `all`.
 *
 * The terraform lexicon ships no report-only post-synth check yet (TF001,
 * TF024, TF025 are all merge-worthy. The report-only rules land in
 * #2109/#2110/#2112, in parallel with this issue), so the "report-only rule
 * excluded under recommended, included under all" half uses a synthetic
 * diagnostic and a preset id set widened with a made-up id alongside the
 * plugin's real `recommended` set, rather than inventing a permanent public
 * TF id this issue doesn't own.
 */
import { describe, test, expect } from "vitest";
import type { PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { resolvePresetIds, applyConfiguredPreset } from "@intentius/chant/lint/config";
import { terraformPlugin } from "../plugin";

describe("terraformPlugin.lintPresets()", () => {
  const presets = terraformPlugin.lintPresets?.();

  test("is defined and exports recommended + all", () => {
    expect(presets).toBeDefined();
    expect(presets?.recommended).toBeDefined();
    expect(presets?.all).toBeDefined();
  });

  test("recommended is exactly the catalog's merge-worthy ids, and all is exactly every catalog id (derived, not hand-kept)", async () => {
    const { terraformAuditCatalog } = await import("./audit-catalog");
    const expectedRecommended = Object.values(terraformAuditCatalog)
      .filter((m) => m.tier === "merge-worthy")
      .map((m) => m.id)
      .sort();
    expect(presets?.recommended.slice().sort()).toEqual(expectedRecommended);
    expect(presets?.all.slice().sort()).toEqual(Object.keys(terraformAuditCatalog).sort());
  });

  test("all is a superset of recommended", () => {
    for (const id of presets?.recommended ?? []) {
      expect(presets?.all).toContain(id);
    }
  });
});

describe("lint.presets end to end: a report-only rule is excluded under recommended, included under all (chant #2113)", () => {
  const recommendedIds = terraformPlugin.lintPresets?.().recommended ?? [];
  // Widened with a made-up report-only id, not a real TF id this issue owns,
  // see this file's header comment.
  const allIds = [...(terraformPlugin.lintPresets?.().all ?? []), "TFZZZ"];

  function diags(): PostSynthDiagnostic[] {
    return [
      { checkId: "TF001", severity: "warning", message: "a real merge-worthy TF001 finding", lexicon: "terraform" },
      { checkId: "TFZZZ", severity: "info", message: "a hypothetical report-only finding", lexicon: "terraform" },
    ];
  }

  test("under `recommended`, the report-only finding is not reported (merge-worthy TF001 still is)", () => {
    const presetIds = resolvePresetIds({ recommended: recommendedIds, all: allIds }, "recommended");
    const result = applyConfiguredPreset(diags(), presetIds, undefined);
    expect(result.diagnostics.map((d) => d.checkId)).toEqual(["TF001"]);
    expect(result.suppressed.map((d) => d.checkId)).toEqual(["TFZZZ"]);
  });

  test("under `all`, the report-only finding IS reported", () => {
    const presetIds = resolvePresetIds({ recommended: recommendedIds, all: allIds }, "all");
    const result = applyConfiguredPreset(diags(), presetIds, undefined);
    expect(result.diagnostics.map((d) => d.checkId).sort()).toEqual(["TF001", "TFZZZ"]);
    expect(result.suppressed).toEqual([]);
  });
});
