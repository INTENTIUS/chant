/**
 * A stage of `terraform-apply` steps that rolls back when its verify fails
 * (#5328). The capability declares `rollbackPolicy: "needs-opt-out"`, so the
 * step carries `noRollback` and a failed verify leaves the apply in place.
 * The stage's rollback is then a forward apply of the earlier release: the
 * release recorded the root through `releaseInputs`, and
 * `components rollback --release` applies that copy.
 */
import { describe, expect, test } from "vitest";
import { CapabilityRegistry, type Capability } from "@intentius/chant/components/capability";
import { runComponentDeploy, type DriverComponent } from "@intentius/chant/components/driver";
import { planReleaseRollback } from "@intentius/chant/components/promote";
import { memoryGateLedgerPort } from "@intentius/chant/op/gate";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import { asPipelineSpec, memberStatesOf, memoryStageLedgerPort, requestStageRollback, verifyRollbackProblems } from "@intentius/chant/pipeline";
import { terraformApplyCapability } from "./capability-plugin";

const v1 = { digest: "sha256:" + "1".repeat(64), label: "v1" };
const v2 = { digest: "sha256:" + "2".repeat(64), label: "v2" };
const spec = asPipelineSpec({
  name: "infra",
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "network" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "network" }] }], onVerifyFail: "rollback" },
  ],
});

/** The real capability's declarations, with its apply standing in for `tofu apply` and a verify that fails. */
function registry(): CapabilityRegistry {
  const applied: Capability<never, unknown> = { ...(terraformApplyCapability as Capability<never, unknown>), run: async () => ({ applied: true }) };
  const verify = { kind: "http-check", rollbackPolicy: "none-by-design" as const, run: async () => { throw new Error("503 from /healthz"); } };
  return new CapabilityRegistry().register(applied).register(verify as never);
}

const component: DriverComponent = {
  name: "network",
  deploy: [
    { phase: "deploy", steps: [{ kind: "terraform-apply", root: "infra/network", noRollback: "the state file is the record; a release is restored by applying it again" }] },
    { phase: "verify", steps: [{ kind: "http-check", url: "https://example.test/healthz" }] },
  ],
} as DriverComponent;

const record = (release: { digest: string }, minute: number): ReleaseRecord =>
  ({ version: 1, component: "network", env: "prod", digest: `sha256:${release.digest.slice(7, 15)}`, digestKind: "templates", gitSha: "a".repeat(40), runId: `r${minute}`, timestamp: new Date(Date.UTC(2026, 10, 20, 0, minute)).toISOString(), actor: "ci", releaseDigest: release.digest }) as ReleaseRecord;

describe("a terraform-apply stage with onVerifyFail: rollback", () => {
  test("the build takes it: the capability answers releaseInputs, and noRollback decides nothing", () => {
    expect(terraformApplyCapability.rollbackPolicy).toBe("needs-opt-out");
    expect(typeof terraformApplyCapability.releaseInputs).toBe("function");
    const problems = verifyRollbackProblems({
      spec,
      steps: [{ where: 'component "network" step deploy/terraform-apply', kind: "terraform-apply" }],
      capability: () => ({ releaseInputs: typeof terraformApplyCapability.releaseInputs === "function", rollbackPolicy: terraformApplyCapability.rollbackPolicy ?? "none-by-design" }),
    });
    expect(problems).toEqual([]);
  });

  test("a failed verify leaves the apply in place, requests the rollback, and the rollback is a forward apply of the earlier release", async () => {
    const result = await runComponentDeploy(component, { env: "prod", component: "network" }, registry(), {}, undefined, { port: memoryGateLedgerPort() });
    expect(result.status).toBe("fail");
    expect(result.records.map((r) => `${r.kind}:${r.status}`)).toEqual(["terraform-apply:ok", "http-check:fail", "terraform-apply:rollback-opted-out"]);

    const members = memberStatesOf(["network"], [result]);
    expect(members).toEqual([{ member: "network", state: "left-applied" }]);

    const stages = memoryStageLedgerPort();
    const gates = memoryGateLedgerPort();
    const records = [record(v1, 1)];
    const out = await requestStageRollback({
      spec,
      stage: "prod",
      failure: "verify",
      failed: v2,
      members,
      detail: ["network verify/http-check: 503 from /healthz"],
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
    expect(stages.lines[1]).toMatchObject({ kind: "rollback-requested", release: v1, members: [{ member: "network", state: "left-applied", rollback: "requested" }] });
    expect(gates.appended[0]).toMatchObject({ gate: "prod-rollback", planDigest: v1.digest });

    // What `components rollback prod --requested` plans once the gate passes: the root as v1 recorded it, applied forward.
    // The failed promote recorded no release for network, so the ledger still names v1; its deploy outcome leaves it unsettled.
    const release = { releaseDigest: v1.digest, artifactDigests: [], targets: [{ env: "prod", templates: [{ component: "network", path: "infra/network/main.tf", digest: "sha256:t" }] }] } as never;
    const plan = planReleaseRollback({ env: "prod", records, declared: ["network"], release, label: "v1", unsettled: new Set(["network"]), only: new Set(["network"]) });
    expect(plan).toMatchObject({ from: "prod", to: "prod", items: [{ component: "network", source: { releaseDigest: v1.digest, digestKind: "templates" } }] });
  });
});
