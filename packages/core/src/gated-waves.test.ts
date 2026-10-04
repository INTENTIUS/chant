/**
 * Gated waves (#3049): the parts with no runner. Wave layering with a canary
 * list, the set digest, gate names and the attempt record's wave entries.
 */

import { describe, expect, test } from "vitest";
import {
  ProvisionalWaveMemberError,
  UnknownCanaryError,
  WaveCycleError,
  describeChangedWave,
  layerWaves,
  readWaveRecords,
  waveGateName,
  waveSetDigest,
  withWaveRecord,
  type WaveRecord,
} from "./gated-waves";
import { changeSetDigest } from "./change-set";

/** net → a, b → app-a (on a), app-b (on b). */
const ROOTS = [
  { name: "net" },
  { name: "a", dependsOn: ["net"] },
  { name: "b", dependsOn: ["net"] },
  { name: "app-a", dependsOn: ["a"] },
  { name: "app-b", dependsOn: ["b"] },
];

describe("layerWaves", () => {
  test("dependency order, each wave sorted", () => {
    expect(layerWaves(ROOTS)).toEqual([["net"], ["a", "b"], ["app-a", "app-b"]]);
  });

  test("a canary list is wave 1 whatever the graph order, and the rest follow the graph", () => {
    expect(layerWaves(ROOTS, { canary: ["app-b"] })).toEqual([["app-b"], ["net"], ["a", "b"], ["app-a"]]);
    expect(layerWaves(ROOTS, { canary: ["b", "net"] })).toEqual([["b", "net"], ["a", "app-b"], ["app-a"]]);
  });

  test("a dependency outside the set does not hold a node back", () => {
    expect(layerWaves([{ name: "a", dependsOn: ["net"] }, { name: "app-a", dependsOn: ["a"] }])).toEqual([["a"], ["app-a"]]);
  });

  test("a canary that is not in the set is refused, unless it is known and just not changing", () => {
    expect(() => layerWaves(ROOTS, { canary: ["nope"] })).toThrow(UnknownCanaryError);
    expect(layerWaves(ROOTS.slice(0, 2), { canary: ["app-b"], known: ["app-b"] })).toEqual([["net"], ["a"]]);
  });

  test("a cycle is refused by name", () => {
    expect(() => layerWaves([{ name: "x", dependsOn: ["y"] }, { name: "y", dependsOn: ["x"] }])).toThrow(WaveCycleError);
  });
});

describe("the set digest", () => {
  const members = [
    { member: "net", planDigest: "jcs1-sha256:" + "1".repeat(64) },
    { member: "a", planDigest: "jcs1-sha256:" + "2".repeat(64) },
  ];

  test("is the change-set digest of the wave's members", () => {
    expect(waveSetDigest(members)).toBe(changeSetDigest(members));
    expect(waveSetDigest(members)).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
  });

  test("does not depend on order and moves when one root's plan does", () => {
    expect(waveSetDigest([...members].reverse())).toBe(waveSetDigest(members));
    expect(waveSetDigest([members[0], { member: "a", planDigest: "jcs1-sha256:" + "3".repeat(64) }])).not.toBe(
      waveSetDigest(members),
    );
  });

  test("refuses a wave that names one root twice", () => {
    expect(() => waveSetDigest([members[0], members[0]])).toThrow(/twice/);
  });

  test("refuses a wave holding a provisional plan, by name", () => {
    expect(() => waveSetDigest([members[0], { ...members[1], provisional: true }])).toThrow(ProvisionalWaveMemberError);
    expect(() => waveSetDigest([members[0], { ...members[1], provisional: true }])).toThrow(/provisional plan: a planned/);
  });
});

describe("wave records", () => {
  const record: WaveRecord = {
    wave: 2,
    op: "fan-out",
    gate: waveGateName("release", 2),
    components: ["a", "b"],
    digest: "jcs1-sha256:" + "4".repeat(64),
    members: [{ member: "a", planDigest: "jcs1-sha256:" + "5".repeat(64) }],
    status: "gated",
    approved: "jcs1-sha256:" + "6".repeat(64),
  };

  test("each wave has its own gate", () => {
    expect(waveGateName("release", 1)).toBe("release-wave-1");
    expect(waveGateName("release", 1)).not.toBe(waveGateName("release", 2));
  });

  test("round-trip through JSON, dropping malformed entries", () => {
    const read = readWaveRecords(JSON.parse(JSON.stringify([record, { wave: "x" }, null])));
    expect(read).toEqual([record]);
    expect(readWaveRecords(undefined)).toEqual([]);
  });

  test("a later record for the same wave replaces the earlier one", () => {
    const applied: WaveRecord = { ...record, status: "applied", approvedBy: "ana" };
    delete applied.approved;
    expect(withWaveRecord([record], applied)).toEqual([applied]);
  });

  test("the changed-set refusal names both digests and says nothing applied", () => {
    const line = describeChangedWave(record);
    expect(line).toContain(record.approved);
    expect(line).toContain(record.digest);
    expect(line).toContain("nothing in it was applied");
    expect(line).toContain("chant approve fan-out release-wave-2 --plan");
  });
});
