/**
 * Planning dependents again when an upstream output changes (#5345): the
 * digests, the comparison, the dependents, and a re-plan through
 * `planPrSet` whose capability throws on `run`, so a test that passes shows
 * nothing applied. The terraform (`terraform_remote_state` through
 * `groupReads`) and pulumi (`StackReference` through `graphReads`) cases are
 * in those lexicons' tests.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import type { DriverComponent } from "./driver";
import {
  changedOutputs,
  dependentsOfChange,
  outputDigests,
  parseOutputRecords,
  replanAfterApply,
  replanNames,
  replanNote,
  UPSTREAM_REPLAN_FLOOR,
  upstreamReadsOf,
  type OutputRecord,
  type OutputRecordPort,
} from "./upstream-replan";
import { asPipelineSpec, stageReplanDependents } from "../pipeline/spec";
import { stageWavesSpec } from "../pipeline/stages";
import { computePlanDigest } from "../lifecycle/plan-digest";
import { readMarkedOutputs } from "./upstream-replan";

const out = (stack: string, name: string) => ({ stackOutput: { stack, name } });

function memory(): OutputRecordPort & { lines: OutputRecord[] } {
  const lines: OutputRecord[] = [];
  return { lines, read: async () => [...lines], append: async (_env, records) => void lines.push(...records) };
}

function registry(runs: string[]): CapabilityRegistry {
  return new CapabilityRegistry().register({
    kind: "fake-stack",
    run: async (_ctx: DeployContext, input: { name: string }) => {
      runs.push(input.name);
      throw new Error("a re-plan never applies");
    },
    async plan(_ctx: DeployContext, input: { name: string }) {
      const planDigest = `jcs1-sha256:${input.name}`;
      return { member: input.name, planDigest, artifact: {}, changeSet: { member: { member: input.name, lexicon: "fake", planner: "fake", status: "planned", planDigest, holes: [] }, entries: [] } };
    },
  } as never);
}

const components: DriverComponent[] = [
  { name: "network", deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", name: "network" }] }] },
  { name: "app", dependsOn: ["network"], deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", name: "app", vpc: out("network", "vpcId") }] }] },
  { name: "dns", dependsOn: ["network"], deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", name: "dns", zone: out("network", "zone") }] }] },
];

describe("output digests and changes (#5345)", () => {
  test("the floor is a version or the next release", () => {
    expect(UPSTREAM_REPLAN_FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("one digest per output, never the value; a changed, added or removed output counts", () => {
    const a = outputDigests({ vpcId: "vpc-1", zone: "z" });
    expect(Object.keys(a)).toEqual(["vpcId", "zone"]);
    expect(JSON.stringify(a)).not.toContain("vpc-1");
    expect(changedOutputs(a, outputDigests({ vpcId: "vpc-1", zone: "z" }))).toEqual([]);
    expect(changedOutputs(a, outputDigests({ vpcId: "vpc-2", extra: 1 }))).toEqual(["extra", "vpcId", "zone"]);
  });

  test("a read naming no output counts for every changed one; other upstreams are not dependents", () => {
    const reads = [
      { reader: "app", upstream: "network", output: "vpcId", via: "wiring" as const },
      { reader: "dns", upstream: "network", output: "zone", via: "wiring" as const },
      { reader: "jobs", upstream: "network", via: "group" as const },
      { reader: "x", upstream: "other", output: "vpcId", via: "declared" as const },
    ];
    expect(dependentsOfChange("network", ["vpcId"], reads)).toEqual([
      { member: "app", outputs: ["vpcId"] },
      { member: "jobs", outputs: ["vpcId"] },
    ]);
    expect(dependentsOfChange("network", [], reads)).toEqual([]);
  });

  test("patterns name members as op-wave run patterns do; malformed ledger lines are skipped", () => {
    expect(replanNames(["net*"], "network")).toBe(true);
    expect(replanNames(["shared/**"], "shared/a/b")).toBe(true);
    expect(replanNames([], "network")).toBe(false);
    expect(parseOutputRecords('{"kind":"outputs","member":"a","env":"prod","digests":{}}\nnot json\n{"kind":"other"}\n')).toHaveLength(1);
  });

  test("stackOutput references in steps are reads, each step read for the environment", async () => {
    const reads = await upstreamReadsOf(components, registry([]), "/", (component) => ({ env: "prod", component }), "prod");
    expect(reads).toEqual([
      { reader: "app", upstream: "network", output: "vpcId", via: "wiring" },
      { reader: "dns", upstream: "network", output: "zone", via: "wiring" },
    ]);
  });
});

describe("replanAfterApply (#5345)", () => {
  const base = (records: OutputRecordPort, runs: string[], decided: string[]) => ({
    components,
    registry: registry(runs),
    root: "/",
    env: "prod",
    records,
    gate: "pr-apply",
    decide: async ({ gate, description }: { gate: string; description: string }) => {
      decided.push(`${gate}: ${description}`);
      return { status: "pending" as const };
    },
  });

  test("off by default: the dependent of a changed output is listed and nothing is planned", async () => {
    const records = memory();
    const runs: string[] = [];
    const decided: string[] = [];
    await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-1", zone: "z" } }, replanDependents: [] });
    const r = await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-2", zone: "z" } }, replanDependents: [] });
    expect(r.changes).toEqual([{ member: "network", changed: ["vpcId"], dependents: [{ member: "app", outputs: ["vpcId"] }], replan: false }]);
    expect(r.planned).toBeUndefined();
    expect(decided).toEqual([]);
    expect(replanNote(r, "replan-prod")).toContain("`network` changed `vpcId`, read by `app` (vpcId); its dependents are listed");
  });

  test("opted in: the dependent is planned against the outputs standing now, sent to its gate with the upstream change named, and never run", async () => {
    const records = memory();
    const runs: string[] = [];
    const decided: string[] = [];
    await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-1", zone: "z" } }, replanDependents: ["network"] });
    const r = await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-2", zone: "z" } }, replanDependents: ["network"], gitSha: "feedfacecafe1234" });
    expect(runs).toEqual([]);
    expect(r.planned).toMatchObject({ gate: "pr-apply-replan", components: ["app"], approval: { status: "pending" }, failed: false });
    expect(r.planned!.members.map((m) => m.member)).toEqual(["app"]);
    expect(decided).toEqual(["pr-apply-replan: planned again after an upstream output changed: network applied at feedfacecafe with vpcId changed, read by app"]);
    const note = replanNote(r, "replan-prod");
    expect(note).toContain("Planned again because network applied at feedfacecafe with vpcId changed, read by app.");
    expect(note).toContain(`chant approve replan-prod pr-apply-replan --plan ${r.planned!.digest}`);
  });

  test("a member applied in the same run is no dependent; a dry run records nothing", async () => {
    const records = memory();
    const runs: string[] = [];
    const decided: string[] = [];
    await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-1" } }, replanDependents: ["network"] });
    const both = await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-2" }, app: {} }, replanDependents: ["network"] });
    expect(both.changes.find((c) => c.member === "network")!.dependents).toEqual([]);
    expect(both.planned).toBeUndefined();
    const before = records.lines.length;
    const dry = await replanAfterApply({ ...base(records, runs, decided), applied: { network: { vpcId: "vpc-3" } }, replanDependents: ["network"], dryRun: true });
    expect(dry.changes[0]!.dependents).toEqual([{ member: "app", outputs: ["vpcId"] }]);
    expect(dry.planned).toBeUndefined();
    expect(records.lines.length).toBe(before);
    expect(decided).toEqual([]);
  });
});

describe("replanDependents in the pipeline (#5345)", () => {
  const pipeline = (stage: Record<string, unknown>, defaults?: Record<string, unknown>) =>
    asPipelineSpec({ name: "deliver", stages: [{ name: "prod", waves: [{ name: "w", runs: [{ target: "network" }] }], ...stage }], ...(defaults ? { defaults: { op: "apply", plan: ["plan", "{target}", "{plan}"], ...defaults } } : { defaults: { op: "apply", plan: ["plan", "{target}", "{plan}"] } }) });

  test("a stage's list, else the pipeline's default, else none; the stage's op-waves spec carries it", () => {
    expect(stageReplanDependents(pipeline({}), "prod")).toEqual([]);
    expect(stageReplanDependents(pipeline({}, { replanDependents: ["shared/*"] }), "prod")).toEqual(["shared/*"]);
    const own = pipeline({ replanDependents: ["network"] }, { replanDependents: ["shared/*"] });
    expect(stageReplanDependents(own, "prod")).toEqual(["network"]);
    expect(stageWavesSpec(own, "prod").replanDependents).toEqual(["network"]);
  });

  test("a list of anything but names is refused", () => {
    expect(() => pipeline({ replanDependents: "network" })).toThrow(/replanDependents must be a list of member names or patterns/);
  });
});

describe("sensitive outputs (#5345)", () => {
  test("no digest of a sensitive output reaches the ledger, and it counts as changed whenever its member applied", async () => {
    const records = memory();
    const decided: string[] = [];
    const go = (password: string) =>
      replanAfterApply({
        components: [
          { name: "db", deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", name: "db" }] }] },
          { name: "api", dependsOn: ["db"], deploy: [{ phase: "Apply", steps: [{ kind: "fake-stack", name: "api", pw: out("db", "password") }] }] },
        ],
        registry: registry([]),
        root: "/",
        env: "prod",
        applied: { db: { host: "db.internal", password } },
        sensitive: { db: ["password"] },
        replanDependents: [],
        records,
        gate: "pr-apply",
        decide: async ({ description }) => (decided.push(description), { status: "pending" as const }),
      });
    expect((await go("hunter2")).changes[0]).toMatchObject({ first: true, changed: [] });
    const again = await go("hunter2");
    expect(again.changes[0]).toEqual({ member: "db", changed: ["password"], dependents: [{ member: "api", outputs: ["password"] }], replan: false });
    const lines = records.lines.map((l) => JSON.stringify(l)).join("\n");
    expect(records.lines[0]!.digests).toEqual({ host: computePlanDigest("output", "db.internal") });
    expect(records.lines[0]!.sensitive).toEqual(["password"]);
    expect(lines).not.toContain(computePlanDigest("output", "hunter2"));
    expect(lines).not.toContain("hunter2");
  });

  test("markedOutputs is read where a capability has it, else outputs with none marked", async () => {
    const r = new CapabilityRegistry()
      .register({ kind: "marked", run: async () => ({}), markedOutputs: async () => ({ outputs: { a: 1, s: "x" }, sensitive: ["s"] }) } as never)
      .register({ kind: "plain", run: async () => ({}), outputs: async () => ({ b: 2 }) } as never);
    const c: DriverComponent = { name: "c", deploy: [{ phase: "Apply", steps: [{ kind: "marked" }, { kind: "plain" }] }] };
    expect(await readMarkedOutputs(c, r, { env: "prod", component: "c" })).toEqual({ outputs: { a: 1, s: "x", b: 2 }, sensitive: ["s"] });
  });
});
