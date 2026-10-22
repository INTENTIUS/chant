/**
 * Resource targeting (#4300): `--target <component>:<address>` narrows a
 * component's steps, each capability accepts or refuses by name, and the
 * targets join the plan digest an approval binds.
 */

import { describe, expect, test } from "vitest";
import { CapabilityRegistry, parseComponentTargets, targetRefusal, type CapabilityPlan, type DeployContext } from "./capability";
import { deployContext, runComponentDeploy, type DriverComponent } from "./driver";
import { bindTargets, planWaveComponent, targetedPlanDigest } from "./wave-plan";
import { fanOutGateDigest, runFanOut } from "./fan-out-run";
import { planFanOut } from "./fan-out";
import { memoryGateLedgerPort } from "../op/gate";

const component = (name: string, ...kinds: string[]): DriverComponent => ({
  name,
  deploy: [{ phase: "Deploy", steps: kinds.map((kind) => ({ kind })) }],
});

/** A registry with a verb that accepts targets, one that refuses, and one that says nothing. */
function registry(seen: DeployContext[] = []): CapabilityRegistry {
  const r = new CapabilityRegistry();
  r.register({
    kind: "narrow",
    targets: "accept",
    async plan(ctx: DeployContext): Promise<CapabilityPlan> {
      seen.push(ctx);
      return { member: ctx.component, planDigest: "sha256:base", ...(ctx.targets ? { targets: ctx.targets } : {}) };
    },
    async run(ctx: DeployContext) {
      seen.push(ctx);
      return { ok: true };
    },
  } as never);
  r.register({
    kind: "whole",
    targets: { refuse: "whole applies everything" },
    async plan(ctx: DeployContext): Promise<CapabilityPlan> {
      return { member: ctx.component, planDigest: "sha256:whole" };
    },
    async run() {
      return { ok: true };
    },
  } as never);
  r.register({
    kind: "silent",
    async run() {
      return { ok: true };
    },
  } as never);
  return r;
}

describe("parseComponentTargets", () => {
  test("groups by component, sorted and unique, splitting at the first colon", () => {
    expect(parseComponentTargets(["net:aws_vpc.main", "net:aws_subnet.a", "net:aws_vpc.main", "app:Deployment/prod/web", "net:x[\"a:b\"]"])).toEqual({
      app: ["Deployment/prod/web"],
      net: ["aws_subnet.a", "aws_vpc.main", 'x["a:b"]'],
    });
  });

  test("refuses a value with no component or no address, and an unknown component", () => {
    expect(() => parseComponentTargets([":aws_vpc.main"])).toThrow(/--target <component>:<address>/);
    expect(() => parseComponentTargets(["net:"])).toThrow(/--target <component>:<address>/);
    expect(() => parseComponentTargets(["nope:a"], new Set(["net"]))).toThrow(/no component is named nope/);
  });
});

describe("targetRefusal", () => {
  test("accept, refuse with its reason, and unset refusing by name", () => {
    expect(targetRefusal({ kind: "a", targets: "accept" })).toBeUndefined();
    expect(targetRefusal({ kind: "b", targets: { refuse: "no" } })).toBe("no");
    expect(targetRefusal({ kind: "c" })).toMatch(/^c does not say/);
  });
});

describe("deployContext", () => {
  test("gives a component its own targets, sorted, and none to another", () => {
    const options = { env: "dev", targets: { net: ["b", "a", "a"] } };
    expect(deployContext(options, "net").targets).toEqual(["a", "b"]);
    expect(deployContext(options, "app").targets).toBeUndefined();
  });
});

describe("planning a targeted component", () => {
  test("binds the targets into the member's digest and its change-set part", async () => {
    const seen: DeployContext[] = [];
    const ctx = deployContext({ env: "dev", targets: { net: ["aws_vpc.main"] } }, "net");
    const planned = await planWaveComponent(component("net", "narrow"), registry(seen), ctx, {});
    expect("error" in planned).toBe(false);
    if ("error" in planned) return;
    expect(seen[0]!.targets).toEqual(["aws_vpc.main"]);
    const digest = targetedPlanDigest("sha256:base", ["aws_vpc.main"]);
    expect(planned.members).toEqual([{ member: "net", planDigest: digest }]);
    expect(planned.parts[0]!.member.planDigest).toBe(digest);
  });

  test("another set of targets is another digest, and none is the plan's own", async () => {
    const a = targetedPlanDigest("sha256:base", ["x"]);
    const b = targetedPlanDigest("sha256:base", ["y"]);
    expect(a).not.toBe(b);
    expect(targetedPlanDigest("sha256:base", ["y", "x"])).toBe(targetedPlanDigest("sha256:base", ["x", "y"]));
    const untargeted = await planWaveComponent(component("net", "narrow"), registry(), deployContext({ env: "dev" }, "net"), {});
    expect("error" in untargeted ? undefined : untargeted.members[0]!.planDigest).toBe("sha256:base");
  });

  test("a verb that refuses names itself, and so does one that says nothing", async () => {
    const ctx = deployContext({ env: "dev", targets: { net: ["a"] } }, "net");
    const refused = await planWaveComponent(component("net", "narrow", "whole"), registry(), ctx, {});
    expect(refused).toEqual({ component: "net", error: 'component "net": whole refuses targets: whole applies everything' });
    const silent = await planWaveComponent(component("net", "silent"), registry(), ctx, {});
    expect("error" in silent && silent.error).toMatch(/silent refuses targets: silent does not say/);
  });

  test("a plan that does not give the targets back refuses", () => {
    const ctx: DeployContext = { env: "dev", component: "net", targets: ["a", "b"] };
    expect(() => bindTargets("narrow", ctx, { member: "net", planDigest: "d" })).toThrow(/names no targets/);
    expect(() => bindTargets("narrow", ctx, { member: "net", planDigest: "d", targets: ["a"] })).toThrow(/names a$/);
  });
});

describe("running a targeted component", () => {
  test("refuses before any step runs when one verb can't narrow", async () => {
    const seen: DeployContext[] = [];
    const ctx = deployContext({ env: "dev", targets: { net: ["a"] } }, "net");
    const result = await runComponentDeploy(component("net", "narrow", "whole"), ctx, registry(seen), {}, undefined, { port: memoryGateLedgerPort() });
    expect(result.status).toBe("fail");
    expect(result.records[0]).toMatchObject({ phase: "Targets", kind: "whole", status: "fail" });
    expect(seen).toEqual([]);
  });

  test("hands the targets to a verb that accepts them", async () => {
    const seen: DeployContext[] = [];
    const ctx = deployContext({ env: "dev", targets: { net: ["a"] } }, "net");
    const result = await runComponentDeploy(component("net", "narrow"), ctx, registry(seen), {}, undefined, { port: memoryGateLedgerPort() });
    expect(result.status).toBe("ok");
    expect(seen[0]!.targets).toEqual(["a"]);
  });
});

describe("a gate over the whole set", () => {
  test("binds the targets, so the untargeted approval does not cover a targeted run", async () => {
    expect(fanOutGateDigest("sha256:set", undefined)).toBe("sha256:set");
    expect(fanOutGateDigest("sha256:set", { net: [] })).toBe("sha256:set");
    const narrowed = fanOutGateDigest("sha256:set", { net: ["a"] });
    expect(narrowed).not.toBe("sha256:set");
    expect(fanOutGateDigest("sha256:set", { net: ["b"] })).not.toBe(narrowed);

    const estate = [component("net", "narrow")];
    const plan = planFanOut({ components: estate, changed: ["net"] });
    const gates = memoryGateLedgerPort();
    const result = await runFanOut(plan, estate, registry(), {
      env: "dev",
      gates,
      now: "2026-01-01T00:00:00Z",
      gate: { op: "fan-out", gate: "set" },
      targets: { net: ["a"] },
    });
    expect(result.status).toBe("gated");
    expect(result.gate?.planDigest).toBe(fanOutGateDigest(plan.digest, { net: ["a"] }));
  });
});
