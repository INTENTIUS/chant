/**
 * `cfn-deploy`'s plan (#4084): a change set created, read and deleted, never
 * executed, whose changes become the member's change-set entries, so
 * `chant components pr-plan` counts what each stack will change.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { planFanOut } from "@intentius/chant/components/fan-out";
import { applyPrSet, planPrSet, prReport } from "@intentius/chant/components/pr-run";
import { composeChangeSet } from "@intentius/chant/change-set";
import { groupChangeSet, planSummaryHeadline } from "@intentius/chant/plan-summary";
import { memberCounts, prStatusDescription, renderPrNote } from "@intentius/chant/pr-loop";
import { PlanShapeMovedError } from "@intentius/chant/components/covered-round";
import { CfnPlanMovedError, CfnReplacementBlockedError, cfnChangeEntry, createCfnDeployCapability, type CfnDeployInput } from "./apply";
import { isPlanMovedError } from "@intentius/chant/components/capability";
import { planMovedIn } from "@intentius/chant/components/driver";
import { readCfnChanges, templateHasNestedStacks, type DescribedCfnChangeSet } from "./cloud-executor";
import { createMockCloudExecutor, type FakeStackConfig } from "./__tests__/mock-cloud-executor";

let dir: string;
let template: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfn-plan-"));
  template = join(dir, "stack.template.json");
  writeFileSync(template, JSON.stringify({ Resources: { Topic: { Type: "AWS::SNS::Topic" } } }));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = { env: "local", component: "network" };

async function planOne(config: FakeStackConfig, extra: Partial<CfnDeployInput> = {}) {
  const mock = createMockCloudExecutor({ stacks: { network: config } });
  const capability = createCfnDeployCapability(mock.executor);
  const planned = await capability.plan!(ctx, { stack: "network", template, ...extra });
  const doc = composeChangeSet([planned.changeSet!]);
  return { mock, planned, doc, counts: memberCounts(doc, "network") };
}

const methods = (mock: ReturnType<typeof createMockCloudExecutor>) => mock.calls.map((c) => c.method);

describe("cfn-deploy plan (#4084)", () => {
  it("an update in place counts as an update, and the change set is deleted without being executed", async () => {
    const { mock, planned, doc, counts } = await planOne({
      changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, replacementMode: "False", details: ["DisplayName"] }],
    });
    expect(planned.member).toBe("network");
    expect(counts).toEqual({ create: 0, update: 1, replace: 0, delete: 0 });
    expect(doc.entries[0]).toMatchObject({
      member: "network",
      lexicon: "aws",
      planner: "chant",
      address: "Topic",
      type: "AWS::SNS::Topic",
      action: "update",
      disruption: "in-place",
      attributes: [{ path: "DisplayName" }],
    });
    expect(methods(mock)).toEqual(["createChangeSet", "deleteChangeSet"]);
    expect(methods(mock)).not.toContain("executeChangeSet");
  });

  it("a new resource in an existing stack counts as a create", async () => {
    const { counts, mock } = await planOne({
      changes: [{ action: "Add", logicalResourceId: "Queue", resourceType: "AWS::SQS::Queue", replacement: false }],
    });
    expect(counts).toEqual({ create: 1, update: 0, replace: 0, delete: 0 });
    expect(methods(mock)).not.toContain("deleteStackShell");
  });

  it("Replacement True and Conditional both count as a replace, and the summary lists them as destroys or replacements", async () => {
    const { counts, doc } = await planOne({
      changes: [
        { action: "Modify", logicalResourceId: "Table", resourceType: "AWS::DynamoDB::Table", replacement: true, replacementMode: "True" },
        { action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, replacementMode: "Conditional" },
        { action: "Remove", logicalResourceId: "Old", resourceType: "AWS::SQS::Queue", replacement: false },
      ],
    }, { onReplace: "allow" });
    expect(counts).toEqual({ create: 0, update: 0, replace: 2, delete: 1 });
    expect(planSummaryHeadline(groupChangeSet(doc))).toContain("3 destroys or replacements");
  });

  it("a change set with nothing to apply is a member with no entries and no holes, whose outputs are the stack's own (#3999)", async () => {
    const { counts, doc, mock, planned } = await planOne({ noChanges: true, outputs: { VpcId: "vpc-1" } });
    expect(counts).toEqual({ create: 0, update: 0, replace: 0, delete: 0 });
    expect(doc.members[0]).toMatchObject({ status: "planned", holes: [] });
    expect(groupChangeSet(doc, { unit: "member" }).groups[0].noChanges).toBe(true);
    expect(planned.outputs).toEqual({ known: { VpcId: "vpc-1" }, unknown: [] });
    expect(methods(mock)).toEqual(["createChangeSet", "describeStack", "deleteChangeSet"]);
  });

  it("a change set with changes keeps the outputs of resources it keeps, and not of the ones it adds or replaces (#3999)", async () => {
    writeFileSync(
      template,
      JSON.stringify({
        Parameters: { Env: { Type: "String" } },
        Resources: { Topic: { Type: "AWS::SNS::Topic" }, Queue: { Type: "AWS::SQS::Queue" }, Table: { Type: "AWS::DynamoDB::Table" } },
        Outputs: {
          TopicArn: { Value: { Ref: "Topic" } },
          QueueUrl: { Value: { "Fn::GetAtt": ["Queue", "QueueUrl"] } },
          TableArn: { Value: { "Fn::Sub": "${Table.Arn}" } },
          Region: { Value: { "Fn::Sub": "${AWS::Region}" } },
          EnvName: { Value: { Ref: "Env" } },
          Imported: { Value: { "Fn::ImportValue": "x" } },
        },
      }),
    );
    const standing = { TopicArn: "arn:topic", QueueUrl: "https://q", TableArn: "arn:table", Region: "us-east-1", EnvName: "prod", Imported: "x" };
    const { planned } = await planOne({
      outputs: standing,
      changes: [
        { action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, replacementMode: "False" },
        { action: "Modify", logicalResourceId: "Queue", resourceType: "AWS::SQS::Queue", replacement: true, replacementMode: "True" },
        { action: "Modify", logicalResourceId: "Table", resourceType: "AWS::DynamoDB::Table", replacement: false, replacementMode: "Conditional" },
      ],
    }, { onReplace: "allow" });
    expect(planned.outputs).toEqual({ known: { Region: "us-east-1", TopicArn: "arn:topic" }, unknown: ["EnvName", "Imported", "QueueUrl", "TableArn"] });
  });

  it("a stack the change set creates says nothing of its outputs (#3999)", async () => {
    const { planned } = await planOne({ missing: true, changes: [{ action: "Add", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false }] });
    expect(planned.outputs).toBeUndefined();
  });

  it("a stack that does not exist yet counts every resource as a create, and the empty stack the CREATE change set made is deleted", async () => {
    const { counts, mock } = await planOne({
      missing: true,
      changes: [
        { action: "Add", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false },
        { action: "Add", logicalResourceId: "Queue", resourceType: "AWS::SQS::Queue", replacement: false },
      ],
    });
    expect(counts).toEqual({ create: 2, update: 0, replace: 0, delete: 0 });
    expect(methods(mock)).toEqual(["createChangeSet", "deleteChangeSet", "deleteStackShell"]);
    await expect(mock.executor.cloudformation.describeStack("network")).rejects.toThrow(/does not exist/);
  });

  it("a change set that fails for any other reason fails the plan, and is still deleted", async () => {
    const base = createMockCloudExecutor({ stacks: { network: {} } });
    const executor = {
      ...base.executor,
      cloudformation: {
        ...base.executor.cloudformation,
        createChangeSet: async () => ({ changeSetName: "cs-1", stackName: "network", status: "FAILED", statusReason: "Template format error", isCreate: false, changes: [] }),
      },
    };
    const capability = createCfnDeployCapability(executor);
    await expect(capability.plan!(ctx, { stack: "network", template })).rejects.toThrow(/Template format error/);
    expect(methods(base)).toEqual(["deleteChangeSet"]);
  });

  it("the plan digest binds the template's bytes and the parameters, not the change set's name", async () => {
    const a = await planOne({ changes: [] });
    const b = await planOne({ changes: [] });
    expect(b.planned.planDigest).toBe(a.planned.planDigest);
    writeFileSync(template, JSON.stringify({ Resources: { Topic: { Type: "AWS::SNS::Topic", Properties: { DisplayName: "x" } } } }));
    const c = await planOne({ changes: [] });
    expect(c.planned.planDigest).not.toBe(a.planned.planDigest);
  });

  it("reads a stack's outputs as they stand, and none for a stack that does not exist", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { outputs: { TopicArn: "arn:t" } }, gone: { missing: true } } });
    const capability = createCfnDeployCapability(mock.executor);
    expect(await capability.outputs!(ctx, { stack: "network", template })).toEqual({ TopicArn: "arn:t" });
    expect(await capability.outputs!(ctx, { stack: "gone", template })).toEqual({});
  });
});

describe("pr-plan over cfn-deploy members (#4084)", () => {
  const components = (): DriverComponent[] => [
    { name: "network", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "network", template }] }] },
    {
      name: "cluster-a",
      dependsOn: ["network"],
      deploy: [
        {
          phase: "Apply",
          steps: [{ kind: "cfn-deploy", stack: "cluster-a", template, inputs: { TopicArn: { stackOutput: { stack: "network", name: "TopicArn" } } } }],
        },
      ],
    },
  ];

  async function planBoth(stacks: Record<string, FakeStackConfig>) {
    const mock = createMockCloudExecutor({ stacks });
    const registry = new CapabilityRegistry();
    registry.register(createCfnDeployCapability(mock.executor));
    const all = components();
    const plan = planFanOut({ components: all, changed: ["network"] });
    const set = await planPrSet({ components: all, plan, registry, env: "local" });
    const report = prReport({
      stage: "plan",
      pr: 7,
      env: "local",
      base: "1".repeat(40),
      head: "2".repeat(40),
      op: "pr-7",
      gate: "pr-apply",
      plan,
      signal: { changed: ["network"], unclaimed: [] } as never,
      set,
      approval: { status: "pending" },
      status: "planned",
    });
    return { mock, set, report };
  }

  it("counts each member's changes from its change set, and the note and status line show them", async () => {
    const { set, report } = await planBoth({
      network: { outputs: { TopicArn: "arn:topic" }, noChanges: true },
      "cluster-a": { changes: [{ action: "Add", logicalResourceId: "clusterAQueue", resourceType: "AWS::SQS::Queue", replacement: false }] },
    });
    expect(set.members.map((m) => [m.member, m.counts])).toEqual([
      ["cluster-a", { create: 1, update: 0, replace: 0, delete: 0 }],
      ["network", { create: 0, update: 0, replace: 0, delete: 0 }],
    ]);
    // network changes nothing, so its plan knows its outputs: the ones it has (#3999).
    expect(set.plannedOutputs).toEqual({ network: ["TopicArn"] });
    const note = renderPrNote(report);
    expect(note).toContain("| `network` | network | planned | 0 | 0 | 0 | 0 |");
    expect(note).toContain("| `cluster-a` | cluster-a | planned | 1 | 0 | 0 | 0 |");
    expect(prStatusDescription(report)).toMatch(/^2 members: 1 to change, 0 to destroy or replace;/);
  });

  it("a stack whose upstream changes in the same pull request reads its outputs as known only after apply (#3999)", async () => {
    const { set, report, mock } = await planBoth({
      network: {
        outputs: { TopicArn: "arn:topic" },
        changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, details: ["DisplayName"] }],
      },
      "cluster-a": { changes: [{ action: "Add", logicalResourceId: "clusterAQueue", resourceType: "AWS::SQS::Queue", replacement: false }] },
    });
    // network's template has no Outputs to say TopicArn stays, so it is not the TopicArn standing now.
    expect(mock.calls.filter((c) => c.method === "describeStack")).toEqual([]);
    expect(set.plannedOutputs).toEqual({ network: [] });
    expect(set.members.find((m) => m.member === "cluster-a")?.unknownInputs).toEqual(["network.TopicArn"]);
    const note = renderPrNote(report);
    // The member is previewed against a stand-in, so it counts its changes (#4419).
    expect(note).toContain("| `cluster-a` | cluster-a | planned | 1 | 0 | 0 | 0 |");
    expect(note).toContain("Known only after apply: `cluster-a` reads `network.TopicArn`.");
  });

  it("a stack whose upstream changes a resource in place reads the output that resource keeps, at its value now (#3999)", async () => {
    writeFileSync(template, JSON.stringify({ Resources: { Topic: { Type: "AWS::SNS::Topic" } }, Outputs: { TopicArn: { Value: { Ref: "Topic" } } } }));
    const { set, mock } = await planBoth({
      network: {
        outputs: { TopicArn: "arn:topic" },
        changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, details: ["DisplayName"] }],
      },
      "cluster-a": { outputs: {}, changes: [{ action: "Add", logicalResourceId: "clusterAQueue", resourceType: "AWS::SQS::Queue", replacement: false }] },
    });
    expect(set.plannedOutputs).toEqual({ network: ["TopicArn"] });
    expect(set.members.find((m) => m.member === "cluster-a")?.unknownInputs).toBeUndefined();
    const created = mock.calls.filter((c) => c.method === "createChangeSet").map((c) => c.args as { stackName: string; parameters?: Record<string, string> });
    expect(created.find((c) => c.stackName === "cluster-a")?.parameters).toEqual({ TopicArn: "arn:topic" });
  });

  it("a member whose inputs come from a stack the run creates first is previewed against a stand-in, and the stand-in is deleted (#4419)", async () => {
    const { mock, set, report } = await planBoth({
      network: { missing: true, changes: [{ action: "Add", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false }] },
      "cluster-a": { missing: true, changes: [{ action: "Add", logicalResourceId: "clusterAQueue", resourceType: "AWS::SQS::Queue", replacement: false }] },
    });
    const clusterA = set.doc.members.find((m) => m.member === "cluster-a")!;
    expect(clusterA).toMatchObject({ status: "planned", holes: [] });
    expect(set.doc.entries.filter((e) => e.member === "cluster-a")).toHaveLength(1);
    const created = mock.calls.filter((c) => c.method === "createChangeSet").map((c) => c.args as { stackName: string; parameters?: Record<string, string> });
    expect(created.find((c) => c.stackName === "cluster-a")?.parameters).toEqual({ TopicArn: "known-after-apply" });
    const deleted = mock.calls.filter((c) => c.method === "deleteChangeSet").map((c) => (c.args as { stackName: string }).stackName);
    expect(deleted.sort()).toEqual(["cluster-a", "network"]);
    const note = renderPrNote(report);
    expect(note).toContain("| `cluster-a` | cluster-a | planned | 1 | 0 | 0 | 0 |");
    expect(note).toContain("| `network` | network | planned | 1 | 0 | 0 | 0 |");
  });

  it("a member whose upstream is unresolved but names no unknown input stays a hole", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: {} } });
    const planned = await createCfnDeployCapability(mock.executor).plan!({ ...ctx, unresolvedInputs: ["up"] }, { stack: "network", template });
    expect(planned.changeSet?.member.holes).toMatchObject([{ reason: "inputs from up; re-checked on apply" }]);
    expect(mock.calls.filter((c) => c.method === "createChangeSet")).toEqual([]);
  });

  it("planning the same state twice gives the same digest, so the apply's plan matches the approved one", async () => {
    const stacks = (): Record<string, FakeStackConfig> => ({
      network: { outputs: { TopicArn: "arn:topic" }, changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false }] },
      "cluster-a": { noChanges: true },
    });
    const first = await planBoth(stacks());
    const again = await planBoth(stacks());
    expect(again.set.doc.digest).toBe(first.set.doc.digest);
    const replaced = await planBoth({
      ...stacks(),
      network: { outputs: { TopicArn: "arn:topic" }, changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: true }] },
    });
    expect(replaced.set.doc.digest).not.toBe(first.set.doc.digest);
  });
});

describe("cfn-deploy applies the change set it planned (#3997)", () => {
  const topicUpdate = { action: "Modify" as const, logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, replacementMode: "False" as const, details: ["DisplayName"] };
  const queueAdd = { action: "Add" as const, logicalResourceId: "Queue", resourceType: "AWS::SQS::Queue", replacement: false };

  it("a plan hands run an artifact over its changes, and run executes a change set with the same changes", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { changes: [topicUpdate] } } });
    const capability = createCfnDeployCapability(mock.executor);
    const planned = await capability.plan!(ctx, { stack: "network", template });
    expect(planned.artifact).toMatchObject({ kind: "cfn-deploy-plan", stack: "network" });
    const out = await capability.run({ ...ctx, plans: { network: planned.artifact } }, { stack: "network", template });
    expect(out.stackStatus).toBe("UPDATE_COMPLETE");
    expect(methods(mock)).toEqual(["createChangeSet", "deleteChangeSet", "createChangeSet", "executeChangeSet", "waitForStack"]);
  });

  it("run refuses, deletes its change set unexecuted and marks the error as a moved plan when the changes differ from the plan's", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { changes: [topicUpdate] } } });
    const capability = createCfnDeployCapability(mock.executor);
    const planned = await capability.plan!(ctx, { stack: "network", template });
    mock.setStack("network", { changes: [topicUpdate, queueAdd] });
    const err = await capability.run({ ...ctx, plans: { network: planned.artifact } }, { stack: "network", template }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CfnPlanMovedError);
    expect(isPlanMovedError(err)).toBe(true);
    expect((err as Error).message).toMatch(/refusing to apply.*Plan it again/);
    expect(methods(mock).slice(2)).toEqual(["createChangeSet", "deleteChangeSet"]);
  });

  it("a plan of no changes refuses a run whose change set now has some, and accepts one that still has none", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { noChanges: true } } });
    const capability = createCfnDeployCapability(mock.executor);
    const planned = await capability.plan!(ctx, { stack: "network", template });
    await expect(capability.run({ ...ctx, plans: { network: planned.artifact } }, { stack: "network", template })).resolves.toMatchObject({ stackStatus: "UPDATE_COMPLETE" });
    mock.setStack("network", { noChanges: false, changes: [queueAdd] });
    await expect(capability.run({ ...ctx, plans: { network: planned.artifact } }, { stack: "network", template })).rejects.toBeInstanceOf(CfnPlanMovedError);
    expect(methods(mock)).not.toContain("executeChangeSet");
  });

  it("a run whose CREATE change set moved deletes the empty stack it made, too", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { missing: true, changes: [queueAdd] } } });
    const capability = createCfnDeployCapability(mock.executor);
    const planned = await capability.plan!(ctx, { stack: "network", template });
    mock.setStack("network", { changes: [queueAdd, { ...queueAdd, logicalResourceId: "Dlq" }] });
    await expect(capability.run({ ...ctx, plans: { network: planned.artifact } }, { stack: "network", template })).rejects.toBeInstanceOf(CfnPlanMovedError);
    expect(methods(mock).slice(3)).toEqual(["createChangeSet", "deleteChangeSet", "deleteStackShell"]);
  });

  it("a member with a hole it could not preview hands run no artifact, so run plans it afresh", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { changes: [queueAdd] } } });
    const capability = createCfnDeployCapability(mock.executor);
    const planned = await capability.plan!({ ...ctx, unresolvedInputs: ["upstream"] }, { stack: "network", template });
    expect(planned.artifact).toBeUndefined();
  });

  it('onReplace "block" refuses at plan time, naming the resources, and the change set is still deleted', async () => {
    const mock = createMockCloudExecutor({
      stacks: { network: { changes: [{ action: "Modify", logicalResourceId: "Table", resourceType: "AWS::DynamoDB::Table", replacement: true, replacementMode: "True" }] } },
    });
    const capability = createCfnDeployCapability(mock.executor);
    const err = await capability.plan!(ctx, { stack: "network", template }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CfnReplacementBlockedError);
    expect((err as Error).message).toContain("(Table)");
    expect(methods(mock)).toEqual(["createChangeSet", "deleteChangeSet"]);
  });

  it('onReplace "block" lets a Conditional replacement plan, as run does', async () => {
    const { counts } = await planOne({
      changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, replacementMode: "Conditional" }],
    });
    expect(counts.replace).toBe(1);
  });

  it("pr-apply over a moved stack fails the member with the refusal, executes nothing, and the run reads as a moved plan", async () => {
    const mock = createMockCloudExecutor({ stacks: { network: { changes: [topicUpdate] } } });
    const registry = new CapabilityRegistry();
    registry.register(createCfnDeployCapability(mock.executor));
    const components: DriverComponent[] = [
      { name: "network", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: "network", template }] }] },
    ];
    const plan = planFanOut({ components, changed: ["network"] });
    const set = await planPrSet({ components, plan, registry, env: "local" });
    expect(set.plans.network?.network).toMatchObject({ kind: "cfn-deploy-plan" });

    mock.setStack("network", { changes: [queueAdd] });
    const moved = await applyPrSet({ components, plan, registry, env: "local", set });
    expect(moved.status).toBe("failed");
    expect(planMovedIn(moved.run.results)).toBe(true);
    expect(moved.members[0]).toMatchObject({ member: "network", status: "failed" });
    expect(methods(mock)).not.toContain("executeChangeSet");

    mock.setStack("network", { changes: [topicUpdate] });
    const applied = await applyPrSet({ components, plan, registry, env: "local", set });
    expect(applied.status).toBe("applied");
    expect(planMovedIn(applied.run.results)).toBe(false);
    expect(methods(mock)).toContain("executeChangeSet");
  });
});

describe("cfn-deploy plans nested stacks (#3997)", () => {
  it("reads a nested change set's changes under the nested stack's logical id", async () => {
    const root: DescribedCfnChangeSet = {
      Status: "CREATE_COMPLETE",
      Changes: [
        { ResourceChange: { Action: "Modify", LogicalResourceId: "Child", ResourceType: "AWS::CloudFormation::Stack", Replacement: "False", ChangeSetId: "arn:child" } },
        { ResourceChange: { Action: "Add", LogicalResourceId: "Queue", ResourceType: "AWS::SQS::Queue" } },
      ],
    };
    const nested: Record<string, DescribedCfnChangeSet> = {
      "arn:child": {
        Status: "CREATE_COMPLETE",
        Changes: [
          { ResourceChange: { Action: "Modify", LogicalResourceId: "Grand", ResourceType: "AWS::CloudFormation::Stack", Replacement: "False", ChangeSetId: "arn:grand" } },
          { ResourceChange: { Action: "Modify", LogicalResourceId: "Topic", ResourceType: "AWS::SNS::Topic", Replacement: "True", Details: [{ Target: { Name: "TopicName" } }] } },
        ],
      },
      "arn:grand": { Status: "CREATE_COMPLETE", Changes: [{ ResourceChange: { Action: "Remove", LogicalResourceId: "Old", ResourceType: "AWS::SQS::Queue" } }] },
    };
    const described: string[] = [];
    const changes = await readCfnChanges(root, async (id) => {
      described.push(id);
      return nested[id]!;
    });
    expect(described).toEqual(["arn:child", "arn:grand"]);
    expect(changes.map((c) => [c.logicalResourceId, c.nestedStack ?? []])).toEqual([
      ["Child", []],
      ["Grand", ["Child"]],
      ["Old", ["Child", "Grand"]],
      ["Topic", ["Child"]],
      ["Queue", []],
    ]);
    const entries = changes.map((c) => cfnChangeEntry("app", c));
    expect(entries.find((e) => e.name === "Topic")).toMatchObject({ address: "Child/Topic", module: "Child", action: "replace" });
    expect(entries.find((e) => e.name === "Old")).toMatchObject({ address: "Child/Grand/Old", module: "Child/Grand", action: "delete" });
    expect(entries.find((e) => e.name === "Queue")).toMatchObject({ address: "Queue", action: "create" });
    expect(entries.find((e) => e.name === "Queue")).not.toHaveProperty("module");
  });

  it("asks for nested change sets only for a template that declares a nested stack", () => {
    expect(templateHasNestedStacks(JSON.stringify({ Resources: { Child: { Type: "AWS::CloudFormation::Stack" } } }))).toBe(true);
    expect(templateHasNestedStacks(JSON.stringify({ Resources: { Topic: { Type: "AWS::SNS::Topic" } } }))).toBe(false);
    expect(templateHasNestedStacks("not json")).toBe(false);
  });
});

describe("cfn-deploy targets (#4300)", () => {
  it("refuses targets by name: a change set covers the whole stack", async () => {
    const { targetRefusal } = await import("@intentius/chant/components/capability");
    expect(targetRefusal(createCfnDeployCapability(createMockCloudExecutor().executor))).toMatch(/cfn-deploy can't narrow/);
  });
});

describe("cfn-deploy previews a member whose inputs are unknown, and checks the real change against it (#4419)", () => {
  const eni = { action: "Modify" as const, logicalResourceId: "Eni", resourceType: "AWS::EC2::NetworkInterface", replacement: false, replacementMode: "False" as const };
  const withDriver = (property: string, causingEntity = "SubnetId") => ({
    ...eni,
    details: [property, "Description"],
    drivers: [{ property, changeSource: "ParameterReference", causingEntity }, { property: "Description", changeSource: "DirectModification" }],
  });
  const input = (): CfnDeployInput => ({ stack: "net", template, inputs: { SubnetId: undefined as never } });

  beforeEach(() => {
    writeFileSync(
      template,
      JSON.stringify({
        Parameters: { SubnetId: { Type: "AWS::EC2::Subnet::Id" }, Desc: { Type: "String", Default: "x" } },
        Resources: {
          Eni: { Type: "AWS::EC2::NetworkInterface", Properties: { SubnetId: { Ref: "SubnetId" }, Description: "d" } },
          Q: { Type: "AWS::SQS::Queue", Properties: { QueueName: { "Fn::Sub": "q-${SubnetId}" } } },
        },
      }),
    );
  });

  const q = { action: "Add" as const, logicalResourceId: "Q", resourceType: "AWS::SQS::Queue", replacement: false };

  it("creates the change set with an id-shaped stand-in, marks the driven properties unknown, and deletes the change set", async () => {
    const mock = createMockCloudExecutor({ stacks: { net: { changes: [withDriver("SubnetId"), q] } } });
    const planned = await createCfnDeployCapability(mock.executor).plan!({ ...ctx, unresolvedInputs: ["vpc"] }, input());
    const created = mock.calls.find((c) => c.method === "createChangeSet")!.args as { parameters: Record<string, string> };
    expect(created.parameters).toEqual({ SubnetId: "subnet-00000000known-after-apply" });
    const entries = planned.changeSet!.entries;
    expect(entries.find((e) => e.address === "Eni")?.attributes).toEqual([
      { path: "Description" },
      { path: "SubnetId", unknown: true },
    ]);
    // A create names no properties; the template says which one reads the parameter.
    expect(entries.find((e) => e.address === "Q")?.attributes).toEqual([{ path: "QueueName", unknown: true }]);
    expect(planned.changeSet!.member.holes).toEqual([]);
    expect(methods(mock)).toEqual(["createChangeSet", "deleteChangeSet"]);
    expect(planned.artifact).toMatchObject({ kind: "cfn-deploy-shape" });
    // The preview reports its shape to core, unknown where a placeholder drives it (#4419).
    expect(planned.shape).toMatchObject({ member: "net", unknownInputs: ["vpc"] });
    expect(planned.shape!.entries.find((e) => e.logicalId === "Eni")).toMatchObject({ action: "update", replacement: "false", properties: ["Description", "SubnetId"], unknown: ["SubnetId"] });
    expect(planned.shape!.entries.find((e) => e.logicalId === "Q")).toMatchObject({ action: "create", unknown: ["QueueName"] });
  });

  it("a conditional replacement in the real change set is read as conditional", async () => {
    const mock = createMockCloudExecutor({ stacks: { net: { changes: [{ ...eni, replacementMode: "Conditional" as never }] } } });
    const planned = await createCfnDeployCapability(mock.executor).plan!(ctx, { stack: "net", template, inputs: { SubnetId: "subnet-1" } });
    expect(planned.shape!.entries[0]).toMatchObject({ logicalId: "Eni", replacement: "conditional" });
  });

  it("falls back to a hole when CloudFormation refuses the stand-in", async () => {
    const mock = createMockCloudExecutor({ stacks: { net: { changes: [] } } });
    const real = mock.executor.cloudformation.createChangeSet;
    mock.executor.cloudformation.createChangeSet = async () => {
      throw new Error("Parameter validation failed: parameter value subnet-00000000known-after-apply for parameter name SubnetId does not exist");
    };
    void real;
    const planned = await createCfnDeployCapability(mock.executor).plan!(ctx, input());
    expect(planned.artifact).toBeUndefined();
    expect(planned.changeSet!.member.holes[0].reason).toMatch(/no preview: CloudFormation refused .*does not exist/);
  });

  async function previewThenRun(previewed: ReturnType<typeof withDriver>[], real: Array<typeof eni | typeof q | ReturnType<typeof withDriver>>) {
    const mock = createMockCloudExecutor({ stacks: { net: { changes: previewed } } });
    const capability = createCfnDeployCapability(mock.executor);
    const planned = await capability.plan!(ctx, input());
    mock.setStack("net", { changes: real });
    const result = await capability.run({ ...ctx, plans: { net: planned.artifact } }, { stack: "net", template, inputs: { SubnetId: "subnet-1" } }).catch((e: unknown) => e);
    return { mock, result };
  }

  it("executes when the real change matches the preview", async () => {
    const { mock, result } = await previewThenRun([withDriver("SubnetId")], [withDriver("SubnetId")]);
    expect(result).toMatchObject({ stackStatus: expect.any(String) });
    expect(methods(mock)).toContain("executeChangeSet");
  });

  it("executes when an unknown-driven property drops out because the real value equals the current one", async () => {
    const { mock, result } = await previewThenRun([withDriver("SubnetId")], [{ ...eni, details: ["Description"] }]);
    expect(result).toMatchObject({ stackStatus: expect.any(String) });
    expect(methods(mock)).toContain("executeChangeSet");
  });

  it("refuses, executing nothing, when the real change adds a resource", async () => {
    const { mock, result } = await previewThenRun([withDriver("SubnetId")], [withDriver("SubnetId"), q]);
    expect(result).toBeInstanceOf(PlanShapeMovedError);
    expect((result as Error).message).toContain("net now plans to create Q, which the first plan did not");
    expect((result as { planMoved?: boolean }).planMoved).toBe(true);
    expect(methods(mock)).not.toContain("executeChangeSet");
    expect(methods(mock).at(-1)).toBe("deleteChangeSet");
  });

  it("refuses when a property no unknown input drives stops changing", async () => {
    const { mock, result } = await previewThenRun([withDriver("SubnetId")], [{ ...eni, details: ["SubnetId"] }]);
    expect(result).toBeInstanceOf(PlanShapeMovedError);
    expect((result as Error).message).toContain("no longer changes Description on Eni");
    expect(methods(mock)).not.toContain("executeChangeSet");
  });

  it("refuses when the real change replaces and the preview did not", async () => {
    const { result } = await previewThenRun([withDriver("SubnetId")], [{ ...withDriver("SubnetId"), replacementMode: "Conditional" as never }]);
    expect(result).toBeInstanceOf(PlanShapeMovedError);
    expect((result as Error).message).toContain("may now replace Eni, which the first plan did not show");
  });
});
