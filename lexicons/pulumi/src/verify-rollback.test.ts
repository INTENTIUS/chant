/**
 * A stage of `pulumi-up` steps that rolls back when its verify fails
 * (#5328). The capability declares `rollbackPolicy: "needs-opt-out"`, so the
 * step carries `noRollback` and a failed verify leaves the update in place.
 * The stage's rollback is then a forward apply of the earlier release: the
 * release recorded the stack's directory through `releaseInputs`, and
 * `components rollback --release` runs `pulumi up` on that copy.
 */
import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { runComponentDeploy, type DriverComponent } from "@intentius/chant/components/driver";
import { planReleaseRollback } from "@intentius/chant/components/promote";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import { asPipelineSpec, memberStatesOf, memoryStageLedgerPort, requestStageRollback, verifyRollbackProblems } from "@intentius/chant/pipeline";
import { pulumiUpCapability } from "./pulumi-up";

const v1 = { digest: "sha256:" + "1".repeat(64), label: "v1" };
const v2 = { digest: "sha256:" + "2".repeat(64), label: "v2" };
const spec = asPipelineSpec({
  name: "app",
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "web" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "web" }] }], onVerifyFail: "rollback" },
  ],
});

/** The real capability's declarations, with its update standing in for `pulumi up` and a verify that fails. */
function registry(): CapabilityRegistry {
  const updated: Capability<never, unknown> = { ...(pulumiUpCapability as Capability<never, unknown>), run: async () => ({ updated: true }) };
  const verify = { kind: "http-check", rollbackPolicy: "none-by-design" as const, run: async () => { throw new Error("502 from /"); } };
  return new CapabilityRegistry().register(updated).register(verify as never);
}

const component: DriverComponent = {
  name: "web",
  deploy: [
    { phase: "deploy", steps: [{ kind: "pulumi-up", dir: "stacks/web", stack: "prod", noRollback: "the stack's state is the record; a release is restored by updating to it again" }] },
    { phase: "verify", steps: [{ kind: "http-check", url: "https://example.test/" }] },
  ],
} as DriverComponent;

const record = (release: { digest: string }, minute: number): ReleaseRecord =>
  ({ version: 1, component: "web", env: "prod", digest: `sha256:${release.digest.slice(7, 15)}`, digestKind: "templates", gitSha: "b".repeat(40), runId: `r${minute}`, timestamp: new Date(Date.UTC(2026, 10, 20, 0, minute)).toISOString(), actor: "ci", releaseDigest: release.digest }) as ReleaseRecord;

describe("a pulumi-up stage with onVerifyFail: rollback", () => {
  test("the build takes it: the capability answers releaseInputs, and noRollback decides nothing", () => {
    expect(pulumiUpCapability.rollbackPolicy).toBe("needs-opt-out");
    expect(typeof pulumiUpCapability.releaseInputs).toBe("function");
    const problems = verifyRollbackProblems({
      spec,
      steps: [{ where: 'component "web" step deploy/pulumi-up', kind: "pulumi-up" }],
      capability: () => ({ releaseInputs: typeof pulumiUpCapability.releaseInputs === "function", rollbackPolicy: pulumiUpCapability.rollbackPolicy ?? "none-by-design" }),
    });
    expect(problems).toEqual([]);
  });

  test("a failed verify leaves the update in place, requests the rollback, and the rollback is a forward apply of the earlier release", async () => {
    const result = await runComponentDeploy(component, { env: "prod", component: "web" }, registry(), {}, undefined, { port: memoryGateLedgerPort() });
    expect(result.records.map((r) => `${r.kind}:${r.status}`)).toEqual(["pulumi-up:ok", "http-check:fail", "pulumi-up:rollback-opted-out"]);
    const members = memberStatesOf(["web"], [result]);
    expect(members).toEqual([{ member: "web", state: "left-applied" }]);

    const stages = memoryStageLedgerPort();
    const gates = memoryGateLedgerPort();
    const records = [record(v1, 1)];
    const out = await requestStageRollback({
      spec,
      stage: "prod",
      failure: "verify",
      failed: v2,
      members,
      detail: ["web verify/http-check: 502 from /"],
      records,
      exclude: new Set([v2.digest]),
      check: async () => ({ kept: true, revoked: null }),
      label: (d) => (d === v1.digest ? "v1" : null),
      stages,
      gates,
      by: "ci",
      now: new Date(Date.UTC(2026, 10, 20, 1)),
    });
    expect(out).toMatchObject({ status: "requested", exitCode: 3 });
    expect(stages.lines[1]).toMatchObject({ kind: "rollback-requested", release: v1, members: [{ member: "web", state: "left-applied", rollback: "requested" }] });
    expect(gates.appended[0]).toMatchObject({ gate: "prod-rollback", planDigest: v1.digest });

    // What `components rollback prod --requested` plans once the gate passes: the stack as v1 recorded it, updated forward.
    const release = { releaseDigest: v1.digest, artifactDigests: [], targets: [{ env: "prod", templates: [{ component: "web", path: "stacks/web/index.ts", digest: "sha256:t" }] }] } as never;
    const plan = planReleaseRollback({ env: "prod", records, declared: ["web"], release, label: "v1", unsettled: new Set(["web"]), only: new Set(["web"]) });
    expect(plan).toMatchObject({ from: "prod", to: "prod", items: [{ component: "web", source: { releaseDigest: v1.digest, digestKind: "templates" } }] });
  });
});
