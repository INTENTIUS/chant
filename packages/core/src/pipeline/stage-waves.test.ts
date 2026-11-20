/**
 * A stage's op waves for `components promote` (#5427): the spec the promote
 * writes, the gate read at base from the fold, what a stage applied of a
 * release, the waves run in order, and the records' component.
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEXT_RELEASE } from "../release-floors";
import { readOpWavePolicy, type RunOpWaveOptions, type RunOpWaveResult } from "../op/op-waves-run";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import { asPipelineSpec, type PipelineDeclaration } from "./spec";
import { stageWavesSpec } from "./stages";
import { pipelineStageShow, PROMOTE_STAGE_WAVES_FLOOR, runStageWaves, stageReleaseItems, stageRunSpec, stageRunsWaves } from "./stage-waves";

const declaration = (over: Partial<PipelineDeclaration> = {}): PipelineDeclaration => ({
  name: "yodel-apply",
  defaults: { op: "yodel-apply", step: { kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" } },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }, { name: "staging-eu", runs: [{ target: "staging-eu" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], gate: { policy: "on-destructive" } },
  ],
  ...over,
});

const spec = asPipelineSpec(declaration());

const SHA = "c".repeat(40);
const V1 = `sha256:${"1".repeat(64)}`;

const record = (over: Partial<ReleaseRecord>): ReleaseRecord =>
  ({ version: 1, component: "yodel-apply", env: "dev", digest: `sha256:${"d".repeat(64)}`, gitSha: SHA, runId: "r", timestamp: "2026-11-20T10:00:00.000Z", actor: "ci", ...over }) as ReleaseRecord;

const ok = (applied: string[]): RunOpWaveResult => ({ exitCode: 0, applied, failed: [], moved: [], hooks: [] });

describe("the spec a promote runs for a stage", () => {
  test("names the stage's rendered spec file in the step's spec input", () => {
    const staging = stageRunSpec(spec, "staging");
    expect(staging.name).toBe("yodel-apply-staging");
    expect(staging.labels).toEqual({ Env: "staging" });
    expect(staging.step).toEqual({ kind: "sql-migrate", environment: "{target}", spec: ".chant/op-waves/yodel-apply-staging.spec.json" });
  });

  test("leaves a step without a spec input as it is", () => {
    const pulumi = asPipelineSpec(declaration({ defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } } }));
    expect(stageRunSpec(pulumi, "prod").step).toEqual({ kind: "pulumi-up", stack: "{target}" });
  });

  test("a stage runs its waves on promote only when the pipeline has a step", () => {
    expect(stageRunsWaves(spec, "staging")).toBe(true);
    expect(stageRunsWaves(spec, "qa")).toBe(false);
    expect(stageRunsWaves(asPipelineSpec(declaration({ defaults: { op: "shop" } })), "staging")).toBe(false);
  });
});

describe("the component a stage's records go under", () => {
  test("targets that name environments take the pipeline's name, in every stage", () => {
    for (const stage of ["dev", "staging", "prod"]) expect(stageWavesSpec(spec, stage).release).toEqual({ component: "yodel-apply" });
  });

  test("the defaults' own component or false wins", () => {
    expect(stageWavesSpec(asPipelineSpec(declaration({ defaults: { ...declaration().defaults, release: { component: "orders" } } })), "staging").release).toEqual({ component: "orders" });
    expect(stageWavesSpec(asPipelineSpec(declaration({ defaults: { ...declaration().defaults, release: false } })), "staging").release).toBe(false);
  });

  test("a target every stage runs names its own records", () => {
    const roots = asPipelineSpec(
      declaration({
        defaults: { op: "infra", step: { kind: "terraform-apply", root: "{target}" } },
        stages: [
          { name: "dev", waves: [{ name: "dev", runs: [{ target: "network" }] }] },
          { name: "prod", waves: [{ name: "prod", runs: [{ target: "network" }] }] },
        ],
      }),
    );
    expect(stageWavesSpec(roots, "prod").release).toBeUndefined();
  });
});

describe("the gate a stage's wave reads at base", () => {
  test("comes from the pipeline folded at that commit", () => {
    const text = `import { pipeline } from "@intentius/chant/pipeline";\n\nexport default pipeline(${JSON.stringify(declaration())});\n`;
    const show = pipelineStageShow(
      (base) => ({ sha: base === "base" ? "b".repeat(40) : base, text: null }),
      (commit, file) => (file === ".chant/pipeline.ts" && commit === "b".repeat(40) ? text : null),
    );
    const rules = readOpWavePolicy(".chant/op-waves/yodel-apply-prod.spec.json", "prod", "base", "/", show);
    expect(rules).toMatchObject({ policy: "on-destructive", source: "base" });
    expect(JSON.parse(show("base", ".chant/op-waves/yodel-apply-staging.spec.json", "/").text!)).toEqual(stageRunSpec(spec, "staging"));
  });

  test("reads as absent, so always, when the commit has no pipeline or no such stage", () => {
    const show = pipelineStageShow(() => ({ sha: "b".repeat(40), text: null }), () => null);
    expect(readOpWavePolicy(".chant/op-waves/yodel-apply-prod.spec.json", "prod", "base", "/", show)).toMatchObject({ policy: "always", source: "absent-at-base" });
  });

  test("hands every other file to the fallback", () => {
    const show = pipelineStageShow((_b, path) => ({ sha: "b".repeat(40), text: `file ${path}` }), () => null);
    expect(show("base", "yodel-waves.json", "/").text).toBe("file yodel-waves.json");
  });
});

describe("what a stage applied of a release", () => {
  test("the newest record per component naming the release or its commit, on the stage's ledger", () => {
    const records = [
      record({ env: "dev", timestamp: "2026-11-20T09:00:00.000Z" }),
      record({ env: "dev", timestamp: "2026-11-20T10:00:00.000Z" }),
      record({ env: "staging", releaseDigest: V1, gitSha: "e".repeat(40) }),
      record({ env: "dev", gitSha: "f".repeat(40), component: "other" }),
    ];
    const dev = stageReleaseItems(records, "dev", { releaseDigest: V1, commit: SHA });
    expect(dev).toHaveLength(1);
    expect(dev[0]).toMatchObject({ component: "yodel-apply", source: { timestamp: "2026-11-20T10:00:00.000Z" } });
    expect(stageReleaseItems(records, "staging", { releaseDigest: V1, commit: SHA })).toHaveLength(1);
    expect(stageReleaseItems(records, "prod", { releaseDigest: V1, commit: SHA })).toEqual([]);
  });
});

describe("running a stage's waves", () => {
  test("writes the spec file and runs the waves in order with the gate read at base and no stand-down", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-stage-waves-"));
    const calls: RunOpWaveOptions[] = [];
    const ran = await runStageWaves({
      spec,
      stage: "staging",
      base: "b".repeat(40),
      cwd,
      release: { releaseDigest: V1 },
      options: { releases: false },
      run: async (o) => {
        calls.push(o);
        return ok([o.spec.waves[o.wave - 1]!.runs[0]!.target]);
      },
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.specFile).toBe(".chant/op-waves/yodel-apply-staging.spec.json");
    expect(JSON.parse(readFileSync(join(cwd, ran.specFile), "utf-8"))).toEqual(stageRunSpec(spec, "staging"));
    expect(calls.map((c) => [c.wave, c.base, c.specFile, c.standDown])).toEqual([
      [1, "b".repeat(40), ".chant/op-waves/yodel-apply-staging.spec.json", false],
      [2, "b".repeat(40), ".chant/op-waves/yodel-apply-staging.spec.json", false],
    ]);
    expect(ran.waves.map((w) => w.result.applied)).toEqual([["staging"], ["staging-eu"]]);
  });

  test("stops at the first wave that waits, and runs none after it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "chant-stage-waves-"));
    const told: number[] = [];
    const ran = await runStageWaves({
      spec,
      stage: "staging",
      base: "b".repeat(40),
      cwd,
      release: { releaseDigest: V1 },
      options: { releases: false },
      run: async () => ({ ...ok([]), exitCode: 3 }),
      afterWave: async (w) => void told.push(w.wave),
    });
    expect(ran.exitCode).toBe(3);
    expect(ran.waves).toHaveLength(1);
    expect(told).toEqual([1]);
  });
});

test("the floor is the next release", () => {
  expect(PROMOTE_STAGE_WAVES_FLOOR).toBe(NEXT_RELEASE);
});
