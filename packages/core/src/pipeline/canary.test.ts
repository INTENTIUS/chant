import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import { assertOpWavesSpec, opWavesCanaryWarnings, type OpWavesSpec } from "../op/op-waves";
import { opWaveSoaksBefore, opWaveSoakStop } from "../op/op-waves-soak";
import { fanOutCanarySoak, fanOutCanarySoakOf, fanOutHasCanaryWave } from "../components/fan-out-canary";
import { canaryConfigDiagnostics } from "../lint/canary-checks";
import type { WaveRecord } from "../gated-waves";
import { pipelineSoakSection } from "./diff";
import { pipelineFromConfig } from "./product";
import { pipelinePromoteSoaks } from "./promote";
import { soakCheckCount, soakCheckName, type Soak, type SoakCheckReader, type SoakCheckResult } from "./soak";
import { asPipelineSpec, canaryStagesBefore, pipelineSpecProblems, type PipelineSpec } from "./spec";
import { stageWavesSpec } from "./stages";

const T0 = "2026-03-01T10:00:00.000Z";
const at = (h: number) => new Date(Date.parse(T0) + h * 3_600_000);
const DIGEST = "sha256:" + "c".repeat(64);

/** A fake reader: each check by name answers from `answers`, else passes. */
function fake(answers: Record<string, SoakCheckResult["status"]> = {}): SoakCheckReader {
  return async (check) => {
    const name = soakCheckName(check);
    const status = answers[name] ?? "passed";
    return { status, detail: `${name} ${status}` };
  };
}

const soak: Soak = { duration: "2h", checks: [{ kind: "http", name: "up", url: "https://canary.example/healthz" }] };
const wave = (name: string) => ({ name, runs: [{ target: name }] });
const step = { kind: "pulumi-up", stack: "{target}" } as const;
const defaults = { op: "shop", step, runner: "ubuntu-latest" } as const;

/** dev, then the canary, then prod-a, then prod-b. */
const spec = asPipelineSpec({
  name: "shop",
  stages: [
    { name: "dev", waves: [wave("dev")] },
    { name: "canary", canary: true, waves: [wave("canary")], soak },
    { name: "prod-a", waves: [wave("prod-a")] },
    { name: "prod-b", waves: [wave("prod-b")] },
  ],
}) as PipelineSpec;

describe("declaring a canary", () => {
  test("a canary stage takes a soak with at least one check, its own or an override's", () => {
    const stages = (canary: Record<string, unknown>) => [{ name: "dev", waves: [wave("dev")], ...canary }, { name: "prod", waves: [wave("prod")] }];
    expect(pipelineSpecProblems({ name: "p", stages: stages({ canary: true }) }).join()).toContain('stage "dev" is the canary and its soak has no checks');
    expect(pipelineSpecProblems({ name: "p", stages: stages({ canary: true, soak: { duration: "1h" } }) }).join()).toContain("has no checks");
    expect(pipelineSpecProblems({ name: "p", stages: stages({ canary: true, soak }) })).toEqual([]);
    expect(pipelineSpecProblems({ name: "p", stages: stages({ canary: true, soak: { duration: "1h", overrides: [{ members: ["a"], checks: [{ kind: "drift" }] }] } }) })).toEqual([]);
    expect(pipelineSpecProblems({ name: "p", stages: stages({ canary: false }) })).toEqual([]);
    expect(soakCheckCount(undefined)).toBe(0);
  });

  test("a canary wave goes first, has a wave after it, and takes its own soak or the stage's", () => {
    const stage = (waves: unknown[], extra: Record<string, unknown> = {}) => ({ name: "p", stages: [{ name: "dev", waves, ...extra }] });
    expect(pipelineSpecProblems(stage([{ ...wave("a"), canary: true, soak }, wave("b")]))).toEqual([]);
    expect(pipelineSpecProblems(stage([{ ...wave("a"), canary: true }, wave("b")], { soak }))).toEqual([]);
    expect(pipelineSpecProblems(stage([{ ...wave("a"), canary: true }, wave("b")])).join()).toContain("canary wave with no soak checks");
    expect(pipelineSpecProblems(stage([wave("a"), { ...wave("b"), canary: true, soak }, wave("c")])).join()).toContain("not the stage's first wave");
    expect(pipelineSpecProblems(stage([{ ...wave("a"), canary: true }], { soak })).join()).toContain("the stage's only wave");
    expect(pipelineSpecProblems(stage([{ ...wave("a"), canary: "yes" }, wave("b")])).join()).toContain("canary must be true or false");
  });

  test("the stage's op waves give a canary wave with no soak of its own the stage's", () => {
    const s = asPipelineSpec({ name: "p", defaults, stages: [{ name: "dev", waves: [{ ...wave("a"), canary: true }, wave("b")], soak }] }) as PipelineSpec;
    const waves = stageWavesSpec(s, "dev").waves;
    expect(waves[0]).toMatchObject({ canary: true, soak });
    expect(waves[1]!.soak).toBeUndefined();
  });

  test("a product maps environments.<name>.canary onto the stage and its waves.canary onto the first wave, with no key of its own", () => {
    const waves = { dev: [{ ...wave("canary"), canary: true }, wave("dev")], prod: [wave("prod")] };
    const soakConfig = { duration: "1h", checks: [{ kind: "http", url: "https://x", on_fail: "hold" }] };
    expect(() => pipelineFromConfig({ name: "shop", promotion: ["dev", "prod"], waves, environments: { dev: { canary: true } } })).toThrow(/is the canary and its soak has no checks/);
    const d = pipelineFromConfig({ name: "shop", promotion: ["dev", "prod"], waves, defaults, environments: { dev: { canary: true, soak: soakConfig } } });
    expect(d.stages[0]).toMatchObject({ canary: true, waves: [{ name: "canary", canary: true }, { name: "dev" }] });
    expect(stageWavesSpec(asPipelineSpec(d) as PipelineSpec, "dev").waves[0]!.soak).toEqual({ duration: "1h", checks: [{ kind: "http", url: "https://x", onFail: "hold" }] });
  });

  test("the plan note says the canary holds every stage after it", () => {
    const section = pipelineSoakSection(spec)!;
    expect(section).toContain("A promotion from `canary` into `prod-a` waits for `canary` to soak");
    expect(section).toContain("`canary` is the canary: a promotion into `prod-b` waits for its soak too.");
  });
});

describe("a canary stage holds every stage after it", () => {
  test("the canaries a stage follows, through the stages between and through after", () => {
    expect(canaryStagesBefore(spec, "prod-b").map((s) => s.name)).toEqual(["canary"]);
    expect(canaryStagesBefore(spec, "canary")).toEqual([]);
    expect(canaryStagesBefore(spec, "dev")).toEqual([]);
    const graph = asPipelineSpec({
      name: "g",
      stages: [
        { name: "dev", waves: [wave("dev")] },
        { name: "canary", canary: true, waves: [wave("canary")], soak },
        { name: "eu", waves: [wave("eu")], after: ["dev"] },
        { name: "us", waves: [wave("us")], after: ["canary", "eu"] },
      ],
    });
    expect(canaryStagesBefore(graph, "us").map((s) => s.name)).toEqual(["canary"]);
    expect(canaryStagesBefore(graph, "eu")).toEqual([]);
  });

  const promote = (read: SoakCheckReader, now: Date, applied: Record<string, string | undefined> = { canary: T0, "prod-a": T0 }, port = memoryGateLedgerPort()) =>
    pipelinePromoteSoaks({
      spec,
      from: "prod-a",
      to: "prod-b",
      items: async (stage) => (applied[stage] ? [{ component: "app", source: { timestamp: applied[stage]! } }] : []),
      digest: DIGEST,
      releaseDigest: DIGEST,
      port,
      read: () => read,
      now,
    });

  test("a passing canary: a promote from a later stage opens once the canary soaked and its checks pass", async () => {
    const early = await promote(fake(), at(1));
    expect(early).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-soak-waiting" });
    expect(early.passed ? "" : early.message).toContain("stage prod-b waits for the soak of canary");
    const soaked = await promote(fake(), at(3));
    expect(soaked).toMatchObject({ passed: true, notes: [] });
    expect(soaked.lines).toEqual(["canary soaked for 2h since 2026-03-01T10:00:00.000Z, and its checks pass"]);
  });

  test("a failing canary holds the stage after the next one through the canary's own gate", async () => {
    const port = memoryGateLedgerPort();
    const held = await promote(fake({ up: "failed" }), at(3), undefined, port);
    expect(held).toMatchObject({ passed: false, exitCode: 3 });
    expect(port.appended).toMatchObject([{ gate: "canary-soak", environment: "canary", soak: { stage: "canary", to: "prod-b", failing: ["up"] } }]);
    // A person ends the canary's soak through that gate, and the promote goes on to the gates.
    await port.appendResolution!({ op: "shop", gate: "canary-soak", resolvedBy: "dana", timestamp: at(3.1).toISOString(), planDigest: DIGEST, releaseDigest: DIGEST, environment: "canary" } as never);
    expect(await promote(fake({ up: "failed" }), at(3.2), undefined, port)).toMatchObject({ passed: true, lines: ["the soak of canary was ended early by dana through shop canary-soak"] });
  });

  test("a release that skipped the canary has no clock there and holds", async () => {
    const held = await promote(fake(), at(30), { "prod-a": T0 });
    expect(held).toMatchObject({ passed: false, exitCode: 3 });
    expect(held.notes.join()).toContain("the canary stage canary has no apply of what this promote deploys");
  });

  test("the stage right after the canary reads its soak once, as #5326 does", async () => {
    const port = memoryGateLedgerPort();
    const got = await pipelinePromoteSoaks({ spec, from: "canary", to: "prod-a", items: async () => [{ component: "app", source: { timestamp: T0 } }], digest: DIGEST, port, read: () => fake(), now: at(1) });
    expect(got.passed).toBe(false);
    expect(port.appended).toHaveLength(1);
  });
});

describe("the canary wave", () => {
  const roll = (canary: Partial<{ soak: Soak }> & { canary?: boolean } = { canary: true, soak }) =>
    ({ name: "roll", op: "roll", step, runner: "ubuntu-latest", labels: { Env: "prod" }, waves: [{ ...wave("canary"), ...canary }, wave("b"), wave("c")] }) as unknown as OpWavesSpec;
  const applied = async () => ({ subjects: [{ member: "canary", targets: ["canary"], appliedAt: T0 }], digest: DIGEST });

  test("its soak is read before every later wave, once each", () => {
    expect(opWaveSoaksBefore(roll(), 1)).toEqual([]);
    expect(opWaveSoaksBefore(roll(), 2)).toEqual([1]);
    expect(opWaveSoaksBefore(roll(), 3)).toEqual([1]);
    expect(opWaveSoaksBefore(roll({ canary: false, soak }), 3)).toEqual([]);
  });

  test("a failing canary holds wave 3 through gate <gate>-wave-1-soak; a passing one lets it plan", async () => {
    const port = memoryGateLedgerPort();
    const held = await opWaveSoakStop({ spec: roll(), k: 3, cwd: ".", gates: port, soak: { applied, read: fake({ up: "failed" }), now: at(3) }, log: () => {} });
    expect(held).toMatchObject({ passed: false, exitCode: 3 });
    expect(port.appended[0]).toMatchObject({ gate: "roll-wave-1-soak", soak: { wave: 1 } });
    expect(await opWaveSoakStop({ spec: roll(), k: 3, cwd: ".", gates: memoryGateLedgerPort(), soak: { applied, read: fake(), now: at(3) }, log: () => {} })).toBeUndefined();
  });

  test("the marker goes on the first wave only; one with no soak checks warns and is not refused", () => {
    expect(() => assertOpWavesSpec({ ...roll(), waves: [wave("a"), { ...wave("b"), canary: true }] } as unknown as OpWavesSpec)).toThrow(/canary wave and not the first wave/);
    expect(opWavesCanaryWarnings(roll())).toEqual([]);
    expect(opWavesCanaryWarnings(roll({ canary: true })).join()).toContain("is the canary and has no soak checks");
    expect(opWavesCanaryWarnings(roll({ canary: false }))).toEqual([]);
    expect(() => assertOpWavesSpec(roll({ canary: true }))).not.toThrow();
  });
});

describe("fan-out --canary", () => {
  const record = (extra: Partial<WaveRecord> = {}): WaveRecord => ({ wave: 1, op: "fan-out", gate: "release-wave-1", components: ["edge"], digest: DIGEST, members: [], status: "applied", settledAt: T0, ...extra });
  const hook = (read: SoakCheckReader, canary: WaveRecord | undefined, now: Date, port = memoryGateLedgerPort()) =>
    fanOutCanarySoak({ op: "fan-out", gate: "release", soak, env: "prod", canaryWave: () => canary, port, read, now: () => now });

  test("takes the soak of the pipeline stage it runs in, when the change selects a canary", () => {
    expect(fanOutCanarySoakOf(spec, "canary")).toEqual(soak);
    expect(fanOutCanarySoakOf(spec, "prod-a")).toBeUndefined();
    expect(fanOutCanarySoakOf(undefined, "canary")).toBeUndefined();
    expect(fanOutHasCanaryWave([["edge"], ["api"]], ["edge"])).toBe(true);
    expect(fanOutHasCanaryWave([["api"]], ["edge"])).toBe(false);
  });

  test("a passing canary lets wave 2 plan once it soaked", async () => {
    expect(await hook(fake(), record(), at(1))(2)).toMatchObject({ message: expect.stringContaining("wave 2 waits for the soak of prod") });
    expect(await hook(fake(), record(), at(3))(2)).toBeUndefined();
  });

  test("a failing canary holds wave 2 and records gate <gate>-wave-1-soak", async () => {
    const port = memoryGateLedgerPort();
    const held = await hook(fake({ up: "failed" }), record(), at(3), port)(2);
    expect(held?.pending).toMatchObject({ op: "fan-out", gate: "release-wave-1-soak", planDigest: DIGEST });
  });

  test("a canary wave that did not apply gives no clock and holds", async () => {
    expect(await hook(fake(), undefined, at(30))(2)).toBeDefined();
    expect(await hook(fake(), record({ status: "failed", failed: [{ component: "edge" }] }), at(30))(2)).toBeDefined();
  });
});

describe("COR027: a canary in environments", () => {
  const text = 'export default {\n  environments: [\n    "dev",\n    { name: "staging", canary: true },\n    "prod",\n  ],\n};\n';
  test("warns at the canary's line in a member with no pipeline", () => {
    const got = canaryConfigDiagnostics({ configPath: "/m/chant.config.ts", configText: text, environments: ["dev", { name: "staging", canary: true }, "prod"], hasPipeline: false });
    expect(got).toMatchObject([{ ruleId: "COR027", severity: "warning", line: 4, file: "/m/chant.config.ts" }]);
    expect(got[0]!.message).toContain('Environment "staging" is marked canary');
  });

  test("says nothing with a pipeline, or with no canary", () => {
    expect(canaryConfigDiagnostics({ configPath: "c", environments: [{ name: "staging", canary: true }], hasPipeline: true })).toEqual([]);
    expect(canaryConfigDiagnostics({ configPath: "c", environments: ["dev", { name: "prod" }], hasPipeline: false })).toEqual([]);
  });
});
