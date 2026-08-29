import { describe, test, expect } from "vitest";
import { awsDisruption, classifyAwsChange, type DisruptionSpec } from "./disruption";
import type { DisruptionQuery } from "@intentius/chant/lexicon";

const specs = new Map<string, DisruptionSpec>([
  [
    "AWS::EC2::Instance",
    {
      resourceType: "AWS::EC2::Instance",
      kind: "resource",
      attrs: { InstanceId: "InstanceId", PublicIp: "PublicIp" },
      createOnly: ["ImageId", "SubnetId", "KeyName"],
      conditionalCreateOnly: ["InstanceType"],
    },
  ],
  [
    "AWS::RDS::DBInstance",
    {
      resourceType: "AWS::RDS::DBInstance",
      kind: "resource",
      createOnly: ["DBInstanceIdentifier"],
      replacementStrategy: "delete_then_create",
    },
  ],
  [
    "AWS::S3::BucketPolicy",
    { resourceType: "AWS::S3::BucketPolicy", kind: "resource" },
  ],
  [
    "AWS::EC2::Instance.BlockDeviceMapping",
    { resourceType: "AWS::EC2::Instance.BlockDeviceMapping", kind: "property" },
  ],
]);

function query(type: string | undefined, paths: string[]): DisruptionQuery {
  return {
    name: "thing",
    ...(type ? { type } : {}),
    deltas: paths.map((path) => ({ path, oldValue: "a", newValue: "b" })),
  };
}

describe("classifyAwsChange (#1665)", () => {
  test("a create-only property is a replace, and says which one", () => {
    const v = classifyAwsChange(query("AWS::EC2::Instance", ["attributes.ImageId"]), specs);
    expect(v.disruption).toBe("replace");
    expect(v.because).toEqual(["attributes.ImageId"]);
    expect(v.detail).toContain("ImageId is create-only");
  });

  // `delete_then_create` is the destructive form: the old resource is gone
  // before the new one exists.
  test("delete_then_create replacement is a destroy", () => {
    const v = classifyAwsChange(
      query("AWS::RDS::DBInstance", ["attributes.DBInstanceIdentifier"]),
      specs,
    );
    expect(v.disruption).toBe("destroy");
    expect(v.detail).toContain("deleting first");
  });

  test("a mutable property is in-place", () => {
    const v = classifyAwsChange(query("AWS::EC2::Instance", ["attributes.Monitoring"]), specs);
    expect(v.disruption).toBe("in-place");
    expect(v.detail).toContain("no create-only property of AWS::EC2::Instance changed");
  });

  test("replacement wins over an in-place property changing alongside it", () => {
    const v = classifyAwsChange(
      query("AWS::EC2::Instance", ["attributes.Monitoring", "attributes.SubnetId"]),
      specs,
    );
    expect(v.disruption).toBe("replace");
    expect(v.because).toEqual(["attributes.SubnetId"]);
  });

  // The schema says "depends on the value", which is not an answer. Reporting
  // that as in-place would be the exact failure the `unknown` level exists for.
  test("a conditionally create-only property is unknown, not in-place", () => {
    const v = classifyAwsChange(
      query("AWS::EC2::Instance", ["attributes.InstanceType"]),
      specs,
    );
    expect(v.disruption).toBe("unknown");
    expect(v.because).toEqual(["attributes.InstanceType"]);
    expect(v.detail).toContain("conditionally create-only");
  });

  test("a type with no schema on record is unknown", () => {
    const v = classifyAwsChange(query("AWS::Nowhere::Thing", ["attributes.Anything"]), specs);
    expect(v.disruption).toBe("unknown");
    expect(v.detail).toContain("no CloudFormation registry schema on record");
  });

  test("a property-type entry is not a resource, so it is unknown", () => {
    const v = classifyAwsChange(
      query("AWS::EC2::Instance.BlockDeviceMapping", ["attributes.Ebs"]),
      specs,
    );
    expect(v.disruption).toBe("unknown");
  });

  test("an entry with no observed type is unknown", () => {
    const v = classifyAwsChange(query(undefined, ["attributes.ImageId"]), specs);
    expect(v.disruption).toBe("unknown");
    expect(v.detail).toContain("no resource type");
  });

  // A read-only attribute changing is a symptom of something else, never the
  // cause of a replacement — a re-created instance reports a new PublicIp.
  test("read-only attributes are not evidence of anything", () => {
    const v = classifyAwsChange(query("AWS::EC2::Instance", ["attributes.PublicIp"]), specs);
    expect(v.disruption).toBe("in-place");
    expect(v.detail).toContain("only status, identity, or read-only attributes changed");
  });

  test("core's own observation fields are not properties", () => {
    const v = classifyAwsChange(
      query("AWS::EC2::Instance", ["status", "lastUpdated", "physicalId"]),
      specs,
    );
    expect(v.disruption).toBe("in-place");
    expect(v.detail).toContain("only status, identity, or read-only attributes changed");
  });

  test("a type whose schema declares no create-only property is in-place", () => {
    const v = classifyAwsChange(query("AWS::S3::BucketPolicy", ["attributes.PolicyDocument"]), specs);
    expect(v.disruption).toBe("in-place");
  });

  // createOnlyProperties can point at a nested pointer path (`Config/Engine`);
  // the observation reports the top-level property.
  test("a nested create-only pointer matches on its head segment", () => {
    const nested = new Map<string, DisruptionSpec>([
      [
        "AWS::Fake::Thing",
        { resourceType: "AWS::Fake::Thing", kind: "resource", createOnly: ["Config/Engine"] },
      ],
    ]);
    const v = classifyAwsChange(query("AWS::Fake::Thing", ["attributes.Config"]), nested);
    expect(v.disruption).toBe("replace");
  });

  test("duplicate hits name the property once but keep every path", () => {
    const v = classifyAwsChange(
      query("AWS::EC2::Instance", ["attributes.ImageId", "attributes.KeyName"]),
      specs,
    );
    expect(v.because).toEqual(["attributes.ImageId", "attributes.KeyName"]);
    expect(v.detail).toContain("ImageId, KeyName");
  });
});

// The plugin method against the registry the codegen actually compiled — the
// evidence that the verdicts come from CloudFormation's own schema and not
// from a table in this file.
describe("awsDisruption over the generated registry", () => {
  const change = (name: string, type: string, paths: string[]): DisruptionQuery => ({
    name,
    type,
    deltas: paths.map((path) => ({ path, oldValue: "a", newValue: "b" })),
  });

  test("classifies a whole batch off the compiled schema", () => {
    const out = awsDisruption({
      environment: "prod",
      changes: [
        // createOnlyProperties
        change("web", "AWS::EC2::Instance", ["attributes.ImageId"]),
        // conditionalCreateOnlyProperties — the schema says "it depends"
        change("sized", "AWS::EC2::Instance", ["attributes.InstanceType"]),
        // not create-only for this type
        change("mon", "AWS::EC2::Instance", ["attributes.Monitoring"]),
        // no schema on record
        change("nope", "AWS::Nowhere::Thing", ["attributes.Whatever"]),
      ],
    });

    expect(out.web.disruption).toBe("replace");
    expect(out.web.because).toEqual(["attributes.ImageId"]);
    expect(out.sized.disruption).toBe("unknown");
    expect(out.sized.detail).toContain("conditionally create-only");
    expect(out.mon.disruption).toBe("in-place");
    expect(out.nope.disruption).toBe("unknown");
  });

  test("every query gets a verdict, so nothing silently drops out of the plan", () => {
    const changes = [
      change("a", "AWS::S3::Bucket", ["attributes.BucketName"]),
      change("b", "AWS::IAM::Role", ["attributes.RoleName"]),
    ];
    const out = awsDisruption({ environment: "prod", changes });
    expect(Object.keys(out).sort()).toEqual(["a", "b"]);
    // BucketName and RoleName are both create-only in the Registry schema.
    expect(out.a.disruption).toBe("replace");
    expect(out.b.disruption).toBe("replace");
  });
});
