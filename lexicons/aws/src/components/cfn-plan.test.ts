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
import { planPrSet, prReport } from "@intentius/chant/components/pr-run";
import { composeChangeSet } from "@intentius/chant/change-set";
import { groupChangeSet, planSummaryHeadline } from "@intentius/chant/plan-summary";
import { memberCounts, prStatusDescription, renderPrNote } from "@intentius/chant/pr-loop";
import { createCfnDeployCapability } from "./apply";
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

async function planOne(config: FakeStackConfig) {
  const mock = createMockCloudExecutor({ stacks: { network: config } });
  const capability = createCfnDeployCapability(mock.executor);
  const planned = await capability.plan!(ctx, { stack: "network", template });
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
    });
    expect(counts).toEqual({ create: 0, update: 0, replace: 2, delete: 1 });
    expect(planSummaryHeadline(groupChangeSet(doc))).toContain("3 destroys or replacements");
  });

  it("a change set with nothing to apply is a member with no entries and no holes", async () => {
    const { counts, doc, mock } = await planOne({ noChanges: true });
    expect(counts).toEqual({ create: 0, update: 0, replace: 0, delete: 0 });
    expect(doc.members[0]).toMatchObject({ status: "planned", holes: [] });
    expect(groupChangeSet(doc, { unit: "member" }).groups[0].noChanges).toBe(true);
    expect(methods(mock)).toEqual(["createChangeSet", "deleteChangeSet"]);
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
      network: {
        outputs: { TopicArn: "arn:topic" },
        changes: [{ action: "Modify", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false, details: ["DisplayName"] }],
      },
      "cluster-a": { changes: [{ action: "Add", logicalResourceId: "clusterAQueue", resourceType: "AWS::SQS::Queue", replacement: false }] },
    });
    expect(set.members.map((m) => [m.member, m.counts])).toEqual([
      ["cluster-a", { create: 1, update: 0, replace: 0, delete: 0 }],
      ["network", { create: 0, update: 1, replace: 0, delete: 0 }],
    ]);
    const note = renderPrNote(report);
    expect(note).toContain("| `network` | network | planned | 0 | 1 | 0 | 0 |");
    expect(note).toContain("| `cluster-a` | cluster-a | planned | 1 | 0 | 0 | 0 |");
    expect(note).not.toContain("no changes");
    expect(prStatusDescription(report)).toMatch(/^2 members: 2 to change, 0 to destroy or replace;/);
  });

  it("a member whose inputs come from a stack the run creates first says so, with no counts and no change set", async () => {
    const { mock, set, report } = await planBoth({
      network: { missing: true, changes: [{ action: "Add", logicalResourceId: "Topic", resourceType: "AWS::SNS::Topic", replacement: false }] },
      "cluster-a": { missing: true },
    });
    const clusterA = set.doc.members.find((m) => m.member === "cluster-a")!;
    expect(clusterA).toMatchObject({ status: "planned", holes: [{ address: "cluster-a", reason: "inputs from network; re-checked on apply" }] });
    expect(set.doc.entries.filter((e) => e.member === "cluster-a")).toEqual([]);
    expect(mock.calls.filter((c) => c.method === "createChangeSet").map((c) => (c.args as { stackName: string }).stackName)).toEqual(["network"]);
    const note = renderPrNote(report);
    expect(note).toContain("| `cluster-a` | cluster-a | planned; inputs from network; re-checked on apply | ? | ? | ? | ? |");
    expect(note).toContain("| `network` | network | planned | 1 | 0 | 0 | 0 |");
    expect(prStatusDescription(report)).toContain("1 with holes");
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
