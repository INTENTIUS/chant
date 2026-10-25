/**
 * `cfn-deploy`'s plan shapes pass core's plan shape conformance (#4425):
 * the preview with a stand-in parameter, the real change set planned after
 * the upstream applied, and real change sets that add, drop or replace a
 * resource, all made by `plan` against the mock executor.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlanShapeConformance } from "@intentius/chant/components";
import type { CfnChange } from "./cloud-executor";
import { createCfnDeployCapability } from "./apply";
import { createMockCloudExecutor } from "./__tests__/mock-cloud-executor";

let dir: string;
let template: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-shape-conformance-"));
  template = join(dir, "stack.template.json");
  writeFileSync(
    template,
    JSON.stringify({
      Parameters: { SubnetId: { Type: "AWS::EC2::Subnet::Id" } },
      Resources: {
        Eni: { Type: "AWS::EC2::NetworkInterface", Properties: { SubnetId: { Ref: "SubnetId" }, Description: "d" } },
        Q: { Type: "AWS::SQS::Queue", Properties: { QueueName: { "Fn::Sub": "q-${SubnetId}" } } },
      },
    }),
  );
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = { env: "local", component: "network" };

const eni: CfnChange = {
  action: "Modify",
  logicalResourceId: "Eni",
  resourceType: "AWS::EC2::NetworkInterface",
  replacement: false,
  replacementMode: "False",
  details: ["SubnetId", "Description"],
  drivers: [
    { property: "SubnetId", changeSource: "ParameterReference", causingEntity: "SubnetId" },
    { property: "Description", changeSource: "DirectModification" },
  ],
};
const q: CfnChange = { action: "Add", logicalResourceId: "Q", resourceType: "AWS::SQS::Queue", replacement: false };
const topic: CfnChange = { action: "Add", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false };

/** The member previewed: `SubnetId` holds nothing yet, so the plan uses a stand-in. */
async function preview() {
  const mock = createMockCloudExecutor({ stacks: { net: { changes: [eni, q] } } });
  const planned = await createCfnDeployCapability(mock.executor).plan!(
    { ...ctx, unresolvedInputs: ["vpc.SubnetId"] },
    { stack: "net", template, inputs: { SubnetId: undefined as never } },
  );
  return planned.shape;
}

/** The member planned again once the upstream applied, with the real change set `changes`. */
async function real(changes: CfnChange[]) {
  const mock = createMockCloudExecutor({ stacks: { net: { changes } } });
  const planned = await createCfnDeployCapability(mock.executor).plan!(ctx, { stack: "net", template, inputs: { SubnetId: "subnet-1" }, onReplace: "allow" });
  return planned.shape;
}

describe("cfn-deploy plan shape conformance (#4425)", () => {
  it("passes", async () => {
    const problems = await checkPlanShapeConformance({
      lexicon: "aws",
      preview,
      fresh: () => real([eni, q]),
      added: () => real([eni, q, topic]),
      missing: () => real([q]),
      replaced: () => real([{ ...eni, replacement: true, replacementMode: "True" }, q]),
    });
    expect(problems).toEqual([]);
  });
});
