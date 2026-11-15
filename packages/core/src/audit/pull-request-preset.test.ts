import { describe, expect, test } from "vitest";
import { findingIdentities, IDENTITY_FINGERPRINT_KEY } from "./identity";
import {
  applyRulePreset,
  presetGate,
  presetSummary,
  PULL_REQUEST_PRESET,
  readBaselineIdentities,
  resolveRulePreset,
  type PresetInput,
} from "./pull-request-preset";

const f = (checkId: string, over: Partial<PresetInput> = {}): PresetInput => ({ checkId, file: "a.yaml", severity: "error", ...over });

describe("the pull request preset (#5118)", () => {
  test("resolves by name", () => {
    expect(resolveRulePreset("pull-request")).toBe(PULL_REQUEST_PRESET);
    expect(resolveRulePreset("strict")).toBeUndefined();
  });

  test("places a rule in its set, and leaves out a rule in none", () => {
    expect(presetGate(PULL_REQUEST_PRESET, "WK8501", "error")).toBe("merge-blocking");
    expect(presetGate(PULL_REQUEST_PRESET, "SEC007", "error")).toBe("merge-blocking");
    expect(presetGate(PULL_REQUEST_PRESET, "WK8102", "warning")).toBe("report-only");
    // Proposed as merge-blocking, none true on two windows of the replay.
    expect(presetGate(PULL_REQUEST_PRESET, "WK8203", "warning")).toBe("report-only");
    expect(presetGate(PULL_REQUEST_PRESET, "TF002", "warning")).toBe("report-only");
    expect(presetGate(PULL_REQUEST_PRESET, "LEX002", "error")).toBe("notice");
    expect(presetGate(PULL_REQUEST_PRESET, "COR001", "warning")).toBeUndefined();
    expect(presetGate(PULL_REQUEST_PRESET, "SEC010", "error")).toBeUndefined();
    expect(presetGate(PULL_REQUEST_PRESET, "NEW999", "error")).toBeUndefined();
  });

  test("the floor leaves out an info finding of a merge-blocking rule", () => {
    expect(presetGate(PULL_REQUEST_PRESET, "GRAF103", "info")).toBeUndefined();
    expect(presetGate(PULL_REQUEST_PRESET, "GRAF103", "warning")).toBe("merge-blocking");
  });

  test("no rule is in two sets, and no off rule is in a set", () => {
    const sets = [PULL_REQUEST_PRESET.mergeBlocking, PULL_REQUEST_PRESET.reportOnly, PULL_REQUEST_PRESET.notices];
    const all = sets.flat();
    expect(new Set(all).size).toBe(all.length);
    for (const id of Object.keys(PULL_REQUEST_PRESET.off)) expect(all).not.toContain(id);
  });

  test("a baseline drops the findings the base already had, by identity", () => {
    const base = [f("WK8501", { entity: "app" }), f("WK8102", { entity: "app", severity: "warning" })];
    const head = [...base, f("WK8501", { entity: "other" }), f("COR001", { severity: "warning" })];
    const baseline = new Set(findingIdentities(base));
    const r = applyRulePreset(PULL_REQUEST_PRESET, head, baseline);
    expect(r.mergeBlocking.map((x) => x.entity)).toEqual(["other"]);
    expect(r.reportOnly).toEqual([]);
    expect(r.unchanged).toBe(2);
    expect(r.off).toBe(1);
  });

  test("identities are computed over the whole run, so a new second finding is told from the old first", () => {
    const one = f("WK8501", { entity: "app", locator: "spec.x" });
    const r = applyRulePreset(PULL_REQUEST_PRESET, [one, { ...one }], new Set(findingIdentities([one])));
    expect(r.mergeBlocking).toHaveLength(1);
    expect(r.mergeBlocking[0].identity).toBe(findingIdentities([one, one])[1]);
  });

  test("a tool notice is reported whatever the baseline holds", () => {
    const n = f("LEX002");
    const r = applyRulePreset(PULL_REQUEST_PRESET, [n], new Set(findingIdentities([n])));
    expect(r.notices).toHaveLength(1);
    expect(r.mergeBlocking).toHaveLength(0);
  });

  test("summary line", () => {
    const r = applyRulePreset(PULL_REQUEST_PRESET, [f("WK8501"), f("COR001")], new Set());
    expect(presetSummary(PULL_REQUEST_PRESET, r, true)).toBe(
      "Preset pull-request: 1 merge-blocking finding, 0 report-only, 0 already on the base, 1 left out by the preset.",
    );
  });
});

describe("readBaselineIdentities", () => {
  test("reads an audit JSON report", () => {
    expect([...readBaselineIdentities(JSON.stringify({ findings: [{ identity: "a" }, { identity: "b" }] }))]).toEqual(["a", "b"]);
  });

  test("reads SARIF partialFingerprints", () => {
    const sarif = { runs: [{ results: [{ partialFingerprints: { [IDENTITY_FINGERPRINT_KEY]: "x" } }, {}] }] };
    expect([...readBaselineIdentities(JSON.stringify(sarif))]).toEqual(["x"]);
  });

  test("reads the lint --preset JSON array, and refuses a plain lint array", () => {
    expect([...readBaselineIdentities(JSON.stringify([{ identity: "y" }]))]).toEqual(["y"]);
    expect(readBaselineIdentities("[]").size).toBe(0);
    expect(() => readBaselineIdentities(JSON.stringify([{ ruleId: "COR001" }]))).toThrow(/--preset/);
  });

  test("refuses text that is no report, rather than reading an empty baseline", () => {
    expect(() => readBaselineIdentities("not json")).toThrow(/not JSON/);
    expect(() => readBaselineIdentities("{}")).toThrow(/findings/);
  });
});
