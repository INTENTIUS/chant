/**
 * `Fn::ImportValue` between stacks (#4466a): an import of a name another
 * `cfn-deploy` step's template exports is a read of `<component>.<output>`,
 * which orders the importer after the exporter, lists it under
 * `unknownInputs` and plans it as waiting on that stack. A name the plan
 * cannot resolve is a hole that says why.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { withDeclaredReads } from "@intentius/chant/components/declared-reads";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { planPrSet } from "@intentius/chant/components/pr-run";
import { capabilitySteps } from "@intentius/chant/components/wave-plan";
import { cfnDeclaredReads, cfnPlannedOutputs, createCfnDeployCapability } from "./apply";
import { cfnExports, cfnImportPointer, cfnImports, cfnKnownValues, cfnPseudoParameters, resolveCfnName } from "./cfn-imports";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

let dir: string;
const write = (name: string, template: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(template));
  return path;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-imports-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NETWORK = {
  Resources: { Vpc: { Type: "AWS::EC2::VPC" } },
  Outputs: {
    VpcId: { Value: { Ref: "Vpc" }, Export: { Name: { "Fn::Sub": "${AWS::StackName}-VpcId" } } },
    Internal: { Value: { Ref: "Vpc" } },
  },
};
const APP = {
  Parameters: { NetworkStack: { Type: "String", Default: "network" } },
  Resources: {
    Group: { Type: "AWS::EC2::SecurityGroup", Properties: { VpcId: { "Fn::ImportValue": { "Fn::Sub": "${NetworkStack}-VpcId" } } } },
  },
  Outputs: { GroupId: { Value: { Ref: "Group" }, Export: { Name: "app-GroupId" } } },
};

describe("export and import names (#4466a)", () => {
  const known = { NetworkStack: "network", "AWS::StackName": "app" };

  it("a string is itself; Fn::Sub, Ref and Fn::Join resolve from what is known", () => {
    expect(resolveCfnName("x", known)).toEqual({ name: "x" });
    expect(resolveCfnName({ "Fn::Sub": "${NetworkStack}-VpcId" }, known)).toEqual({ name: "network-VpcId" });
    expect(resolveCfnName({ "Fn::Sub": ["${Prefix}-${AWS::StackName}", { Prefix: { Ref: "NetworkStack" } }] }, known)).toEqual({ name: "network-app" });
    expect(resolveCfnName({ "Fn::Sub": "${!Literal}-x" }, known)).toEqual({ name: "${Literal}-x" });
    expect(resolveCfnName({ Ref: "NetworkStack" }, known)).toEqual({ name: "network" });
    expect(resolveCfnName({ "Fn::Join": ["-", [{ Ref: "NetworkStack" }, "VpcId"]] }, known)).toEqual({ name: "network-VpcId" });
  });

  it("a name that reads what the plan does not know is unresolved, and says what it reads", () => {
    expect(resolveCfnName({ "Fn::Sub": "${Missing}-VpcId" }, known)).toEqual({ unresolved: "reads parameter Missing, which has no value the plan knows" });
    expect(resolveCfnName({ "Fn::Sub": "${AWS::AccountId}-VpcId" }, known)).toEqual({ unresolved: "reads AWS::AccountId, which is known only at apply" });
    expect(resolveCfnName({ "Fn::Sub": "${Vpc.Arn}" }, known)).toEqual({ unresolved: "reads Vpc.Arn, a resource attribute" });
    expect(resolveCfnName({ "Fn::Select": [0, ["a"]] }, known)).toEqual({ unresolved: "uses Fn::Select, which this plan does not follow" });
  });

  it("the pseudo parameters: the stack name always, the region's when the environment names it", () => {
    expect(cfnPseudoParameters("app", {})).toEqual({ "AWS::StackName": "app" });
    expect(cfnPseudoParameters("app", { AWS_REGION: "cn-north-1" })).toEqual({
      "AWS::StackName": "app",
      "AWS::Region": "cn-north-1",
      "AWS::Partition": "aws-cn",
      "AWS::URLSuffix": "amazonaws.com.cn",
    });
  });

  it("known values are the defaults, overlaid by plain inputs; a wired input is not known", () => {
    const values = cfnKnownValues(APP, "app", { NetworkStack: "shared", Other: { stackOutput: { stack: "x", name: "y" } } }, {});
    expect(values).toEqual({ NetworkStack: "shared", "AWS::StackName": "app" });
  });

  it("lists exports by output and imports by place", () => {
    expect(cfnExports(NETWORK, cfnKnownValues(NETWORK, "network", {}, {}))).toEqual([{ output: "VpcId", name: "network-VpcId" }]);
    expect(cfnImports(APP, cfnKnownValues(APP, "app", {}, {}))).toEqual([{ at: "Resources.Group.Properties.VpcId", logicalId: "Group", name: "network-VpcId" }]);
  });

  it("an export name's pointer escapes / and ~", () => {
    expect(cfnImportPointer("a/b~c")).toBe("/imports/a~1b~0c");
  });
});

describe("cfn-deploy's declared reads (#4466a)", () => {
  it("an import of a name another step exports is a read of that component's output", () => {
    const network = write("network.json", NETWORK);
    const app = write("app.json", APP);
    const reads = cfnDeclaredReads(dir, [
      { component: "network", index: 0, step: { stack: "network", template: network } },
      { component: "app", index: 0, step: { stack: "app", template: app } },
    ]);
    expect(reads).toEqual([{ reader: "app", index: 0, upstream: "network", output: "VpcId", at: "/imports/network-VpcId" }]);
  });

  it("a relative template path is read against the root", () => {
    write("network.json", NETWORK);
    write("app.json", APP);
    const reads = cfnDeclaredReads(dir, [
      { component: "network", index: 0, step: { template: "network.json" } },
      { component: "app", index: 0, step: { template: "app.json" } },
    ]);
    expect(reads.map((r) => `${r.reader}<-${r.upstream}.${r.output}`)).toEqual(["app<-network.VpcId"]);
  });

  it("no read for a name no step exports, a name two steps export, or a name the step cannot resolve", () => {
    const network = write("network.json", NETWORK);
    const twin = write("twin.json", NETWORK);
    const app = write("app.json", APP);
    // network and twin both default AWS::StackName to the same stack name: two exports of one name.
    expect(
      cfnDeclaredReads(dir, [
        { component: "network", index: 0, step: { stack: "network", template: network } },
        { component: "twin", index: 0, step: { stack: "network", template: twin } },
        { component: "app", index: 0, step: { stack: "app", template: app } },
      ]),
    ).toEqual([]);
    expect(cfnDeclaredReads(dir, [{ component: "app", index: 0, step: { stack: "app", template: app } }])).toEqual([]);
    const wired = write("wired.json", { ...APP, Parameters: { NetworkStack: { Type: "String" } } });
    expect(
      cfnDeclaredReads(dir, [
        { component: "network", index: 0, step: { stack: "network", template: network } },
        { component: "app", index: 0, step: { stack: "app", template: wired, inputs: { NetworkStack: { stackOutput: { stack: "x", name: "y" } } } } },
      ]),
    ).toEqual([]);
  });

  it("an output that passes an import through is known at the import's value", () => {
    const template = { Outputs: { Vpc: { Value: { "Fn::ImportValue": "network-VpcId" } }, Other: { Value: { "Fn::ImportValue": "elsewhere" } } } };
    expect(cfnPlannedOutputs(template, [], { Vpc: "old", Other: "x" }, {}, { "network-VpcId": "vpc-123" })).toEqual({ known: { Vpc: "vpc-123" }, unknown: ["Other"] });
  });
});

describe("a pull request's plan over stacks wired only by imports (#4466a)", () => {
  async function planned() {
    const network = write("network.json", NETWORK);
    const app = write("app.json", APP);
    const declared: DriverComponent[] = [
      { name: "network", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "network", template: network }] }] },
      { name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "app", template: app }] }] },
    ];
    const mock = createMockCloudExecutor({ stacks: { network: { missing: true }, app: { missing: true } } });
    const registry = new CapabilityRegistry();
    registry.register(createCfnDeployCapability(mock.executor));
    const components = await withDeclaredReads(declared, registry, dir);
    const plan = planFanOut({ components, changed: ["network", "app"] });
    const set = await planPrSet({ components, plan, registry, env: "local" });
    return { components, plan, set, mock };
  }

  it("orders the importer after the exporter and writes the read into its step", async () => {
    const { components, plan } = await planned();
    expect(plan.waves).toEqual([["network"], ["app"]]);
    const app = components.find((c) => c.name === "app")!;
    expect(app.dependsOn).toEqual(["network"]);
    expect(capabilitySteps(app.deploy)[0]).toMatchObject({ imports: { "network-VpcId": { stackOutput: { stack: "network", name: "VpcId" } } } });
  });

  it("lists the import under unknownInputs and reads, while network's plan cannot say the value", async () => {
    const { set } = await planned();
    const app = set.members.find((m) => m.component === "app")!;
    expect(app.unknownInputs).toEqual(["network.VpcId"]);
    expect(app.reads).toEqual([{ upstream: "network", outputs: ["VpcId"], unknown: ["VpcId"] }]);
  });

  it("an importer whose template cannot be read as JSON plans as waiting on the exporter (no preview, #4466b)", async () => {
    const { set, components } = await planned();
    const app = components.find((c) => c.name === "app")!;
    const step = capabilitySteps(app.deploy)[0]! as Record<string, unknown>;
    writeFileSync(step.template as string, "not json");
    const mock = createMockCloudExecutor({ stacks: { app: { missing: true } } });
    const planned2 = await createCfnDeployCapability(mock.executor).plan!(
      { env: "local", component: "app", unresolvedInputs: ["network"] },
      { stack: "app", template: step.template as string, imports: { "network-VpcId": undefined } },
    );
    expect(planned2.changeSet!.member.holes).toEqual([
      {
        address: "app",
        type: "AWS::CloudFormation::Stack",
        reason: "imports network-VpcId, exported by network, which apply first; re-checked on apply; no preview: the template could not be read as JSON to stand in for its imports",
      },
    ]);
    expect(set.doc.members.find((m) => m.member === "app")).toBeDefined();
  });
});

describe("an import whose name the plan cannot resolve (#4466a)", () => {
  it("is a hole on the importer's member that says what the name reads", async () => {
    const template = write("app.json", {
      Resources: { Group: { Type: "AWS::EC2::SecurityGroup", Properties: { VpcId: { "Fn::ImportValue": { "Fn::Sub": "${AWS::AccountId}-VpcId" } } } } },
    });
    const mock = createMockCloudExecutor({ stacks: { app: { changes: [{ action: "Add", logicalResourceId: "Group", resourceType: "AWS::EC2::SecurityGroup", replacement: false }] } } });
    const planned = await createCfnDeployCapability(mock.executor).plan!({ env: "local", component: "app" }, { stack: "app", template });
    expect(planned.changeSet!.member.holes).toEqual([
      {
        address: "Group",
        type: "AWS::EC2::SecurityGroup",
        reason:
          "the Fn::ImportValue at Resources.Group.Properties.VpcId reads AWS::AccountId, which is known only at apply, so the plan cannot say which export it reads or whether a stack in this change exports it",
      },
    ]);
    expect(planned.changeSet!.entries).toHaveLength(1);
  });
});
