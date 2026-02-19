import { describe, test, expect } from "bun:test";
import { Sub, Ref, GetAtt, If, Join, Select, Split, Base64 } from "./intrinsics";
import { AWS } from "./pseudo";
import { AttrRef } from "@intentius/chant/attrref";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

// Mock declarable for testing
class MockBucket implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "aws";
  readonly entityType = "AWS::S3::Bucket";
  readonly arn: AttrRef;
  readonly props = {};

  constructor() {
    this.arn = new AttrRef(this, "Arn");
  }
}

describe("Sub intrinsic", () => {
  test("creates simple template", () => {
    const result = Sub`my-bucket`;
    expect(result.toJSON()).toEqual({ "Fn::Sub": "my-bucket" });
  });

  test("interpolates string values", () => {
    const env = "prod";
    const result = Sub`my-bucket-${env}`;
    expect(result.toJSON()).toEqual({ "Fn::Sub": "my-bucket-prod" });
  });

  test("interpolates pseudo-parameters", () => {
    const result = Sub`${AWS.StackName}-bucket`;
    expect(result.toJSON()).toEqual({ "Fn::Sub": "${AWS::StackName}-bucket" });
  });

  test("interpolates AttrRef", () => {
    const bucket = new MockBucket();
    // Set the logical name on the AttrRef
    (bucket.arn as Record<string, unknown>)._setLogicalName("MyBucket");

    const result = Sub`arn:aws:s3:::${bucket.arn}/*`;
    expect(result.toJSON()["Fn::Sub"]).toContain("${MyBucket.Arn}");
  });

  test("handles multiple interpolations", () => {
    const result = Sub`${AWS.StackName}-${AWS.Region}-bucket`;
    expect(result.toJSON()).toEqual({
      "Fn::Sub": "${AWS::StackName}-${AWS::Region}-bucket",
    });
  });

  test("throws for direct Declarable when serializing", () => {
    const bucket = new MockBucket();
    const sub = Sub`${bucket as unknown}`;
    expect(() => sub.toJSON()).toThrow("Cannot embed Declarable directly");
  });
});

describe("Ref intrinsic", () => {
  test("creates Ref for resource name", () => {
    const result = Ref("MyBucket");
    expect(result.toJSON()).toEqual({ Ref: "MyBucket" });
  });

  test("creates Ref for parameter", () => {
    const result = Ref("Environment");
    expect(result.toJSON()).toEqual({ Ref: "Environment" });
  });
});

describe("GetAtt intrinsic", () => {
  test("creates GetAtt", () => {
    const result = GetAtt("MyBucket", "Arn");
    expect(result.toJSON()).toEqual({ "Fn::GetAtt": ["MyBucket", "Arn"] });
  });

  test("handles dotted attribute names", () => {
    const result = GetAtt("MyFunction", "SnapStartResponse.ApplyOn");
    expect(result.toJSON()).toEqual({
      "Fn::GetAtt": ["MyFunction", "SnapStartResponse.ApplyOn"],
    });
  });
});

describe("If intrinsic", () => {
  test("creates If with values", () => {
    const result = If("CreateProd", "prod-bucket", "dev-bucket");
    expect(result.toJSON()).toEqual({
      "Fn::If": ["CreateProd", "prod-bucket", "dev-bucket"],
    });
  });

  test("handles nested intrinsics", () => {
    const result = If("CreateProd", Ref("ProdBucket"), Ref("DevBucket"));
    expect(result.toJSON()).toEqual({
      "Fn::If": ["CreateProd", { Ref: "ProdBucket" }, { Ref: "DevBucket" }],
    });
  });
});

describe("Join intrinsic", () => {
  test("joins strings", () => {
    const result = Join("-", ["a", "b", "c"]);
    expect(result.toJSON()).toEqual({ "Fn::Join": ["-", ["a", "b", "c"]] });
  });

  test("joins with empty delimiter", () => {
    const result = Join("", ["hello", "world"]);
    expect(result.toJSON()).toEqual({ "Fn::Join": ["", ["hello", "world"]] });
  });

  test("handles intrinsic values", () => {
    const result = Join("-", [Ref("Prefix"), "bucket"]);
    expect(result.toJSON()).toEqual({
      "Fn::Join": ["-", [{ Ref: "Prefix" }, "bucket"]],
    });
  });
});

describe("Select intrinsic", () => {
  test("selects from array", () => {
    const result = Select(0, ["a", "b", "c"]);
    expect(result.toJSON()).toEqual({ "Fn::Select": ["0", ["a", "b", "c"]] });
  });

  test("selects with intrinsic array", () => {
    const result = Select(1, [Ref("A"), Ref("B")]);
    expect(result.toJSON()).toEqual({
      "Fn::Select": ["1", [{ Ref: "A" }, { Ref: "B" }]],
    });
  });
});

describe("Split intrinsic", () => {
  test("splits string", () => {
    const result = Split(",", "a,b,c");
    expect(result.toJSON()).toEqual({ "Fn::Split": [",", "a,b,c"] });
  });

  test("splits with intrinsic source", () => {
    const result = Split(",", Ref("CommaSeparatedList"));
    expect(result.toJSON()).toEqual({
      "Fn::Split": [",", { Ref: "CommaSeparatedList" }],
    });
  });
});

describe("Base64 intrinsic", () => {
  test("encodes string", () => {
    const result = Base64("Hello World");
    expect(result.toJSON()).toEqual({ "Fn::Base64": "Hello World" });
  });

  test("encodes intrinsic result", () => {
    const result = Base64(Ref("UserData"));
    expect(result.toJSON()).toEqual({ "Fn::Base64": { Ref: "UserData" } });
  });

  test("handles nested Sub", () => {
    const result = Base64(Sub`#!/bin/bash\necho ${AWS.StackName}`);
    const json = result.toJSON();
    expect(json["Fn::Base64"]).toEqual({
      "Fn::Sub": "#!/bin/bash\necho ${AWS::StackName}",
    });
  });
});
