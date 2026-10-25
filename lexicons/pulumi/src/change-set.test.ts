/**
 * The Pulumi change-set adapter (#4453): `pulumi preview --json` into a
 * change-set part, planner `pulumi`.
 *
 * `testdata/pulumi-preview/preview.json` and `stack-export.json` are
 * hand-written to the documented `pulumi preview --json` and `pulumi stack
 * export` shapes, not recorded from a real run. The program: a bucket being
 * created, a policy and a function whose inputs read its outputs (unknown at
 * preview), a component `my:web:Site` creating a child, so its `apply()`
 * children may be missing, a record the last deployment holds under the
 * component and the preview never lists, a delete under the component, a
 * secret update, a delete-before-replace and a top-level delete. Nothing
 * here runs Pulumi.
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
const prior = read("stack-export.json");
const urn = (type: string, name: string) => `urn:pulumi:dev::site::${type}::${name}`;
const SITE = urn("my:web:Site", "site");

const part = () => pulumiPreviewPart({ member: "site", preview, prior, stack: "dev" });
const entry = (address: string) => part().entries.find((e) => e.address === address && e.mayAppear === undefined) ?? part().entries.find((e) => e.address === address)!;

const { expectValid } = contract(schema);

describe("pulumi preview --json to a change-set part (#4453)", () => {
  test("the member: planner pulumi, planned, the preview's digest, no holes", () => {
    const { member } = part();
    expect(member).toEqual({
      member: "site",
      lexicon: "pulumi",
      planner: "pulumi",
      scope: "dev",
      status: "planned",
      planDigest: pulumiPreviewDigest(preview),
      holes: [],
    });
    expect(member.planDigest).toMatch(/^jcs1-sha256:/);
  });

  test("a resource that reads an output of one being created shows the dependent input as unknown", () => {
    const writer = entry(urn("aws:iam/policy:Policy", "logs-writer"));
    expect(writer.action).toBe("create");
    expect(writer.attributes).toEqual([
      { path: "name", after: "logs-writer" },
      { path: "policy", unknown: true },
    ]);
    // An update of an existing function whose new input is unknown keeps the value before and drops the after.
    const handler = entry(urn("aws:lambda/function:Function", "handler"));
    expect(handler).toMatchObject({ action: "update", disruption: "in-place", id: "handler-9a1" });
    expect(handler.attributes).toEqual([
      { path: "environment", before: { variables: { LOG_BUCKET_ARN: "arn:aws:s3:::site-logs-old" } }, unknown: true },
    ]);
  });

  test("a create writes every input but Pulumi's __defaults", () => {
    expect(entry(urn("aws:s3/bucket:Bucket", "logs")).attributes).toEqual([
      { path: "acl", after: "private" },
      { path: "bucket", after: "site-logs" },
      { path: "forceDestroy", after: false },
      { path: "tags", after: { env: "dev" } },
    ]);
  });

  test("a secret is sensitive with neither value", () => {
    expect(entry(urn("aws:ssm/parameter:Parameter", "db-password")).attributes).toEqual([{ path: "value", sensitive: true }]);
    expect(JSON.stringify(part())).not.toContain("[secret]");
  });

  test("three steps of a delete-before-replace are one replace entry, destroy, forced by ami", () => {
    const worker = part().entries.filter((e) => e.address === urn("aws:ec2/instance:Instance", "worker"));
    expect(worker).toHaveLength(1);
    expect(worker[0]).toMatchObject({ action: "replace", disruption: "destroy", id: "i-0abc" });
    expect(worker[0].attributes).toEqual([{ path: "ami", before: "ami-111", after: "ami-222", forcesReplacement: true }]);
  });

  test("same steps are no-ops, the stack and providers included; a top-level delete is a plain delete", () => {
    expect(entry(urn("pulumi:pulumi:Stack", "site-dev")).action).toBe("no-op");
    expect(entry(urn("pulumi:providers:aws", "default_6_50_0")).action).toBe("no-op");
    expect(entry(SITE).action).toBe("no-op");
    const old = entry(urn("aws:iam/role:Role", "old-deployer"));
    expect(old).toMatchObject({ action: "delete", disruption: "destroy" });
    expect(old.mayAppear).toBeUndefined();
  });

  test("what preview cannot list may appear, never omitted", () => {
    const mayAppear = part().entries.filter((e) => e.mayAppear === true);
    expect(mayAppear.map((e) => [e.address, e.action, e.disruption ?? null]).sort()).toEqual(
      [
        // The component creates a child, so an apply() inside it may be waiting: its children may appear.
        [pulumiMayAppearAddress(SITE), "create", null],
        // The last deployment holds a record under it that the preview never lists.
        [urn("my:web:Site$aws:route53/record:Record", "site-alias"), "update", "unknown"],
        // A delete under it may be the apply() not having run.
        [urn("my:web:Site$aws:s3/bucketObject:BucketObject", "index"), "delete", "destroy"],
      ].sort(),
    );
    expect(pulumiMayAppearAddress(SITE)).toBe("urn:pulumi:dev::site::my:web:Site$*::site/*");
  });

  test("a targeted preview lists only its targets, so the export's other resources are not marked", () => {
    const targeted = pulumiPreviewPart({ member: "site", preview, prior, targeted: true });
    expect(targeted.entries.some((e) => e.address === urn("my:web:Site$aws:route53/record:Record", "site-alias"))).toBe(false);
  });

  test("a may-appear entry keeps the set from reading empty", () => {
    const sameOnly = { steps: [{ op: "same", urn: SITE, newState: { urn: SITE, custom: false, type: "my:web:Site" } }] };
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

  test("the digest ignores step order, duration and diagnostics, and moves with an input", () => {
    const doc = preview as { steps: unknown[]; duration: number };
    const shuffled = { ...doc, steps: [...doc.steps].reverse(), duration: 1, diagnostics: [{ severity: "info", message: "hi" }] };
    expect(pulumiPreviewDigest(shuffled)).toBe(pulumiPreviewDigest(preview));
    const moved = JSON.parse(JSON.stringify(preview)) as { steps: { urn: string; newState?: { inputs?: Record<string, unknown> } }[] };
    moved.steps.find((s) => s.urn === urn("aws:s3/bucket:Bucket", "logs"))!.newState!.inputs!.acl = "public-read";
    expect(pulumiPreviewDigest(moved)).not.toBe(pulumiPreviewDigest(preview));
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
    const moved = JSON.parse(JSON.stringify(preview)) as { steps: { urn: string; newState?: { inputs?: Record<string, unknown> } }[] };
    moved.steps.find((s) => s.urn === urn("aws:s3/bucket:Bucket", "logs"))!.newState!.inputs!.acl = "public-read";
    const other = composeChangeSet([lifecycle, pulumiPreviewPart({ member: "site", preview: moved, prior, stack: "dev" })]);
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
    const mapped = mapChangeSetToGraph(composeChangeSet([part()]), { member: null, at: null, ids });
    const nodeOf = (address: string, mayAppear?: boolean) =>
      mapped.entries.find((e) => e.address === address && (mayAppear === undefined || (e.mayAppear === true) === mayAppear))!.node;
    expect(nodeOf(urn("aws:lambda/function:Function", "handler"))).toBe("site/aws:lambda/function:Function::handler");
    expect(nodeOf(pulumiMayAppearAddress(SITE))).toBe("site/my:web:Site::site");
    expect(nodeOf(urn("my:web:Site$aws:route53/record:Record", "site-alias"))).toBe("site/my:web:Site$aws:route53/record:Record::site-alias");
    // A create the export does not hold yet, and the stack and providers, are on no node.
    expect(nodeOf(urn("aws:s3/bucket:Bucket", "logs"))).toBeNull();
    expect(nodeOf(urn("pulumi:pulumi:Stack", "site-dev"))).toBeNull();
    expect(nodeOf(urn("pulumi:providers:aws", "default_6_50_0"))).toBeNull();
    expect(verifyChangeSetDigest(mapped)).toBe(true);
  });
});

describe("stack outputs, the seam for engine outputs into chant parameters (#4455)", () => {
  test("planned outputs mark unknowns and secrets", () => {
    expect(pulumiPlannedStackOutputs(preview)).toEqual([
      { name: "bucketName", value: "site-logs" },
      { name: "dbPassword", secret: true },
      { name: "siteUrl", unknown: true },
    ]);
  });

  test("exported outputs are what the last apply produced", () => {
    expect(pulumiExportedStackOutputs(prior)).toEqual([
      { name: "bucketName", value: "site-logs-old" },
      { name: "dbPassword", secret: true },
      { name: "siteUrl", value: "https://d111.cloudfront.net" },
    ]);
  });
});
