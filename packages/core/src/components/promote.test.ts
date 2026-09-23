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
  planRollback,
  rollbackRecord,
  selectRelease,
  withoutBuildSteps,
  runPromotion,
  promotionRecord,
  gateApprover,
  promoteArchivePaths,
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

describe("choosing the release a rollback restores", () => {
  const history = [
    rec("api", "prod", "sha256:a", "2026-01-01T00:00:00Z"),
    rec("api", "prod", "sha256:b", "2026-01-02T00:00:00Z"),
    rec("api", "prod", "sha256:c", "2026-01-03T00:00:00Z"),
  ];
  const plan = (input: Partial<Parameters<typeof planRollback>[0]>) =>
    planRollback({ env: "prod", records: history, declared: ["api"], component: "api", ...input });

  test("the release before the current one by default", () => {
    const p = plan({});
    expect("items" in p && p.items[0].digest).toBe("sha256:b");
    expect("items" in p && p.from).toBe("prod");
  });

  test("a redeploy of the current digest does not count as an earlier release", () => {
    const p = plan({ records: [...history, rec("api", "prod", "sha256:c", "2026-01-04T00:00:00Z")] });
    expect("items" in p && p.items[0].digest).toBe("sha256:b");
  });

  test("a chosen digest", () => {
    const p = plan({ digest: "sha256:a" });
    expect("items" in p && p.items[0].source.timestamp).toBe("2026-01-01T00:00:00Z");
  });

  test("a digest the environment never recorded is refused", () => {
    const p = plan({ digest: "sha256:z" });
    expect("error" in p && p.error).toMatch(/sha256:z is not recorded for "api" in "prod"/);
  });

  test("the current release is refused", () => {
    const p = plan({ digest: "sha256:c" });
    expect("error" in p && p.error).toMatch(/already the current release/);
  });

  test("a single release has nothing earlier", () => {
    const p = plan({ records: [history[0]] });
    expect("error" in p && p.error).toMatch(/no earlier release/);
  });
});

describe("pinning the publish step for a rollback", () => {
  test("the publish step is replaced by the recorded digest", () => {
    const p = withoutBuildSteps(service("api"), { pinDigest: "sha256:b" });
    if ("error" in p) throw new Error(p.error);
    expect(p.removed).toEqual(["docker-build", "publish-image"]);
    expect(p.component.deploy[0].steps[0]).toMatchObject({ kind: "recorded-digest", digest: "sha256:b", replaces: "publish-image" });
  });

  test("a step reading another publish output is refused", () => {
    const c = service("api");
    c.deploy[2].steps[0] = { kind: "apply", image: "@Publish.uri" };
    const p = withoutBuildSteps(c, { pinDigest: "sha256:b" });
    expect("error" in p && p.error).toMatch(/reads "@Publish.uri", but a rollback knows only the recorded digest/);
  });

  test("a rollback redeploys the recorded digest and publishes nothing", async () => {
    const { registry, ran } = fakeRegistry({ api: "sha256:new" });
    const p = withoutBuildSteps(service("api"), { pinDigest: "sha256:b" });
    if ("error" in p) throw new Error(p.error);
    const plan: PromotionPlan = {
      from: "prod",
      to: "prod",
      items: [{ component: "api", digest: "sha256:b", source: rec("api", "prod", "sha256:b", "2026-01-02T00:00:00Z", "run-2") }],
      notPromoted: [],
    };
    const run = await runPromotion({ plan, components: [p.component], registry, gates: memoryGateLedgerPort() });
    expect(run.status).toBe("ok");
    expect(ran).toEqual(["prod:api:apply"]);
    expect(run.results[0].records.find((r) => r.kind === "apply")?.output).toEqual({ applied: "sha256:b" });

    expect(rollbackRecord(plan.items[0], "prod", { runId: "run-5", actor: "bob", timestamp: "2026-01-05T00:00:00Z" })).toMatchObject({
      env: "prod",
      digest: "sha256:b",
      restores: { env: "prod", runId: "run-2", timestamp: "2026-01-02T00:00:00Z" },
    });
  });
});

describe("the archive paths a generated promote job carries (#2575)", () => {
  test("every build step's into, nested phases included, once each and in order", () => {
    const component: DriverComponent = {
      name: "api",
      deploy: [
        { phase: "Build", steps: [
          { kind: "docker-build", context: ".", into: "dist/api.tar" },
          { kind: "generate-sbom", artifactType: "image", path: "dist/api.tar", into: "dist/api.sbom.json" },
          { phase: "Lambdas", parallel: true, steps: [{ kind: "zip-package", source: "fn", into: "dist/fn.zip" }] },
        ] },
        { phase: "Again", steps: [{ kind: "docker-build", context: ".", into: "dist/api.tar" }] },
        { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:dist/api.tar" }] },
      ],
    };
    expect(promoteArchivePaths(component)).toEqual(["dist/api.tar", "dist/fn.zip"]);
  });

  test("a component that builds nothing carries nothing", () => {
    expect(promoteArchivePaths({ name: "infra", deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] })).toEqual([]);
  });

  test("an into that is only known at run time is refused by name", () => {
    for (const into of ["@Params.path", "$env.archive", undefined]) {
      const component: DriverComponent = {
        name: "api",
        deploy: [{ phase: "Build", steps: [{ kind: "jvm-build", into }] }],
      };
      expect(() => promoteArchivePaths(component)).toThrow(/component "api": the jvm-build step in phase "Build".*not a literal path/);
    }
  });
});
