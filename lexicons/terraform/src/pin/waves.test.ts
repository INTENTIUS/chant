import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { loadHcl2json } from "@intentius/chant/terraform/parse";
import { planPinWaves, restrictWaves, terragruntDependencies, wavesFromChoudoufu, PinWavePlanError } from "./waves";

/** choudoufu#1750's N=5 shape: e02 reads e01, e03 reads e02; e04 and e05 read nothing. */
const N5 = [
  { root: "estates/e01" },
  { root: "estates/e02", dependsOn: ["estates/e01"] },
  { root: "estates/e03", dependsOn: ["estates/e02"] },
  { root: "estates/e04" },
  { root: "estates/e05" },
];

describe("planPinWaves (#3189)", () => {
  test("a canary list forms wave 1, and dependency order forms the rest", () => {
    expect(planPinWaves(N5, ["estates/e04"])).toEqual([
      { wave: 1, canary: true, roots: ["estates/e04"] },
      { wave: 2, canary: false, roots: ["estates/e01", "estates/e05"] },
      { wave: 3, canary: false, roots: ["estates/e02"] },
      { wave: 4, canary: false, roots: ["estates/e03"] },
    ]);
  });

  test("no reader lands in a wave before what it reads", () => {
    const waves = planPinWaves(N5);
    const waveOf = new Map(waves.flatMap((w) => w.roots.map((r) => [r, w.wave] as const)));
    for (const r of N5) for (const d of r.dependsOn ?? []) expect(waveOf.get(d)!, `${r.root} after ${d}`).toBeLessThan(waveOf.get(r.root)!);
  });

  test("the canary wave whatever the graph order, even a root others read", () => {
    expect(planPinWaves(N5, ["estates/e01"]).map((w) => w.roots)).toEqual([["estates/e01"], ["estates/e02", "estates/e04", "estates/e05"], ["estates/e03"]]);
  });

  test("a canary that reads a root outside the canaries is refused", () => {
    expect(() => planPinWaves(N5, ["estates/e03"])).toThrow(/canary estates\/e03 depends on estates\/e02, which is not a canary/);
  });

  test("a canary that is not a root, and a cycle, are refused by name", () => {
    expect(() => planPinWaves(N5, ["estates/e09"])).toThrow(PinWavePlanError);
    expect(() =>
      planPinWaves([
        { root: "a", dependsOn: ["b"] },
        { root: "b", dependsOn: ["a"] },
      ]),
    ).toThrow(/dependency cycle among roots: a, b/);
  });

  test("a dependency outside the rollout orders nothing", () => {
    expect(planPinWaves([{ root: "a", dependsOn: ["elsewhere"] }])).toEqual([{ wave: 1, canary: false, roots: ["a"] }]);
  });
});

describe("wavesFromChoudoufu", () => {
  // `choudoufu live-waves -json -canary=estates/e04` over choudoufu#1750's N=5 fixture, recorded from choudoufu main.
  const doc = JSON.parse(readFileSync(new URL("../__fixtures__/pin/choudoufu-live-waves-n5.json", import.meta.url), "utf-8"));

  test("takes each wave's root list as choudoufu's planner emits it", () => {
    expect(wavesFromChoudoufu(doc)).toEqual([
      { wave: 1, canary: true, roots: ["estates/e04"] },
      { wave: 2, canary: false, roots: ["estates/e01", "estates/e05"] },
      { wave: 3, canary: false, roots: ["estates/e02"] },
      { wave: 4, canary: false, roots: ["estates/e03"] },
    ]);
  });

  test("agrees with the declared-order planner on the same graph", () => {
    expect(wavesFromChoudoufu(doc)).toEqual(planPinWaves(N5, ["estates/e04"]));
  });

  test("a prefix places the roots under the directory choudoufu ran in", () => {
    expect(wavesFromChoudoufu(doc, "infra")[0]!.roots).toEqual(["infra/estates/e04"]);
  });

  test("refuses another format", () => {
    expect(() => wavesFromChoudoufu({ format_version: "2", waves: [] })).toThrow(/format version 1/);
  });

  test("restrictWaves drops roots not moving and renumbers", () => {
    expect(restrictWaves(wavesFromChoudoufu(doc), new Set(["estates/e02", "estates/e05"]))).toEqual([
      { wave: 1, canary: false, roots: ["estates/e05"] },
      { wave: 2, canary: false, roots: ["estates/e02"] },
    ]);
  });
});

describe("terragruntDependencies", () => {
  test("reads dependency config_path and dependencies paths, relative to the unit", async () => {
    const parser = await loadHcl2json();
    const text = [
      `dependency "vpc" {`,
      `  config_path = "../vpc"`,
      `  mock_outputs = { id = "x" }`,
      `}`,
      `dependencies {`,
      `  paths = ["../dns", "\${get_repo_root()}/x"]`,
      `}`,
    ].join("\n");
    expect(await terragruntDependencies("live/prod/app", text, parser)).toEqual(["live/prod/dns", "live/prod/vpc"]);
  });
});
