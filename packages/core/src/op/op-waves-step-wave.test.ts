/**
 * A wave planned as one through a step (#4842): a `discover` wave whose
 * runs the step's capability finds at plan time (a Terragrunt layer), and a
 * `together` wave planned and applied in one call of the capability (a
 * Terragrunt `run --all`, a composed run of roots).
 */

import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertOpWavesSpec, type OpWavesSpec } from "./op-waves";
import { runOpWave, opWavePlanPath, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability, type CapabilityGroupOutcome, type DeployContext, type GroupContext, type GroupMember, type GroupRun, type RunDiscoveryContext } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import { groupDigest } from "../components/groups";
import { waveSetDigest } from "../wave-engine";
import { NEXT_RELEASE } from "../release-floors";
import type { OpWaveRunHooks } from "./op-waves-run-hooks";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

const part = (member: string, action = "create"): ChangeSetPart => ({
  member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
  entries: [{ member, address: `aws_s3_bucket.${member.replace(/\//g, "_")}`, type: "aws_s3_bucket", action } as ChangeSetPart["entries"][number]],
});

interface Seen {
  discovered: Array<{ ctx: RunDiscoveryContext; input: Record<string, unknown> }>;
  planned: string[];
  groups: Array<{ ctx: GroupContext; members: Array<{ component: string; input: unknown; dependsOn?: string[]; env?: Record<string, string> }> }>;
  runs: Array<{ run: GroupRun; members: Array<{ component: string; plans?: Record<string, unknown>; env?: Record<string, string> }> }>;
  applied: string[];
  order: string[];
}

/** A Terragrunt-shaped capability: `layers[k-1]` is what wave k finds; each unit's digest is `digests[unit]`. */
function capability(
  layers: string[][],
  digests: Record<string, string>,
  opts: { group?: boolean; discover?: boolean; outcome?: (members: string[]) => CapabilityGroupOutcome; throwOnRun?: Error } = {},
): { registry: CapabilityRegistry; seen: Seen } {
  const seen: Seen = { discovered: [], planned: [], groups: [], runs: [], applied: [], order: [] };
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-terragrunt",
    async plan(_ctx: DeployContext, input) {
      const unit = String(input.unit);
      seen.planned.push(unit);
      return { member: unit, planDigest: digests[unit]!, artifact: { unit }, changeSet: part(unit) };
    },
    async run(_ctx: DeployContext, input) {
      seen.applied.push(String(input.unit));
      return { unit: input.unit };
    },
    ...(opts.discover === false
      ? {}
      : {
          async discoverRuns(ctx: RunDiscoveryContext, input: Record<string, unknown>) {
            seen.discovered.push({ ctx, input });
            return { targets: layers[ctx.wave.number - 1] ?? [], waves: layers.length };
          },
        }),
    ...(opts.group === false
      ? {}
      : {
          async planGroup(ctx: GroupContext, members: readonly GroupMember<Record<string, unknown>>[]) {
            seen.order.push("planGroup");
            for (const m of members) await m.ctx.afterInit?.();
            seen.groups.push({ ctx, members: members.map((m) => ({ component: m.component, input: m.input, ...(m.dependsOn ? { dependsOn: m.dependsOn } : {}), ...(m.ctx.processEnv ? { env: m.ctx.processEnv } : {}) })) });
            return {
              members: Object.fromEntries(members.map((m) => [m.component, { member: m.component, planDigest: digests[m.component]!, artifact: { planJson: `json/${m.component}/tfplan.json` }, changeSet: part(m.component) }])),
              digest: digest("c"),
              artifact: { workDir: ".chant/tg/wave", units: members.map((m) => m.component) },
            };
          },
          async runGroup(ctx: GroupContext, run: GroupRun, members: readonly GroupMember<Record<string, unknown>>[]) {
            seen.order.push("runGroup");
            seen.runs.push({ run, members: members.map((m) => ({ component: m.component, ...(m.ctx.plans ? { plans: m.ctx.plans } : {}), ...(m.ctx.processEnv ? { env: m.ctx.processEnv } : {}) })) });
            if (opts.throwOnRun) throw opts.throwOnRun;
            const names = members.map((m) => m.component);
            seen.applied.push(...names);
            return opts.outcome?.(names) ?? { members: Object.fromEntries(names.map((n) => [n, { status: "applied" as const, outputs: { id: `${n}-1` } }])) };
          },
        }),
  };
  return { registry: new CapabilityRegistry().register(cap), seen };
}

const digests = { "live/a": digest("1"), "live/b": digest("2"), "live/c": digest("3") };

const discovering: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  step: { kind: "fake-terragrunt", unit: "{target}", dir: ".", wave: "{wave}" },
  waves: [
    { name: "layer", runs: [], discover: true, gate: "never" },
    { name: "rest", runs: [], discover: true, rest: true, gate: "never" },
  ],
};

function harness(s: OpWavesSpec) {
  const cwd = mkdtempSync(join(tmpdir(), "op-waves-step-wave-"));
  const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(s) });
  return { cwd, show, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

const run = (h: ReturnType<typeof harness>, s: OpWavesSpec, registry: CapabilityRegistry, wave = 1, runHooks?: OpWaveRunHooks | OpWaveRunHooks[]) =>
  runOpWave({ spec: s, specFile: "waves.json", wave, cwd: h.cwd, show: h.show, gates: memoryGateLedgerPort(), capabilities: registry, log: () => {}, ...(runHooks ? { runHooks } : {}) });

describe("a wave planned as one through a step (#4842)", () => {
  test("the spec takes discover with a step and checks together", () => {
    expect(() => assertOpWavesSpec(discovering)).not.toThrow();
    const together: OpWavesSpec = { ...discovering, waves: [{ name: "w", runs: [{ target: "a" }], together: true }] };
    expect(() => assertOpWavesSpec(together)).not.toThrow();
    const { step: _s, ...commands } = together;
    expect(() => assertOpWavesSpec({ ...commands, plan: ["p", "{plan}"] })).toThrow(/plans its runs together, which only a `step`'s capability does/);
    expect(() => assertOpWavesSpec({ ...together, waves: [{ name: "w", runs: [{ target: "a" }], together: true, parallelism: 2 }] })).toThrow(/no parallelism over 1/);
    expect(() => assertOpWavesSpec({ ...together, waves: [{ name: "w", runs: [{ target: "a" }], together: "yes" as never }] })).toThrow(/has together "yes"/);
  });

  test("a discovering wave plans the runs its capability finds, one at a time, and a rest wave walks to the waves found", async () => {
    const h = harness(discovering);
    const { registry, seen } = capability([["live/a", "live/b"], ["live/c"]], digests, { group: false });
    const result = await run(h, discovering, registry, 2);
    expect(result.exitCode).toBe(0);
    // The input has {op} and {wave} filled and {target} as written; the wave number is the one planned.
    expect(seen.discovered.map((d) => d.ctx)).toEqual([
      { env: "rest", wave: { name: "rest", number: 2 } },
    ]);
    expect(seen.discovered[0]!.input).toEqual({ unit: "{target}", dir: ".", wave: "rest" });
    expect(seen.planned).toEqual(["live/c"]);
    expect(seen.applied).toEqual(["live/c"]);
    expect(result.decision?.discovered).toEqual({ waves: 2 });
    expect(result.decision?.members.map((m) => m.member)).toEqual(["live/c"]);
    h.done();
  });

  test("a discovering rest wave goes on through every wave found", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [discovering.waves[1]!] };
    const h = harness(s);
    const { registry, seen } = capability([["live/a"], ["live/b"], ["live/c"]], digests, { group: false });
    const result = await run(h, s, registry, 1);
    expect(result.exitCode).toBe(0);
    expect(seen.discovered.map((d) => d.ctx.wave.number)).toEqual([1, 2, 3]);
    expect(seen.applied).toEqual(["live/a", "live/b", "live/c"]);
    expect(result.rest?.map((r) => r.wave)).toEqual([1, 2, 3]);
    h.done();
  });

  test("a wave number past the ones found finds no runs and applies nothing", async () => {
    const h = harness(discovering);
    const { registry, seen } = capability([["live/a"]], digests, { group: false });
    const result = await run(h, { ...discovering, waves: [{ name: "layer", runs: [], discover: true, gate: "never" }, { name: "two", runs: [], discover: true, gate: "never" }] }, registry, 2);
    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual([]);
    expect(seen.planned).toEqual([]);
    h.done();
  });

  test("a capability that cannot find runs fails the wave before anything plans", async () => {
    const h = harness(discovering);
    const { registry, seen } = capability([["live/a"]], digests, { discover: false });
    await expect(run(h, discovering, registry)).rejects.toThrow('wave 1 (layer) discovers its runs, and the capability "fake-terragrunt" cannot find them (it has no discoverRuns)');
    expect(seen.planned).toEqual([]);
    h.done();
  });

  test("a together wave plans in one call and applies in one, the group digest a member of its own", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [{ name: "layer", runs: [], discover: true, together: true, gate: "never" }] };
    const h = harness(s);
    const { registry, seen } = capability([["live/a", "live/b"]], digests);
    const result = await run(h, s, registry);
    expect(result.exitCode).toBe(0);
    expect(seen.planned).toEqual([]);
    expect(seen.groups).toHaveLength(1);
    expect(seen.groups[0]!.ctx).toEqual({ env: "layer", components: ["live/a", "live/b"] });
    expect(seen.groups[0]!.members.map((m) => m.input)).toEqual([
      { unit: "live/a", dir: ".", wave: "layer" },
      { unit: "live/b", dir: ".", wave: "layer" },
    ]);
    // runGroup gets the group's artifact and each member's own plan back.
    expect(seen.runs).toHaveLength(1);
    expect(seen.runs[0]!.run.artifact).toEqual({ workDir: ".chant/tg/wave", units: ["live/a", "live/b"] });
    expect(seen.runs[0]!.members.map((m) => m.plans)).toEqual([{ "live/a": { planJson: "json/live/a/tfplan.json" } }, { "live/b": { planJson: "json/live/b/tfplan.json" } }]);
    expect(result.applied).toEqual(["live/a", "live/b"]);
    const group = groupDigest("fake-terragrunt", [{ component: "live/a", member: "live/a", planDigest: digests["live/a"] }, { component: "live/b", member: "live/b", planDigest: digests["live/b"] }], digest("c"));
    expect(seen.runs[0]!.run.digest).toBe(group);
    expect(result.decision?.digest).toBe(waveSetDigest([{ member: "(wave plan)", planDigest: group }, { member: "live/a", planDigest: digests["live/a"] }, { member: "live/b", planDigest: digests["live/b"] }]));
    // Each run has its plan file, as a per-run plan writes it.
    const file = JSON.parse(readFileSync(join(h.cwd, opWavePlanPath(s, 1, "live/a")), "utf-8")) as { planDigest: string; artifact: unknown };
    expect(file).toMatchObject({ planDigest: digests["live/a"], artifact: { planJson: "json/live/a/tfplan.json" } });
    h.done();
  });

  test("a together wave of listed runs keeps their order within the wave, and each run's hooks reach its member", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [{ name: "w", runs: [{ target: "live/a" }, { target: "live/b", dependsOn: ["live/a"] }], together: true, gate: "never" }] };
    const h = harness(s);
    const { registry, seen } = capability([], digests);
    const files: string[] = [];
    const result = await run(h, s, registry, 1, {
      name: "roles",
      beforePlan: (r) => ({ env: { ROLE: r.target }, afterInit: async () => void seen.order.push(`check ${r.target}`) }),
      beforeApply: (r) => void seen.order.push(`before ${r.target}`),
      afterApply: (r) => {
        seen.order.push(`after ${r.target} ${r.outcome}`);
        files.push(r.target);
        return { files: [`report/${r.target.replace("/", "_")}.json`] };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(seen.groups[0]!.members).toEqual([
      { component: "live/a", input: { unit: "live/a", dir: ".", wave: "w" }, env: { ROLE: "live/a" } },
      { component: "live/b", input: { unit: "live/b", dir: ".", wave: "w" }, dependsOn: ["live/a"], env: { ROLE: "live/b" } },
    ]);
    expect(seen.runs[0]!.members.map((m) => m.env)).toEqual([{ ROLE: "live/a" }, { ROLE: "live/b" }]);
    expect(seen.order).toEqual(["planGroup", "check live/a", "check live/b", "before live/a", "before live/b", "runGroup", "after live/a applied", "after live/b applied"]);
    expect(files).toEqual(["live/a", "live/b"]);
    h.done();
  });

  test("a before-apply hook that stops one run of a together wave applies none of them", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [{ name: "w", runs: [{ target: "live/a" }, { target: "live/b" }], together: true, gate: "never" }] };
    const h = harness(s);
    const { registry, seen } = capability([], digests);
    const result = await run(h, s, registry, 1, { name: "freeze", beforeApply: (r) => { if (r.target === "live/b") throw new Error("change freeze"); } });
    expect(result.exitCode).toBe(1);
    expect(seen.runs).toEqual([]);
    expect(result.failed).toEqual(["live/a", "live/b"]);
    h.done();
  });

  test("each run of a together wave ends as its part of the apply did", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [{ name: "w", runs: [{ target: "live/a" }, { target: "live/b" }, { target: "live/c" }], together: true, gate: "never" }] };
    const h = harness(s);
    const { registry } = capability([], digests, {
      outcome: () => ({ members: { "live/a": { status: "no-changes", outputs: {} }, "live/b": { status: "failed", error: "Error: AccessDenied" } } }),
    });
    const result = await run(h, s, registry);
    expect(result.exitCode).toBe(1);
    expect(result.applied).toEqual(["live/a"]);
    expect(result.failed).toEqual(["live/b", "live/c"]);
    expect(Object.fromEntries(Object.entries(result.targets ?? {}).map(([t, o]) => [t, o.error]))).toEqual({
      "live/a": undefined,
      "live/b": "its part of the wave's apply failed: Error: AccessDenied",
      "live/c": "fake-terragrunt said nothing of it",
    });
    h.done();
  });

  test("a together wave whose plan moved applies nothing and exits 4", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [{ name: "w", runs: [{ target: "live/a" }, { target: "live/b" }], together: true, gate: "never" }] };
    const h = harness(s);
    const moved = Object.assign(new Error("the composed plan moved since it was approved"), { planMoved: true });
    const { registry } = capability([], digests, { throwOnRun: moved });
    const result = await run(h, s, registry);
    expect(result.exitCode).toBe(4);
    expect(result.moved).toEqual(["live/a", "live/b"]);
    expect(result.applied).toEqual([]);
    h.done();
  });

  test("a together wave through a capability with no group methods fails before anything plans", async () => {
    const s: OpWavesSpec = { ...discovering, waves: [{ name: "w", runs: [{ target: "live/a" }], together: true, gate: "never" }] };
    const h = harness(s);
    const { registry, seen } = capability([], digests, { group: false });
    await expect(run(h, s, registry)).rejects.toThrow('wave "w" plans its runs together, and the capability "fake-terragrunt" cannot (it needs planGroup and runGroup)');
    expect(seen.planned).toEqual([]);
    h.done();
  });

  test("the floor is the next release", async () => {
    const entry = await import("./index");
    expect(entry.OP_WAVE_STEP_WAVE_FLOOR).toBe(NEXT_RELEASE);
  });
});
