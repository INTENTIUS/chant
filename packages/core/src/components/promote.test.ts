/**
 * Promote a release without rebuilding (#2530).
 */

import { describe, test, expect } from "vitest";
import { CapabilityRegistry, type DeployContext } from "./capability";
import { memoryGateLedgerPort, type GateLedgerPort } from "../op/gate";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { DriverComponent } from "./driver";
import type { ReleaseRecord } from "../lifecycle/release-ledger";
import {
  planPromotion,
  selectRelease,
  withoutBuildSteps,
  runPromotion,
  promotionRecord,
  gateApprover,
  type PromotionPlan,
} from "./promote";

const rec = (component: string, env: string, digest: string, timestamp: string, runId = `run-${timestamp}`): ReleaseRecord => ({
  version: 1,
  component,
  env,
  digest,
  gitSha: "abc123",
  runId,
  timestamp,
  actor: "ci",
});

/** Build, publish, apply: the shape the pilots and the adopt example use. */
const service = (name: string, extra: Partial<DriverComponent> = {}): DriverComponent => ({
  name,
  deploy: [
    { phase: "Build", steps: [{ kind: "docker-build", context: ".", into: `${name}.tar` }] },
    { phase: "Publish", steps: [{ kind: "publish-image", from: `archive:${name}.tar`, to: "$env.registry" }] },
    { phase: "Apply", steps: [{ kind: "apply", imageRef: "@Publish.digest" }] },
  ],
  ...extra,
});

describe("selecting the source release", () => {
  const records = [
    rec("api", "staging", "sha256:old", "2026-01-01T00:00:00Z"),
    rec("api", "staging", "sha256:new", "2026-01-02T00:00:00Z"),
    rec("web", "staging", "sha256:web", "2026-01-01T00:00:00Z"),
  ];

  test("the latest release by default", () => {
    const picked = selectRelease(records, "api", "staging");
    expect("record" in picked && picked.record.digest).toBe("sha256:new");
  });

  test("a named digest that the ledger recorded", () => {
    const picked = selectRelease(records, "api", "staging", "sha256:old");
    expect("record" in picked && picked.record.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  test("a digest missing from the source ledger fails and names what is recorded", () => {
    const picked = selectRelease(records, "api", "staging", "sha256:nope");
    expect("error" in picked && picked.error).toMatch(/sha256:nope is not recorded for "api" in "staging"/);
    expect("error" in picked && picked.error).toMatch(/sha256:old, sha256:new/);
  });

  test("a component with no release in the source fails", () => {
    const picked = selectRelease(records, "db", "staging");
    expect("error" in picked && picked.error).toMatch(/no release of "db" is recorded in "staging"/);
  });
});

describe("planning", () => {
  const records = [
    rec("api", "staging", "sha256:api", "2026-01-02T00:00:00Z"),
    rec("gone", "staging", "sha256:gone", "2026-01-02T00:00:00Z"),
  ];

  test("every declared component with a source release, and the rest reported", () => {
    const plan = planPromotion({ from: "staging", to: "prod", sourceRecords: records, declared: ["api", "infra"] });
    expect("items" in plan).toBe(true);
    const { items, notPromoted } = plan as PromotionPlan;
    expect(items.map((i) => [i.component, i.digest])).toEqual([["api", "sha256:api"]]);
    expect(notPromoted).toEqual([{ component: "gone", reason: "recorded but not declared in this checkout" }]);
  });

  test("refuses the same environment on both sides", () => {
    const plan = planPromotion({ from: "prod", to: "prod", sourceRecords: records, declared: ["api"] });
    expect("error" in plan && plan.error).toMatch(/same environment/);
  });

  test("--digest needs --component", () => {
    const plan = planPromotion({ from: "staging", to: "prod", sourceRecords: records, declared: ["api"], digest: "sha256:api" });
    expect("error" in plan && plan.error).toMatch(/needs --component/);
  });

  test("an empty source ledger is an error, not a no-op", () => {
    const plan = planPromotion({ from: "staging", to: "prod", sourceRecords: [], declared: ["api"] });
    expect("error" in plan && plan.error).toMatch(/nothing to promote/);
  });
});

describe("taking the build out of a composition", () => {
  test("build steps go, publish and apply stay", () => {
    const prepared = withoutBuildSteps(service("api"));
    expect("component" in prepared).toBe(true);
    if (!("component" in prepared)) return;
    expect(prepared.removed).toEqual(["docker-build"]);
    expect(prepared.component.deploy.map((p) => p.phase)).toEqual(["Publish", "Apply"]);
  });

  test("gates survive, even in a phase that loses its build step", () => {
    const c = service("api");
    c.deploy[0].steps.unshift({ kind: "gate", gate: "release" });
    const prepared = withoutBuildSteps(c);
    if (!("component" in prepared)) throw new Error(prepared.error);
    expect(prepared.component.deploy[0]).toEqual({ phase: "Build", steps: [{ kind: "gate", gate: "release" }] });
  });

  test("no publish step is refused", () => {
    const c: DriverComponent = { name: "chart", deploy: [{ phase: "Apply", steps: [{ kind: "helm-upgrade" }] }] };
    const prepared = withoutBuildSteps(c);
    expect("error" in prepared && prepared.error).toMatch(/no publish step/);
  });

  test("two publish steps are refused", () => {
    const c = service("api");
    c.deploy[1].steps.push({ kind: "publish-artifact", from: "archive:x.jar" });
    const prepared = withoutBuildSteps(c);
    expect("error" in prepared && prepared.error).toMatch(/2 publish steps/);
  });

  test("a step reading a removed build step's output is refused", () => {
    const c = service("api");
    c.deploy[1].steps[0] = { kind: "publish-image", from: "@Build.archivePath", to: "$env.registry" };
    const prepared = withoutBuildSteps(c);
    expect("error" in prepared && prepared.error).toMatch(/reads "@Build.archivePath"/);
  });
});

/** A registry of fakes. `publishes` is the digest publish-image returns per component. */
function fakeRegistry(publishes: Record<string, string>) {
  const ran: string[] = [];
  const registry = new CapabilityRegistry();
  const step = (kind: string, run: (ctx: DeployContext, input: Record<string, unknown>) => unknown) =>
    registry.register({ kind, async run(ctx: DeployContext, input: Record<string, unknown>) { ran.push(`${ctx.env}:${ctx.component}:${kind}`); return run(ctx, input); } } as never);
  step("docker-build", () => ({ digest: "sha256:rebuilt" }));
  step("publish-image", (ctx) => ({ digest: publishes[ctx.component], uri: `reg/${ctx.component}@${publishes[ctx.component]}` }));
  step("apply", (_ctx, input) => ({ applied: input.imageRef }));
  return { registry, ran };
}

function planFor(component: string, digest: string): PromotionPlan {
  return {
    from: "staging",
    to: "prod",
    items: [{ component, digest, source: rec(component, "staging", digest, "2026-01-02T00:00:00Z", "run-7") }],
    notPromoted: [],
  };
}

function prepared(c: DriverComponent): DriverComponent {
  const p = withoutBuildSteps(c);
  if ("error" in p) throw new Error(p.error);
  return p.component;
}

describe("running a promotion", () => {
  test("deploys the recorded digest to the target without building", async () => {
    const { registry, ran } = fakeRegistry({ api: "sha256:api" });
    const run = await runPromotion({
      plan: planFor("api", "sha256:api"),
      components: [prepared(service("api"))],
      registry,
      gates: memoryGateLedgerPort(),
    });
    expect(run.status).toBe("ok");
    expect(ran).toEqual(["prod:api:publish-image", "prod:api:apply"]);
    const apply = run.results[0].records.find((r) => r.kind === "apply");
    expect(apply?.output).toEqual({ applied: "sha256:api" });
  });

  test("a publish that yields another digest fails before apply runs", async () => {
    const { registry, ran } = fakeRegistry({ api: "sha256:different" });
    const run = await runPromotion({
      plan: planFor("api", "sha256:api"),
      components: [prepared(service("api"))],
      registry,
      gates: memoryGateLedgerPort(),
    });
    expect(run.status).toBe("fail");
    expect(ran).not.toContain("prod:api:apply");
    const publish = run.results[0].records.find((r) => r.kind === "publish-image" && r.status === "fail");
    expect(publish?.error).toMatch(/published sha256:different, but the release being promoted recorded sha256:api/);
  });

  test("the target's gate still applies, and an approval lets the same promote through", async () => {
    const gated = service("api");
    gated.deploy[2].steps.unshift({ kind: "gate", gate: "prod-release" });
    const resolutions: GateResolutionRecord[] = [];
    const memory = memoryGateLedgerPort();
    const gates: GateLedgerPort = {
      async read(op) {
        const read = await memory.read(op);
        return { ...read, resolutions: [...resolutions] };
      },
      appendPending: (input) => memory.appendPending(input),
    };
    const { registry, ran } = fakeRegistry({ api: "sha256:api" });
    const opts = { plan: planFor("api", "sha256:api"), components: [prepared(gated)], registry, gates };

    const first = await runPromotion({ ...opts, now: "2026-01-03T00:00:00Z" });
    expect(first.status).toBe("gated");
    expect(first.gate?.gate).toBe("prod-release");
    expect(ran).not.toContain("prod:api:apply");

    resolutions.push({ version: 1, kind: "resolution", op: "api", gate: "prod-release", resolvedBy: "alice", timestamp: "2026-01-03T00:01:00Z" });
    const second = await runPromotion({ ...opts, now: "2026-01-03T00:02:00Z" });
    expect(second.status).toBe("ok");
    expect(gateApprover(second.results[0])).toBe("alice");
  });

  test("dependencies outside the promotion do not block it", async () => {
    const { registry } = fakeRegistry({ api: "sha256:api" });
    const run = await runPromotion({
      plan: planFor("api", "sha256:api"),
      components: [prepared(service("api", { dependsOn: ["shared-alb"] }))],
      registry,
      gates: memoryGateLedgerPort(),
    });
    expect(run.status).toBe("ok");
  });
});

describe("the target record", () => {
  test("carries the source release it promoted", () => {
    const plan = planFor("api", "sha256:api");
    plan.items[0].source.manifestDigest = "sha256:manifest";
    const record = promotionRecord(plan.items[0], "prod", {
      runId: "run-9",
      actor: "bob",
      timestamp: "2026-01-04T00:00:00Z",
      approver: "alice",
    });
    expect(record).toEqual({
      component: "api",
      env: "prod",
      digest: "sha256:api",
      gitSha: "abc123",
      runId: "run-9",
      timestamp: "2026-01-04T00:00:00Z",
      actor: "bob",
      approver: "alice",
      manifestDigest: "sha256:manifest",
      promotedFrom: { env: "staging", runId: "run-7", timestamp: "2026-01-02T00:00:00Z" },
    });
  });
});
