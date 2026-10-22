/**
 * A failed member blocks only the members that depend on it (#4291): the
 * rule, the walk over earlier waves, and the outcome files a wave job hands
 * the next one. The rules are terragucci's `blocked.ts`, lifted.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  blockedMembers,
  blockedWords,
  earlierWaveOutcomes,
  onlyWaiting,
  runSummary,
  settleEarlierWaves,
  waveOutcomeFileName,
  writeWaveOutcomeFile,
  type WaveMemberOutcome,
} from "./wave-blocked";

/** cluster-a and cluster-b, then app-01 (reads cluster-a) and app-02 (reads cluster-b), then edge (reads app-01). */
const UPSTREAMS = new Map<string, string[]>([
  ["app-01", ["cluster-a"]],
  ["app-02", ["cluster-b"]],
  ["edge", ["app-01"]],
]);
const WAVES = [["cluster-a", "cluster-b"], ["app-01", "app-02"], ["edge"]];

describe("blockedMembers", () => {
  test("a failed upstream blocks its dependents and names itself; the rest go through", () => {
    const outcomes = new Map<string, WaveMemberOutcome>([
      ["cluster-a", { status: "failed" }],
      ["cluster-b", { status: "applied" }],
    ]);
    const blocked = blockedMembers(["app-01", "app-02"], UPSTREAMS, new Set(WAVES[0]), outcomes);
    expect([...blocked]).toEqual([["app-01", "cluster-a"]]);
  });

  test("a blocked upstream passes on the member that blocked it", () => {
    const outcomes = new Map<string, WaveMemberOutcome>([["app-01", { status: "blocked", by: "cluster-a" }]]);
    expect([...blockedMembers(["edge"], UPSTREAMS, new Set(["app-01"]), outcomes)]).toEqual([["edge", "cluster-a"]]);
  });

  test("unchanged lets a dependent through; an upstream with no outcome holds it", () => {
    expect(blockedMembers(["app-01"], UPSTREAMS, new Set(["cluster-a"]), new Map([["cluster-a", { status: "unchanged" }]])).size).toBe(0);
    expect([...blockedMembers(["app-01"], UPSTREAMS, new Set(["cluster-a"]), new Map())]).toEqual([["app-01", "cluster-a"]]);
  });

  test("an upstream outside the earlier waves is no upstream here", () => {
    expect(blockedMembers(["app-01"], UPSTREAMS, new Set(), new Map([["cluster-a", { status: "failed" }]])).size).toBe(0);
  });

  test("a wave that holds all blocks every member by its name", () => {
    expect([...blockedMembers(["app-01", "app-02"], UPSTREAMS, new Set(), new Map(), 1)]).toEqual([
      ["app-01", "wave-1"],
      ["app-02", "wave-1"],
    ]);
  });
});

describe("settleEarlierWaves", () => {
  test("walks the earlier waves, blocking behind failures, and names what has not run", () => {
    const { outcomes, unsettled } = settleEarlierWaves(
      WAVES,
      4,
      UPSTREAMS,
      new Map([
        ["cluster-a", { status: "failed" }],
        ["cluster-b", { status: "applied" }],
      ]),
    );
    expect(outcomes.get("app-01")).toEqual({ status: "blocked", by: "cluster-a" });
    expect(outcomes.get("edge")).toEqual({ status: "blocked", by: "cluster-a" });
    expect(unsettled).toEqual(["app-02"]);
  });
});

describe("onlyWaiting, blockedWords and runSummary", () => {
  test("a run whose only holds are a wait, and what it blocked, waits", () => {
    expect(
      onlyWaiting(
        new Map<string, WaveMemberOutcome>([
          ["cluster-a", { status: "waiting" }],
          ["app-01", { status: "blocked", by: "cluster-a" }],
          ["cluster-b", { status: "applied" }],
        ]),
      ),
    ).toBe(true);
    expect(onlyWaiting(new Map<string, WaveMemberOutcome>([["cluster-a", { status: "failed" }]]))).toBe(false);
    expect(onlyWaiting(new Map<string, WaveMemberOutcome>([["cluster-a", { status: "applied" }]]))).toBe(false);
  });

  test("the blocked set reads grouped by what blocked it", () => {
    expect(blockedWords(new Map([["edge", "cluster-a"], ["app-01", "cluster-a"], ["app-02", "cluster-b"]]))).toBe(
      "app-01, edge (blocked by cluster-a); app-02 (blocked by cluster-b)",
    );
  });

  test("the run's summary counts each status, and is undefined when all applied", () => {
    expect(runSummary([{ status: "applied" }, { status: "unchanged" }])).toBeUndefined();
    expect(runSummary([{ status: "applied" }, { status: "failed" }, { status: "blocked", by: "x" }, { status: "waiting" }])).toBe(
      "1 applied, 1 failed, 1 blocked, 1 waiting",
    );
  });
});

describe("outcome files", () => {
  test("the newest outcome of a member wins, later waves are left out, and terragucci's roots key reads too", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-wave-outcomes-"));
    try {
      writeWaveOutcomeFile(dir, 1, {}, { "cluster-a": { status: "failed" }, "cluster-b": { status: "applied" } }, "2026-10-18T10:00:00.000Z");
      const rerun = join(dir, "rerun");
      mkdirSync(rerun);
      writeWaveOutcomeFile(rerun, 1, {}, { "cluster-a": { status: "applied" } }, "2026-10-18T11:00:00.000Z");
      writeFileSync(
        join(dir, waveOutcomeFileName(2, { share: 1 })),
        JSON.stringify({ version: 1, wave: 2, at: "2026-10-18T10:05:00.000Z", roots: { "app-01": { status: "applied" } } }),
      );
      writeWaveOutcomeFile(dir, 3, {}, { edge: { status: "failed" } }, "2026-10-18T10:10:00.000Z");
      writeFileSync(join(dir, "outcome-wave-9.json"), "not json");

      const { members, holdsAll } = earlierWaveOutcomes([dir], 3);
      expect(holdsAll).toBeUndefined();
      expect(Object.fromEntries([...members].map(([m, o]) => [m, o.status]))).toEqual({
        "cluster-a": "applied",
        "cluster-b": "applied",
        "app-01": "applied",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a wave that holds all is named", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-wave-outcomes-"));
    try {
      writeWaveOutcomeFile(dir, 1, { group: "core/x" }, {}, "2026-10-18T10:00:00.000Z", true);
      expect(waveOutcomeFileName(1, { group: "core/x" })).toBe("outcome-wave-1-group-core_x.json");
      expect(earlierWaveOutcomes([dir], 2).holdsAll).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
