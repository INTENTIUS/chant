/**
 * The plan shape of a Pulumi stack (#4541, item 4), over the recorded
 * preview of the plunge corpus on floci (`testdata/pulumi-preview`, #4475):
 * a replaced VPC and security group, two updates and two deletes. Nothing
 * here runs Pulumi.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { pulumiMayAppearAddress } from "@intentius/chant/pulumi-urn";
import { pulumiPreviewPart, type PulumiStep } from "./change-set";
import { pulumiPlanShape, pulumiShapeDifferences } from "./plan-shape";

const dir = join(import.meta.dirname, "testdata", "pulumi-preview");
const preview = JSON.parse(readFileSync(join(dir, "preview.json"), "utf-8")) as { steps: PulumiStep[] };
const urn = (type: string, name: string) => `urn:pulumi:floci::corpus-aws-ts::${type}::${name}`;
const member = "corpus-aws-ts/floci";
const partOf = (doc: unknown) => pulumiPreviewPart({ member, preview: doc, stack: "floci" });

describe("pulumiPlanShape", () => {
  const shape = pulumiPlanShape(partOf(preview), member);

  test("one entry per URN that changes; same and read steps are left out", () => {
    expect(shape.member).toBe(member);
    expect(shape.entries.map((e) => [e.logicalId, e.action])).toEqual(
      [
        [urn("aws:ec2/securityGroup:SecurityGroup", "app-sg"), "replace"],
        [urn("aws:ec2/vpc:Vpc", "main"), "replace"],
        [urn("aws:sqs/queue:Queue", "events"), "update"],
        [urn("aws:sqs/queue:Queue", "worker-2"), "delete"],
        [urn("aws:ssm/parameter:Parameter", "db-password"), "update"],
        [urn("aws:ssm/parameter:Parameter", "vpc-id"), "delete"],
      ].sort((a, b) => a[0].localeCompare(b[0])),
    );
  });

  test("a replace forced by a known input is true, an update is false, with type and the properties it writes", () => {
    const vpc = shape.entries.find((e) => e.logicalId === urn("aws:ec2/vpc:Vpc", "main"))!;
    expect(vpc).toMatchObject({ action: "replace", replacement: "true", type: "aws:ec2/vpc:Vpc" });
    expect(vpc.properties).toContain("cidrBlock");
    const queue = shape.entries.find((e) => e.logicalId === urn("aws:sqs/queue:Queue", "events"))!;
    expect(queue).toMatchObject({ action: "update", replacement: "false", properties: ["messageRetentionSeconds"], unknown: [] });
  });

  test("a replace forced only by an unknown input is conditional", () => {
    const sg = shape.entries.find((e) => e.logicalId === urn("aws:ec2/securityGroup:SecurityGroup", "app-sg"))!;
    // The security group reads the VPC's id, unknown while the VPC is replaced.
    expect(sg.replacement).toBe("conditional");
    expect(sg.unknown).toContain("vpcId");
  });

  test("inputs passed in are recorded", () => {
    expect(pulumiPlanShape(partOf(preview), member, { unknownInputs: ["network.vpcId"] }).unknownInputs).toEqual(["network.vpcId"]);
  });
});

describe("pulumiShapeDifferences", () => {
  const approved = pulumiPlanShape(partOf(preview), member);

  test("the same steps are within the approval", () => {
    expect(pulumiShapeDifferences(approved, pulumiPlanShape(partOf(preview), member), preview.steps)).toEqual([]);
  });

  test("a create the approval did not hold is a difference", () => {
    const extra: PulumiStep = { op: "create", urn: urn("aws:s3/bucket:Bucket", "extra"), newState: { type: "aws:s3/bucket:Bucket", inputs: { bucket: "extra" } } };
    const steps = [...preview.steps, extra];
    const differences = pulumiShapeDifferences(approved, pulumiPlanShape(partOf({ steps }), member), steps);
    expect(differences).toEqual([`${member} now plans to create ${urn("aws:s3/bucket:Bucket", "extra")}, which the first plan did not`]);
  });

  test("an update the approval showed as same is a difference", () => {
    const steps = preview.steps.map((s) =>
      s.urn === urn("aws:iam/role:Role", "app-role") ? { ...s, op: "update", diffReasons: ["assumeRolePolicy"], detailedDiff: { assumeRolePolicy: { kind: "update" } } } : s,
    );
    expect(pulumiShapeDifferences(approved, pulumiPlanShape(partOf({ steps }), member), steps)[0]).toMatch(/now plans to update .*app-role/);
  });

  test("a resource registered under a component the approval marked mayAppear is within it", () => {
    const site = urn("corpus:index:Site", "docs");
    const marked = { ...approved, entries: [...approved.entries, { logicalId: pulumiMayAppearAddress(site), action: "create" as const }] };
    const child: PulumiStep = {
      op: "create",
      urn: urn("corpus:index:Site$aws:s3/bucket:Bucket", "docs-logs"),
      newState: { type: "aws:s3/bucket:Bucket", parent: site, inputs: { bucket: "docs-logs" } },
    };
    const steps = [...preview.steps, child];
    expect(pulumiShapeDifferences(marked, pulumiPlanShape(partOf({ steps }), member), steps)).toEqual([]);
    // Without the mark the same create is a difference.
    expect(pulumiShapeDifferences(approved, pulumiPlanShape(partOf({ steps }), member), steps)).toHaveLength(1);
  });
});
