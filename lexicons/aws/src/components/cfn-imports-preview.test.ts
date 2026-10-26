/**
 * The preview of an importer whose export is not known yet (#4466b): its
 * change set is made from a copy of its template in which each such import
 * is a stand-in parameter (`cfnPlaceholder`), with entries and a PlanShape
 * as #4423 gives a member whose parameters are unknown. Once the exporter
 * applies, the real change set is checked with `planShapeDifferences`
 * before it executes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { withDeclaredReads } from "@intentius/chant/components/declared-reads";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { applyPrSet, planPrSet } from "@intentius/chant/components/pr-run";
import { CFN_UNKNOWN_MARK, createCfnDeployCapability } from "./apply";
import { cfnStandInParameter, cfnTemplateWithStandIns } from "./cfn-imports";
import { createMockCloudExecutor, type FakeStackConfig } from "./__tests__/mock-cloud-executor";

let dir: string;
const write = (name: string, template: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(template));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-imports-preview-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NETWORK = {
  Resources: { Vpc: { Type: "AWS::EC2::VPC" } },
  Outputs: { VpcId: { Value: { Ref: "Vpc" }, Export: { Name: { "Fn::Sub": "${AWS::StackName}-VpcId" } } } },
};
const APP = {
  Resources: {
    Group: { Type: "AWS::EC2::SecurityGroup", Properties: { GroupDescription: "app", VpcId: { "Fn::ImportValue": "network-VpcId" } } },
  },
  Outputs: { Vpc: { Value: { "Fn::ImportValue": "network-VpcId" } } },
};
const STAND_IN = cfnStandInParameter("network-VpcId");

describe("the template copy (#4466b)", () => {
  it("each import of a waiting name is a Ref to a String stand-in parameter; other imports stay", () => {
    const template = { ...APP, Resources: { ...APP.Resources, Other: { Type: "AWS::SNS::Topic", Properties: { TopicName: { "Fn::ImportValue": "elsewhere" } } } } };
    const { template: copy, standIns } = cfnTemplateWithStandIns(template, ["network-VpcId"], {});
    expect(standIns).toEqual({ [STAND_IN]: "network-VpcId" });
    expect(copy.Resources).toEqual({
      Group: { Type: "AWS::EC2::SecurityGroup", Properties: { GroupDescription: "app", VpcId: { Ref: STAND_IN } } },
      Other: { Type: "AWS::SNS::Topic", Properties: { TopicName: { "Fn::ImportValue": "elsewhere" } } },
    });
    expect(copy.Outputs).toEqual({ Vpc: { Value: { Ref: STAND_IN } } });
    expect((copy.Parameters as Record<string, { Type: string }>)[STAND_IN]!.Type).toBe("String");
    // The original is untouched.
    expect(template.Resources.Group.Properties.VpcId).toEqual({ "Fn::ImportValue": "network-VpcId" });
  });

  it("a stand-in name keeps only letters and digits, and two names never share one", () => {
    expect(cfnStandInParameter("a-b")).toMatch(/^ChantImportab[0-9a-f]{8}$/);
    expect(cfnStandInParameter("a-b")).not.toBe(cfnStandInParameter("a:b"));
  });
});

describe("cfn-deploy previews an importer whose export is not known yet (#4466b)", () => {
  it("creates its change set from the copy with a stand-in value, marks what the import drives, and removes the copy", async () => {
    const template = write("app.json", APP);
    const mock = createMockCloudExecutor({
      stacks: { app: { changes: [{ action: "Add", logicalResourceId: "Group", resourceType: "AWS::EC2::SecurityGroup", replacement: false }] } },
    });
    const planned = await createCfnDeployCapability(mock.executor).plan!(
      { env: "local", component: "app", unresolvedInputs: ["network"] },
      { stack: "app", template, imports: { "network-VpcId": undefined } },
    );
    const created = mock.calls.find((c) => c.method === "createChangeSet")!.args as { templatePath: string; parameters: Record<string, string> };
    expect(created.templatePath).not.toBe(template);
    expect(created.templatePath).toMatch(/app\.preview\.template\.json$/);
    expect(created.parameters).toEqual({ [STAND_IN]: CFN_UNKNOWN_MARK });
    expect(existsSync(created.templatePath)).toBe(false);
    expect(planned.artifact).toMatchObject({ kind: "cfn-deploy-shape", member: "app" });
    expect(planned.shape).toMatchObject({ member: "app", unknownInputs: ["network"] });
    expect(planned.shape!.entries).toEqual([
      expect.objectContaining({ logicalId: "Group", action: "create", unknown: ["VpcId"] }),
    ]);
    expect(planned.changeSet!.member.holes).toEqual([]);
    expect(planned.changeSet!.entries).toHaveLength(1);
    expect(mock.calls.map((c) => c.method)).not.toContain("executeChangeSet");
  });

  it("the preview's shape enters the digest, so a different preview is a different plan", async () => {
    const template = write("app.json", APP);
    const plan = async (changes: FakeStackConfig["changes"]) =>
      createCfnDeployCapability(createMockCloudExecutor({ stacks: { app: { changes } } }).executor).plan!(
        { env: "local", component: "app", unresolvedInputs: ["network"] },
        { stack: "app", template, imports: { "network-VpcId": undefined } },
      );
    const one = await plan([{ action: "Add", logicalResourceId: "Group", resourceType: "AWS::EC2::SecurityGroup", replacement: false }]);
    const two = await plan([
      { action: "Add", logicalResourceId: "Group", resourceType: "AWS::EC2::SecurityGroup", replacement: false },
      { action: "Add", logicalResourceId: "Extra", resourceType: "AWS::SNS::Topic", replacement: false },
    ]);
    expect(one.planDigest).not.toBe(two.planDigest);
  });
});

describe("pr-apply over two stacks wired only by an import (#4466b)", () => {
  const approvedFirst = { status: "approved" as const, approvedBy: ["github:rev"] };
  const groupAdd = { action: "Add" as const, logicalResourceId: "Group", resourceType: "AWS::EC2::SecurityGroup", replacement: false };
  const extraAdd = { action: "Add" as const, logicalResourceId: "Extra", resourceType: "AWS::SNS::Topic", replacement: false };
  const stacks = (): Record<string, FakeStackConfig> => ({
    network: { outputs: { VpcId: "vpc-1" }, changes: [{ action: "Add", logicalResourceId: "Vpc", resourceType: "AWS::EC2::VPC", replacement: false }] },
    app: { changes: [groupAdd] },
  });
  const executed = (mock: ReturnType<typeof createMockCloudExecutor>) =>
    mock.calls.filter((c) => c.method === "executeChangeSet").map((c) => (c.args as { stackName: string }).stackName);

  async function planned(config: Record<string, FakeStackConfig>) {
    const declared: DriverComponent[] = [
      { name: "network", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "network", template: write("network.json", NETWORK) }] }] },
      { name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "app", template: write("app.json", APP) }] }] },
    ];
    const mock = createMockCloudExecutor({ stacks: config });
    const registry = new CapabilityRegistry();
    registry.register(createCfnDeployCapability(mock.executor));
    const components = await withDeclaredReads(declared, registry, dir);
    const plan = planFanOut({ components, changed: ["network", "app"] });
    const set = await planPrSet({ components, plan, registry, env: "local" });
    return { mock, registry, components, plan, set };
  }

  it("the plan previews app with entries and a shape that names the import as unknown", async () => {
    const { set } = await planned(stacks());
    expect(set.shapes?.app).toMatchObject({ member: "app", unknownInputs: ["network"] });
    expect(set.plans.app?.app).toMatchObject({ kind: "cfn-deploy-shape" });
    expect(set.doc.entries.filter((e) => e.member === "app").map((e) => e.address)).toEqual(["Group"]);
  });

  it("the real change set has the previewed shape: one approval covers the round, and both stacks execute in order", async () => {
    const { mock, registry, components, plan, set } = await planned(stacks());
    let asked = 0;
    const applied = await applyPrSet({
      components,
      plan,
      registry,
      env: "local",
      set,
      approval: approvedFirst,
      decideRound: async () => {
        asked++;
        return { satisfied: false, approval: { status: "pending" } };
      },
    });
    expect(asked).toBe(0);
    expect(applied.status).toBe("applied");
    expect(executed(mock)).toEqual(["network", "app"]);
    expect(applied.rounds?.[0]).toMatchObject({ round: 2, status: "applied", covered: { digest: set.doc.digest, filledInputs: ["network.VpcId"] } });
  });

  it("a real change set the preview did not show is not executed: app waits at the next round", async () => {
    const { mock, registry, components, plan, set } = await planned(stacks());
    mock.setStack("app", { changes: [groupAdd, extraAdd] });
    const applied = await applyPrSet({
      components,
      plan,
      registry,
      env: "local",
      set,
      approval: approvedFirst,
      decideRound: async () => ({ satisfied: false, approval: { status: "pending" } }),
    });
    expect(applied.status).toBe("waiting");
    expect(executed(mock)).toEqual(["network"]);
    expect(applied.rounds?.[0]).toMatchObject({ round: 2, status: "waiting", notCovered: "app now plans to create Extra, which the first plan did not" });
  });
});
