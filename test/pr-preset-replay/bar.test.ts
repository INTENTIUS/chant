/**
 * The pull request preset's bar (#5118), scored over the labelled findings in
 * `corpus.json` without running chant: the findings a replay of 159 merged
 * changes found, each labelled by hand. A change to the preset's rule lists
 * that lets a noisy rule block, or stops a true finding from blocking, fails
 * here. `replay.ts` reruns chant over the saved corpus to check the findings
 * themselves; see `replay.e2e.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PULL_REQUEST_PRESET } from "../../packages/core/src/audit/pull-request-preset";
import { BAR, barFailures, findingKey, score, type Corpus } from "./score";

const corpus = JSON.parse(readFileSync(join(import.meta.dirname, "corpus.json"), "utf-8")) as Corpus;

describe("the pull request preset on the replay corpus (#5118)", () => {
  test("every finding has a label and a reason", () => {
    for (const f of corpus.findings) {
      expect(["true", "debatable", "noise"]).toContain(f.label);
      expect(f.reason.length).toBeGreaterThan(0);
      if (f.reason.startsWith("@")) expect(corpus.reasons[f.reason.slice(1)]).toBeDefined();
    }
    expect(new Set(corpus.findings.map(findingKey)).size).toBe(corpus.findings.length);
  });

  test("meets the bar: precision, every true finding kept, few changes blocked", () => {
    const s = score(corpus.findings, PULL_REQUEST_PRESET);
    expect(barFailures(s)).toEqual([]);
    expect(s.precision).toBeGreaterThanOrEqual(BAR.precision);
    expect(s.blockedChanges.length).toBeLessThanOrEqual(BAR.maxBlockedChanges);
    expect(s.trueDropped).toEqual([]);
  });

  test("the true findings are the ones the replay recorded", () => {
    expect(corpus.findings.filter((f) => f.label === "true").length).toBe(corpus.meta.trueFindings);
  });

  test("with every rule on, the same findings miss the bar by far", () => {
    expect(score(corpus.findings).precision).toBeLessThan(0.1);
  });
});
