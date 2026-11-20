import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { classifyPulumiDisruption, pulumiDisruptionQueries } from "./disruption";
import { pulumiPlugin } from "./plugin";

const fixture = (path: string) => JSON.parse(readFileSync(join(__dirname, "testdata", path), "utf-8"));

const URN = "urn:pulumi:floci::corpus-aws-ts::";

describe("pulumi disruption from a preview's steps (#5338)", () => {
  test("a recorded preview classifies each update, replace and delete through the contract", async () => {
    const changes = pulumiDisruptionQueries(fixture("pulumi-preview/preview.json"));
    expect(changes.map((c) => c.name).sort()).toEqual(
      [
        "aws:ec2/securityGroup:SecurityGroup::app-sg",
        "aws:ec2/vpc:Vpc::main",
        "aws:sqs/queue:Queue::events",
        "aws:sqs/queue:Queue::worker-2",
        "aws:ssm/parameter:Parameter::db-password",
        "aws:ssm/parameter:Parameter::vpc-id",
      ].map((t) => URN + t),
    );
    const verdicts = await pulumiPlugin.classifyDisruption!({ environment: "floci", changes });
    expect(verdicts[`${URN}aws:sqs/queue:Queue::events`]).toEqual({ disruption: "in-place", detail: "the preview updates it in place" });
    expect(verdicts[`${URN}aws:ec2/vpc:Vpc::main`]).toMatchObject({ disruption: "replace", because: ["cidrBlock"] });
    expect(verdicts[`${URN}aws:ec2/securityGroup:SecurityGroup::app-sg`]).toMatchObject({ disruption: "replace", because: ["vpcId"] });
    expect(verdicts[`${URN}aws:sqs/queue:Queue::worker-2`]).toMatchObject({ disruption: "destroy" });
  });

  test("a delete before its replacement is destroy; a delete after is replace; a create is not asked", () => {
    const changes = pulumiDisruptionQueries(fixture("disruption/preview-delete-first.json"));
    expect(changes.map((c) => c.name)).toEqual([
      "urn:pulumi:dev::app::aws:rds/instance:Instance::db",
      "urn:pulumi:dev::app::aws:lb/targetGroup:TargetGroup::api",
    ]);
    expect(changes[0]!.type).toBe("aws:rds/instance:Instance");
    const verdicts = classifyPulumiDisruption({ environment: "dev", changes });
    expect(verdicts["urn:pulumi:dev::app::aws:rds/instance:Instance::db"]).toMatchObject({ disruption: "destroy", because: ["engine"] });
    expect(verdicts["urn:pulumi:dev::app::aws:lb/targetGroup:TargetGroup::api"]).toMatchObject({ disruption: "replace", because: ["port"] });
  });

  test("a query with no steps gets no verdict, which core reads as unknown", () => {
    expect(classifyPulumiDisruption({ environment: "dev", changes: [{ name: "x", deltas: [] }] })).toEqual({});
  });
});
