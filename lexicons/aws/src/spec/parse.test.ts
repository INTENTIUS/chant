import { describe, test, expect } from "vitest";
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
      description: "This is a legacy property, and it is not recommended for most use cases.",
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
  deprecatedProperties: ["/properties/AccessControl"],
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

  // --- Deprecated properties ---

  test("parses explicit deprecatedProperties", () => {
    const result = parseCFNSchema(sampleBucketSchema);
    expect(result.resource.deprecatedProperties).toContain("AccessControl");
  });

  test("mines deprecation from property description", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::DescMined",
      properties: {
        OldProp: { type: "string", description: "This property is deprecated. Use NewProp instead." },
        NewProp: { type: "string", description: "The replacement property" },
      },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.deprecatedProperties).toContain("OldProp");
    expect(result.resource.deprecatedProperties).not.toContain("NewProp");
  });

  test("mines 'legacy' keyword from description", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::Legacy",
      properties: {
        LegacyProp: { type: "string", description: "This is a legacy property, not recommended." },
      },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.deprecatedProperties).toContain("LegacyProp");
  });

  test("deduplicates when both explicit and description flag same property", () => {
    // sampleBucketSchema has AccessControl in both deprecatedProperties array and description
    const result = parseCFNSchema(sampleBucketSchema);
    const count = result.resource.deprecatedProperties.filter((p) => p === "AccessControl").length;
    expect(count).toBe(1);
  });

  test("empty deprecatedProperties when none found", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::Clean",
      properties: {
        Name: { type: "string", description: "A normal property" },
      },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.deprecatedProperties).toEqual([]);
  });

  // --- Tagging metadata ---

  test("parses tagging metadata when taggable", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::Taggable",
      properties: { Tags: { type: "array" } },
      tagging: { taggable: true, tagOnCreate: true, tagUpdatable: true },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.tagging).toEqual({
      taggable: true,
      tagOnCreate: true,
      tagUpdatable: true,
    });
  });

  test("omits tagging when not taggable", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::NotTaggable",
      properties: { Name: { type: "string" } },
      tagging: { taggable: false },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.tagging).toBeUndefined();
  });

  test("omits tagging when absent", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::NoTagging",
      properties: { Name: { type: "string" } },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.tagging).toBeUndefined();
  });

  // --- Replacement strategy ---

  test("parses replacementStrategy", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::DeleteFirst",
      properties: { Name: { type: "string" } },
      replacementStrategy: "delete_then_create",
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.replacementStrategy).toBe("delete_then_create");
  });

  test("omits replacementStrategy when absent", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::NoStrategy",
      properties: { Name: { type: "string" } },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.replacementStrategy).toBeUndefined();
  });

  // --- Conditional create-only ---

  test("parses conditionalCreateOnlyProperties", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::ConditionalCreate",
      properties: {
        Name: { type: "string" },
        Engine: { type: "string" },
      },
      conditionalCreateOnlyProperties: ["/properties/Engine"],
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.conditionalCreateOnly).toContain("Engine");
  });

  test("empty conditionalCreateOnly when absent", () => {
    const schema = JSON.stringify({
      typeName: "AWS::Test::NoConditional",
      properties: { Name: { type: "string" } },
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);
    expect(result.resource.conditionalCreateOnly).toEqual([]);
  });

  // --- Nested readOnlyProperties ---

  test("parses nested readOnlyProperties as flattened dot-separated attrs", () => {
    const schema = JSON.stringify({
      typeName: "AWS::RDS::DBInstance",
      properties: {
        DBInstanceIdentifier: { type: "string" },
        Endpoint: { $ref: "#/definitions/Endpoint" },
      },
      definitions: {
        Endpoint: {
          type: "object",
          properties: {
            Address: { type: "string" },
            Port: { type: "string" },
            HostedZoneId: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      readOnlyProperties: [
        "/properties/Endpoint",
        "/properties/Endpoint/Address",
        "/properties/Endpoint/Port",
        "/properties/Endpoint/HostedZoneId",
        "/properties/DBInstanceIdentifier",
      ],
      additionalProperties: false,
    });
    const result = parseCFNSchema(schema);

    // Should have both top-level and nested attrs
    const attrNames = result.resource.attributes.map((a) => a.name);
    expect(attrNames).toContain("Endpoint");
    expect(attrNames).toContain("Endpoint.Address");
    expect(attrNames).toContain("Endpoint.Port");
    expect(attrNames).toContain("Endpoint.HostedZoneId");
    expect(attrNames).toContain("DBInstanceIdentifier");

    // Top-level Endpoint gets its resolved type from properties
    const endpoint = result.resource.attributes.find((a) => a.name === "Endpoint");
    expect(endpoint!.tsType).not.toBe("string"); // Should be a $ref type

    // Nested attrs are always string
    const address = result.resource.attributes.find((a) => a.name === "Endpoint.Address");
    expect(address!.tsType).toBe("string");
    const port = result.resource.attributes.find((a) => a.name === "Endpoint.Port");
    expect(port!.tsType).toBe("string");
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
