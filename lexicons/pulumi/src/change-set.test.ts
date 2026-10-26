/**
 * The Pulumi change-set adapter (#4453): `pulumi preview --json` into a
 * change-set part, planner `pulumi`.
 *
 * `testdata/pulumi-preview` is recorded (#4475; see its README): pulumi
 * 3.272.0 against the plunge corpus's aws-ts program on floci. `stack-export.json`
 * is the settled stack; `preview.json` is `preview --json --show-sames` after
 * the stack config dropped a worker queue, raised the events queue's
 * retention, set a new secret and the program moved the VPC's CIDR (a
 * replace, and a replace of the security group that reads its id);
 * `preview-create.json` is the first preview of a fresh stack. Nothing here
 * runs Pulumi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet, isEmptyChangeSet, lifecyclePlanPart, readChangeSetPartFile, verifyChangeSetDigest } from "@intentius/chant/change-set";
import { mapChangeSetToGraph } from "@intentius/chant/change-set-graph";
import type { ChangeSet as LifecycleChangeSet } from "@intentius/chant/lifecycle/change-set";
import { pulumiMayAppearAddress } from "@intentius/chant/pulumi-urn";
import { contract, REPO } from "../../../packages/core/src/workspace/__fixtures__/contract-repo";
import schema from "../../../packages/core/src/workspace/change-set.schema.json";
import { pulumiPreviewDigest, pulumiPreviewPart } from "./change-set";
import { pulumiPlannedStackOutputs, pulumiExportedStackOutputs } from "./stack-outputs";
import { readPulumiMember } from "./workspace-member";

const dir = join(import.meta.dirname, "testdata", "pulumi-preview");
const read = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf-8"));
const preview = read("preview.json");
const created = read("preview-create.json");
const prior = read("stack-export.json");
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;
const DOCS = urn("corpus:index:Site", "docs");
const EVENTS = urn("aws:sqs/queue:Queue", "events");

const part = () => pulumiPreviewPart({ member: "site", preview, prior, stack: "floci" });
const createPart = () => pulumiPreviewPart({ member: "site", preview: created, stack: "floci" });
const entryIn = (p: ReturnType<typeof part>, address: string) => p.entries.find((e) => e.address === address && e.mayAppear === undefined) ?? p.entries.find((e) => e.address === address)!;
const entry = (address: string) => entryIn(part(), address);

const { expectValid } = contract(schema);

describe("pulumi preview --json to a change-set part (#4453)", () => {
  test("the member: planner pulumi, planned, the preview's digest, no holes", () => {
    const { member } = part();
    expect(member).toEqual({
      member: "site",
      lexicon: "pulumi",
      planner: "pulumi",
      scope: "floci",
      status: "planned",
      planDigest: pulumiPreviewDigest(preview),
      holes: [],
    });
    expect(member.planDigest).toMatch(/^jcs1-sha256:/);
  });

  test("a resource that reads an output of one being created or replaced shows the dependent input as unknown", () => {
    const policy = entryIn(createPart(), urn("aws:s3/bucketPolicy:BucketPolicy", "site-bucket-policy"));
    expect(policy.action).toBe("create");
    expect(policy.attributes).toEqual([
      { path: "bucket", unknown: true },
      { path: "policy", unknown: true },
      { path: "region", after: "us-east-1" },
    ]);
    // The security group reads the VPC being replaced: its vpcId keeps the value before and is unknown after.
    const sg = entry(urn("aws:ec2/securityGroup:SecurityGroup", "app-sg"));
    expect(sg).toMatchObject({ action: "replace", disruption: "replace", id: "sg-68951e51c2f001baa" });
    expect(sg.attributes).toEqual([{ path: "vpcId", before: "vpc-05097b38", unknown: true, forcesReplacement: true }]);
  });

  test("a create writes every input but Pulumi's __defaults", () => {
    expect(entryIn(createPart(), urn("aws:s3/bucket:Bucket", "site-bucket")).attributes).toEqual([
      { path: "bucket", after: "rec-ts-site" },
      { path: "region", after: "us-east-1" },
      { path: "tags", after: { "corpus-owner": "plunge", "corpus-program": "aws-ts" } },
      { path: "tagsAll", after: { "corpus-owner": "plunge", "corpus-program": "aws-ts" } },
    ]);
  });

  test("an in-place update names the changed input, before and after", () => {
    expect(entry(EVENTS)).toMatchObject({ action: "update", disruption: "in-place" });
    expect(entry(EVENTS).attributes).toEqual([{ path: "messageRetentionSeconds", before: 3600, after: 7200 }]);
  });

  test("a secret is sensitive with neither value; a computed output the diff names is known only after apply", () => {
    // The preview prints the secret as the blinded "[secret]".
    expect(entry(urn("aws:ssm/parameter:Parameter", "db-password")).attributes).toEqual([
      { path: "value", sensitive: true },
      { path: "version", before: 3, unknown: true },
    ]);
    expect(entryIn(createPart(), urn("aws:ssm/parameter:Parameter", "db-password")).attributes).toContainEqual({ path: "value", sensitive: true });
    expect(JSON.stringify(part())).not.toContain("[secret]");
    expect(JSON.stringify(createPart())).not.toContain("[secret]");
  });

  test("a replace is one step at preview, one replace entry, forced by the CIDR", () => {
    const vpc = part().entries.filter((e) => e.address === urn("aws:ec2/vpc:Vpc", "main"));
    expect(vpc).toHaveLength(1);
    expect(vpc[0]).toMatchObject({ action: "replace", disruption: "replace", id: "vpc-05097b38" });
    expect(vpc[0].attributes).toEqual([{ path: "cidrBlock", before: "10.42.0.0/16", after: "10.43.0.0/16", forcesReplacement: true }]);
  });

  test("same steps are no-ops, the stack, a component and an explicit provider included; a top-level delete is a plain delete", () => {
    expect(entry(urn("pulumi:pulumi:Stack", "corpus-aws-ts-floci")).action).toBe("no-op");
    expect(entry(urn("pulumi:providers:aws", "west")).action).toBe("no-op");
    expect(entry(DOCS).action).toBe("no-op");
    const worker = entry(urn("aws:sqs/queue:Queue", "worker-2"));
    expect(worker).toMatchObject({ action: "delete", disruption: "destroy" });
    expect(worker.mayAppear).toBeUndefined();
    // Registered inside vpc.id.apply(...) at the top level: with the VPC replaced the callback does not run, and the
    // preview prints a delete. Nothing tells it from a removed resource, so it stays a plain delete (adapter header).
    expect(entry(urn("aws:ssm/parameter:Parameter", "vpc-id"))).toMatchObject({ action: "delete", disruption: "destroy" });
  });

  test("what preview cannot list may appear, never omitted", () => {
    // A component creating children at a first preview: an apply() inside it may be waiting, so its children may appear.
    expect(createPart().entries.filter((e) => e.mayAppear === true).map((e) => [e.address, e.action])).toEqual([[pulumiMayAppearAddress(DOCS), "create"]]);
    expect(pulumiMayAppearAddress(DOCS)).toBe("urn:pulumi:floci::corpus-aws-ts::corpus:index:Site$*::docs/*");
    // With --show-sames every resource the export holds is listed, so the change preview marks nothing.
    expect(part().entries.filter((e) => e.mayAppear === true)).toEqual([]);
  });

  test("without --show-sames a preview lists no unchanged resource, so each one the export holds would read as may-appear", () => {
    const doc = preview as { steps: { op: string; urn: string }[] };
    const sameless = { ...doc, steps: doc.steps.filter((s) => s.op !== "same" || s.urn.includes("pulumi:pulumi:Stack")) };
    const marked = pulumiPreviewPart({ member: "site", preview: sameless, prior, stack: "floci" }).entries.filter((e) => e.mayAppear === true);
    expect(marked.map((e) => e.address)).toContain(urn("aws:iam/role:Role", "app-role"));
    expect(marked.every((e) => e.action === "update" && e.disruption === "unknown")).toBe(true);
  });

  test("a targeted preview lists only its targets, so the export's other resources are not marked", () => {
    const one = { steps: (preview as { steps: { urn: string }[] }).steps.filter((s) => s.urn === EVENTS) };
    const targeted = pulumiPreviewPart({ member: "site", preview: one, prior, targeted: true });
    expect(targeted.entries.map((e) => e.address)).toEqual([EVENTS]);
  });

  test("a may-appear entry keeps the set from reading empty", () => {
    const sameOnly = { steps: [{ op: "same", urn: DOCS, newState: { urn: DOCS, custom: false, type: "corpus:index:Site" } }] };
    expect(isEmptyChangeSet(composeChangeSet([pulumiPreviewPart({ member: "site", preview: sameOnly })]))).toBe(true);
    const withPrior = composeChangeSet([pulumiPreviewPart({ member: "site", preview: sameOnly, prior })]);
    expect(withPrior.entries.some((e) => e.mayAppear === true)).toBe(true);
    expect(isEmptyChangeSet(withPrior)).toBe(false);
  });

  test("an op the change set has no action for is a hole, not a guess", () => {
    const odd = pulumiPreviewPart({ member: "site", preview: { steps: [{ op: "frobnicate", urn: urn("aws:s3/bucket:Bucket", "x") }] } });
    expect(odd.entries).toEqual([]);
    expect(odd.member.holes).toEqual([{ address: urn("aws:s3/bucket:Bucket", "x"), type: "aws:s3/bucket:Bucket", reason: expect.stringMatching(/frobnicate/) }]);
  });

  test("a failed preview is a failed member with no digest; a document with no steps and no error is refused", () => {
    const failed = pulumiPreviewPart({ member: "site", preview: {}, error: "boom" });
    expect(failed.member).toMatchObject({ status: "failed", error: "boom", planDigest: null });
    expect(() => pulumiPreviewPart({ member: "site", preview: { nope: true } })).toThrow(/no top-level "steps"/);
  });

  const moveRetention = () => {
    const moved = JSON.parse(JSON.stringify(preview)) as { steps: { urn: string; newState?: { inputs?: Record<string, unknown> } }[] };
    moved.steps.find((s) => s.urn === EVENTS)!.newState!.inputs!.messageRetentionSeconds = 9000;
    return moved;
  };

  test("the digest ignores step order, duration and diagnostics, and moves with an input", () => {
    const doc = preview as { steps: unknown[]; duration: number };
    const shuffled = { ...doc, steps: [...doc.steps].reverse(), duration: 1, diagnostics: [{ severity: "info", message: "hi" }] };
    expect(pulumiPreviewDigest(shuffled)).toBe(pulumiPreviewDigest(preview));
    expect(pulumiPreviewDigest(moveRetention())).not.toBe(pulumiPreviewDigest(preview));
  });

  test("a Pulumi part joins a multi-engine change set under one document digest", () => {
    const lifecycle = lifecyclePlanPart({
      member: "dns",
      plan: JSON.parse(readFileSync(join(REPO, "packages", "core", "src", "__fixtures__", "change-set", "lifecycle-plan.floci.json"), "utf-8")) as LifecycleChangeSet,
    });
    const doc = composeChangeSet([lifecycle, part()]);
    expectValid(doc);
    expect(doc.members.map((m) => [m.member, m.planner])).toEqual([
      ["dns", "chant"],
      ["site", "pulumi"],
    ]);
    expect(verifyChangeSetDigest(doc)).toBe(true);
    expect(doc.summary.byMember.site).toBeDefined();
    // The Pulumi member's plan is in the one digest: changing an input moves the document's.
    const other = composeChangeSet([lifecycle, pulumiPreviewPart({ member: "site", preview: moveRetention(), prior, stack: "floci" })]);
    expect(other.members.find((m) => m.member === "site")!.planDigest).not.toBe(doc.members.find((m) => m.member === "site")!.planDigest);
    expect(other.digest).not.toBe(doc.digest);
    // Order of the parts makes no difference.
    expect(composeChangeSet([part(), lifecycle]).digest).toBe(doc.digest);
  });

  test("a part written to a file reads back as planner pulumi", () => {
    const back = readChangeSetPartFile(JSON.parse(JSON.stringify(part())), "pulumi", "site-renamed");
    expect(back.member.member).toBe("site-renamed");
    expect(back.entries.every((e) => e.member === "site-renamed" && e.planner === "pulumi")).toBe(true);
  });

  test("entries land on the member graph's nodes by the URN rule; a may-appear entry on its component", () => {
    const ids = [...readPulumiMember({ member: { dir, label: "site" } }).entities.keys()];
    const nodeIn = (p: ReturnType<typeof part>, address: string) => {
      const mapped = mapChangeSetToGraph(composeChangeSet([p]), { member: null, at: null, ids });
      expect(verifyChangeSetDigest(mapped)).toBe(true);
      return mapped.entries.find((e) => e.address === address)!.node;
    };
    expect(nodeIn(part(), EVENTS)).toBe("site/aws:sqs/queue:Queue::events");
    expect(nodeIn(part(), urn("corpus:index:Site$aws:s3/bucket:Bucket", "docs-assets"))).toBe("site/corpus:index:Site$aws:s3/bucket:Bucket::docs-assets");
    expect(nodeIn(createPart(), pulumiMayAppearAddress(DOCS))).toBe("site/corpus:index:Site::docs");
    // The stack and providers are on no node.
    expect(nodeIn(part(), urn("pulumi:pulumi:Stack", "corpus-aws-ts-floci"))).toBeNull();
    expect(nodeIn(part(), urn("pulumi:providers:aws", "west"))).toBeNull();
  });
});

describe("stack outputs, the seam for engine outputs into chant parameters (#4455)", () => {
  test("a real preview's stack step carries no outputs, so none are planned", () => {
    expect(pulumiPlannedStackOutputs(preview)).toBeUndefined();
    expect(pulumiPlannedStackOutputs(created)).toBeUndefined();
    // A step that does carry them is read, unknowns and secrets marked.
    const STACK = urn("pulumi:pulumi:Stack", "corpus-aws-ts-floci");
    const carrying = { steps: [{ op: "same", urn: STACK, newState: { urn: STACK, type: "pulumi:pulumi:Stack", outputs: { a: "x", b: "04da6b54-80e4-46f7-96ec-b56ff0331ba9", c: "[secret]" } } }] };
    expect(pulumiPlannedStackOutputs(carrying)).toEqual([
      { name: "a", value: "x" },
      { name: "b", unknown: true },
      { name: "c", secret: true },
    ]);
  });

  test("exported outputs are what the last apply produced", () => {
    const outputs = pulumiExportedStackOutputs(prior);
    expect(outputs).toContainEqual({ name: "vpcId", value: "vpc-05097b38" });
    expect(outputs).toContainEqual({ name: "siteBucketName", value: "rec-ts-site" });
    expect(outputs).toContainEqual({ name: "dbPasswordValue", secret: true });
    expect(outputs).toHaveLength(13);
  });
});
