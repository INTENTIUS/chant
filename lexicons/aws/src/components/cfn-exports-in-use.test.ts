/**
 * An export another stack still imports (#4466c): CloudFormation refuses to
 * change or remove it at apply, so a plan that would is refused at plan
 * time, naming both stacks. A change the plan cannot say about is a hole.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { planPrSet } from "@intentius/chant/components/pr-run";
import { CfnExportInUseError, createCfnDeployCapability } from "./apply";
import { createMockCloudExecutor, type FakeStackConfig } from "./__tests__/mock-cloud-executor";

let dir: string;
let template: string;
const write = (t: unknown) => writeFileSync(template, JSON.stringify(t));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-exports-"));
  template = join(dir, "network.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const exported = (value: unknown = { Ref: "Vpc" }) => ({
  Resources: { Vpc: { Type: "AWS::EC2::VPC" }, Topic: { Type: "AWS::SNS::Topic" } },
  Outputs: { VpcId: { Value: value, Export: { Name: { "Fn::Sub": "${AWS::StackName}-VpcId" } } } },
});
const topicChange = { action: "Modify" as const, logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, replacementMode: "False" as const };
const network = (extra: Partial<FakeStackConfig> = {}, importers: string[] = ["app"]): FakeStackConfig => ({
  outputs: { VpcId: "vpc-1" },
  exports: { "network-VpcId": "VpcId" },
  importedBy: { "network-VpcId": importers },
  changes: [topicChange],
  ...extra,
});

async function plan(config: FakeStackConfig, extra: Record<string, unknown> = {}) {
  const mock = createMockCloudExecutor({ stacks: { network: config } });
  const result = await createCfnDeployCapability(mock.executor)
    .plan!({ env: "local", component: "network" }, { stack: "network", template, ...extra })
    .catch((e: unknown) => e);
  return { mock, result };
}
const methods = (mock: ReturnType<typeof createMockCloudExecutor>) => mock.calls.map((c) => c.method);

describe("a plan that changes or removes an export in use (#4466c)", () => {
  it("removing an export app imports is refused at plan time, naming both stacks, and nothing is executed", async () => {
    write({ Resources: { Vpc: { Type: "AWS::EC2::VPC" }, Topic: { Type: "AWS::SNS::Topic" } } });
    const { mock, result } = await plan(network());
    expect(result).toBeInstanceOf(CfnExportInUseError);
    expect((result as CfnExportInUseError).uses).toEqual([{ exportName: "network-VpcId", change: "removes {export}", importers: ["app"] }]);
    expect((result as Error).message).toBe(
      'cfn-deploy "network": refusing the plan: it removes export network-VpcId, which stack app still imports. ' +
        "CloudFormation refuses to change or remove an export another stack imports. Change app to stop importing it first, then change network.",
    );
    expect(methods(mock)).toContain("deleteChangeSet");
    expect(methods(mock)).not.toContain("executeChangeSet");
  });

  it("changing an export's value is refused, with the value it has and the one it would get", async () => {
    write(exported("vpc-2"));
    const { result } = await plan(network());
    expect(result).toBeInstanceOf(CfnExportInUseError);
    expect((result as Error).message).toContain("it changes export network-VpcId from vpc-1 to vpc-2, which stack app still imports");
  });

  it("renaming an export is removing it", async () => {
    write({ ...exported(), Outputs: { VpcId: { Value: { Ref: "Vpc" }, Export: { Name: "renamed-VpcId" } } } });
    const { result } = await plan(network());
    expect((result as CfnExportInUseError).uses?.[0]).toMatchObject({ exportName: "network-VpcId", change: "removes {export}" });
  });

  it("every importer is named", async () => {
    write({ Resources: { Topic: { Type: "AWS::SNS::Topic" } } });
    const { result } = await plan(network({}, ["edge", "app"]));
    expect((result as Error).message).toContain("which stacks app, edge still import");
  });

  it("an export whose value stays plans as before, and only that export's importers are asked for", async () => {
    write(exported());
    const { mock, result } = await plan(network());
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { changeSet: { member: { holes: unknown[] } } }).changeSet.member.holes).toEqual([]);
    expect(methods(mock)).not.toContain("listImports");
  });

  it("an export nobody imports can change", async () => {
    write(exported("vpc-2"));
    const { result } = await plan(network({}, []));
    expect(result).not.toBeInstanceOf(Error);
  });

  it("an export whose new value is known only after apply is a hole naming its importers, not a refusal", async () => {
    write(exported());
    const { result } = await plan(
      network({ changes: [{ action: "Modify", logicalResourceId: "Vpc", resourceType: "AWS::EC2::VPC", replacement: true, replacementMode: "True" }] }),
      { onReplace: "allow" },
    );
    expect(result).not.toBeInstanceOf(Error);
    expect((result as { changeSet: { member: { holes: unknown[] } } }).changeSet.member.holes).toEqual([
      {
        address: "Outputs.VpcId",
        reason:
          "the plan may change export network-VpcId: the value of output VpcId is known only after apply, and app still imports it; CloudFormation refuses the apply if it changes",
      },
    ]);
  });
});

describe("in a pull request's plan (#4466c)", () => {
  it("the exporter's member fails to plan with the refusal, and the set is failed", async () => {
    write({ Resources: { Topic: { Type: "AWS::SNS::Topic" } } });
    const mock = createMockCloudExecutor({ stacks: { network: network() } });
    const registry = new CapabilityRegistry();
    registry.register(createCfnDeployCapability(mock.executor));
    const components: DriverComponent[] = [
      { name: "network", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "network", template }] }] },
    ];
    const set = await planPrSet({ components, plan: planFanOut({ components, changed: ["network"] }), registry, env: "local" });
    expect(set.failed).toBe(true);
    const member = set.members.find((m) => m.member === "network")!;
    expect(member.status).toBe("plan-failed");
    expect(member.error).toContain("it removes export network-VpcId, which stack app still imports");
  });
});

describe("a backend that cannot list imports (#4466d)", () => {
  it("is a hole on the export at stake, not a failed plan", async () => {
    write({ Resources: { Topic: { Type: "AWS::SNS::Topic" } } });
    const mock = createMockCloudExecutor({ stacks: { network: network() } });
    mock.executor.cloudformation.listImports = async () => {
      throw new Error("UnknownAction: ListImports");
    };
    const result = await createCfnDeployCapability(mock.executor).plan!({ env: "local", component: "network" }, { stack: "network", template });
    expect(result.changeSet!.member.holes).toEqual([
      {
        address: "Outputs.VpcId",
        reason: "the plan removes export network-VpcId, and the stacks that import it could not be listed: UnknownAction: ListImports",
      },
    ]);
  });
});
