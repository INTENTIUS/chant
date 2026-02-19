import { describe, test, expect } from "bun:test";
import {
  parseCFNSchema,
  cfnShortName,
  cfnServiceName,
} from "./parse";

// Sample Registry JSON Schema for testing
const sampleBucketSchema = JSON.stringify({
  typeName: "AWS::S3::Bucket",
  description: "Creates an S3 bucket",
  properties: {
    BucketName: { type: "string", description: "Name of the bucket" },
    Tags: {
      type: "array",
      items: { $ref: "#/definitions/Tag" },
    },
    VersioningConfiguration: {
      $ref: "#/definitions/VersioningConfiguration",
    },
    AccessControl: {
      type: "string",
      enum: ["Private", "PublicRead", "PublicReadWrite"],
    },
  },
  definitions: {
    Tag: {
      type: "object",
      properties: {
        Key: { type: "string" },
        Value: { type: "string" },
      },
      required: ["Key", "Value"],
      additionalProperties: false,
    },
    VersioningConfiguration: {
      type: "object",
      properties: {
        Status: { type: "string", enum: ["Enabled", "Suspended"] },
      },
      required: ["Status"],
      additionalProperties: false,
    },
  },
  readOnlyProperties: [
    "/properties/Arn",
    "/properties/DomainName",
    "/properties/RegionalDomainName",
    "/properties/WebsiteURL",
  ],
  required: [],
  primaryIdentifier: ["/properties/BucketName"],
  additionalProperties: false,
});

describe("parseCFNSchema", () => {
  test("parses resource type", () => {
    const result = parseCFNSchema(sampleBucketSchema);

    expect(result.resource.typeName).toBe("AWS::S3::Bucket");
  });

  test("parses properties", () => {
    const result = parseCFNSchema(sampleBucketSchema);

    expect(result.resource.properties.length).toBeGreaterThan(0);

    const bucketName = result.resource.properties.find((p) => p.name === "BucketName");
    expect(bucketName).toBeDefined();
    expect(bucketName!.tsType).toBe("string");
    expect(bucketName!.required).toBe(false);
  });

  test("parses attributes from readOnlyProperties", () => {
    const result = parseCFNSchema(sampleBucketSchema);

    expect(result.resource.attributes.length).toBe(4);
    const arn = result.resource.attributes.find((a) => a.name === "Arn");
    expect(arn).toBeDefined();
  });

  test("parses property types from definitions", () => {
    const result = parseCFNSchema(sampleBucketSchema);

    expect(result.propertyTypes.length).toBeGreaterThan(0);

    const tag = result.propertyTypes.find((pt) => pt.name === "Bucket_Tag");
    expect(tag).toBeDefined();
    expect(tag!.properties.length).toBe(2);
  });

  test("parses enum values", () => {
    const result = parseCFNSchema(sampleBucketSchema);

    // AccessControl enum should be extracted from the property
    const accessControl = result.resource.properties.find((p) => p.name === "AccessControl");
    expect(accessControl).toBeDefined();
    expect(accessControl!.enum).toContain("Private");
    expect(accessControl!.enum).toContain("PublicRead");
  });

  test("parses array types", () => {
    const result = parseCFNSchema(sampleBucketSchema);

    const tags = result.resource.properties.find((p) => p.name === "Tags");
    expect(tags).toBeDefined();
    expect(tags!.tsType).toContain("[]");
  });

  test("parses required properties", () => {
    const result = parseCFNSchema(JSON.stringify({
      typeName: "AWS::Test::Resource",
      properties: {
        Name: { type: "string" },
        Optional: { type: "string" },
      },
      required: ["Name"],
      additionalProperties: false,
    }));

    const name = result.resource.properties.find((p) => p.name === "Name");
    const optional = result.resource.properties.find((p) => p.name === "Optional");
    expect(name!.required).toBe(true);
    expect(optional!.required).toBe(false);
  });

  test("handles schema without properties", () => {
    const result = parseCFNSchema(JSON.stringify({
      typeName: "AWS::Test::Empty",
      additionalProperties: false,
    }));

    expect(result.resource.typeName).toBe("AWS::Test::Empty");
    expect(result.resource.properties).toEqual([]);
    expect(result.resource.attributes).toEqual([]);
  });
});

describe("cfnShortName", () => {
  test("extracts short name from full type", () => {
    expect(cfnShortName("AWS::S3::Bucket")).toBe("Bucket");
    expect(cfnShortName("AWS::Lambda::Function")).toBe("Function");
    expect(cfnShortName("AWS::IAM::Role")).toBe("Role");
  });
});

describe("cfnServiceName", () => {
  test("extracts service name from full type", () => {
    expect(cfnServiceName("AWS::S3::Bucket")).toBe("S3");
    expect(cfnServiceName("AWS::Lambda::Function")).toBe("Lambda");
    expect(cfnServiceName("AWS::IAM::Role")).toBe("IAM");
  });
});
