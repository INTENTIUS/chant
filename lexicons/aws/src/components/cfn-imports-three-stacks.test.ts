/**
 * Three stacks wired only by exports and imports need one approval
 * (#4466d), as #4430 shows for parameters: the shape of
 * `examples/demo-composed-stacks`'s `chant-compose-imports` scenario,
 * against the mock executor. The same scenario runs on Floci in
 * demo-composed-stacks-floci.e2e.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { withDeclaredReads } from "@intentius/chant/components/declared-reads";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { applyPrSet, planPrSet } from "@intentius/chant/components/pr-run";
import { createCfnDeployCapability } from "./apply";
import { createMockCloudExecutor, type FakeStackConfig } from "./__tests__/mock-cloud-executor";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-imports-three-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TEMPLATES = {
  network: {
    Resources: { mainVpc: { Type: "AWS::EC2::VPC" }, subnetC: { Type: "AWS::EC2::Subnet", Properties: { VpcId: { Ref: "mainVpc" }, CidrBlock: "10.0.3.0/24" } } },
    Outputs: { SubnetCId: { Value: { Ref: "subnetC" }, Export: { Name: "chant-compose-subnet-c-id" } } },
  },
  app: {
    Resources: { importsInterface: { Type: "AWS::EC2::NetworkInterface", Properties: { SubnetId: { "Fn::ImportValue": "chant-compose-subnet-c-id" } } } },
    Outputs: { ImportsInterfaceId: { Value: { Ref: "importsInterface" }, Export: { Name: "chant-compose-imports-interface" } } },
  },
  edge: {
    Resources: {
      importsInterfaceRecord: {
        Type: "AWS::SSM::Parameter",
        Properties: { Name: "/chant-compose/imports-interface", Type: "String", Value: { "Fn::ImportValue": "chant-compose-imports-interface" } },
      },
    },
  },
};

const add = (logicalResourceId: string, resourceType: string) => ({ action: "Add" as const, logicalResourceId, resourceType, replacement: false });
const stacks = (): Record<string, FakeStackConfig> => ({
  network: { outputs: { SubnetCId: "subnet-c" }, changes: [add("subnetC", "AWS::EC2::Subnet")] },
  app: { outputs: { ImportsInterfaceId: "eni-1" }, changes: [add("importsInterface", "AWS::EC2::NetworkInterface")] },
  edge: { changes: [add("importsInterfaceRecord", "AWS::SSM::Parameter")] },
});
const executed = (mock: ReturnType<typeof createMockCloudExecutor>) =>
  mock.calls.filter((c) => c.method === "executeChangeSet").map((c) => (c.args as { stackName: string }).stackName);

async function planned() {
  // No dependsOn and no inputs: the imports are the only wiring.
  const declared: DriverComponent[] = (["edge", "app", "network"] as const).map((name) => {
    const template = join(dir, `${name}.template.json`);
    writeFileSync(template, JSON.stringify(TEMPLATES[name]));
    return { name, dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: name, template }] }] };
  });
  const mock = createMockCloudExecutor({ stacks: stacks() });
  const registry = new CapabilityRegistry();
  registry.register(createCfnDeployCapability(mock.executor));
  const components = await withDeclaredReads(declared, registry, dir);
  const plan = planFanOut({ components, changed: ["network", "app", "edge"] });
  const set = await planPrSet({ components, plan, registry, env: "local" });
  return { mock, registry, components, plan, set };
}

describe("three stacks wired only by imports (#4466d)", () => {
  it("are ordered by the imports, with each import known after apply and each importer previewed", async () => {
    const { plan, set } = await planned();
    expect(plan.waves).toEqual([["network"], ["app"], ["edge"]]);
    const by = Object.fromEntries(set.members.map((m) => [m.component, m]));
    expect(by.app!.unknownInputs).toEqual(["network.SubnetCId"]);
    expect(by.edge!.unknownInputs).toEqual(["app.ImportsInterfaceId"]);
    expect(set.plans.app?.app).toMatchObject({ kind: "cfn-deploy-shape" });
    expect(set.plans.edge?.edge).toMatchObject({ kind: "cfn-deploy-shape" });
    expect(set.doc.members.every((m) => m.holes.length === 0)).toBe(true);
    expect(set.doc.entries.map((e) => `${e.member}/${e.address}`).sort()).toEqual(["app/importsInterface", "edge/importsInterfaceRecord", "network/subnetC"]);
  });

  it("need one approval: both rounds are covered and the three stacks execute in order", async () => {
    const { mock, registry, components, plan, set } = await planned();
    let asked = 0;
    const applied = await applyPrSet({
      components,
      plan,
      registry,
      env: "local",
      set,
      approval: { status: "approved", approvedBy: ["github:rev"] },
      decideRound: async () => {
        asked++;
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(asked).toBe(0);
    expect(applied.status).toBe("applied");
    expect(executed(mock)).toEqual(["network", "app", "edge"]);
    const rounds = applied.rounds ?? [];
    expect(rounds.find((r) => r.components.includes("app"))?.covered?.filledInputs).toContain("network.SubnetCId");
    // Round 2 plans app and edge, and edge waits for app; the last round with edge is the one that applies it.
    expect([...rounds].reverse().find((r) => r.components.includes("edge"))?.covered?.filledInputs).toContain("app.ImportsInterfaceId");
  });
});
