import { describe, test, expect } from "vitest";
import {
  applyEnumOverlay,
  assertOverlayCoverage,
  enumOverlayByType,
  enumOverlayEntries,
  redundantOverlayWarnings,
  type EnumOverlayEntry,
} from "./enum-overlay";
import { generate } from "./generate";

const entry = (over: Partial<EnumOverlayEntry> = {}): EnumOverlayEntry => ({
  type: "AWS::Test::Resource",
  pointer: "/properties/Mode",
  enumName: "Mode",
  note: "test",
  source: { kind: "docs", url: "https://example.invalid" },
  reviewed: "2026-09-06",
  values: ["fast", "slow"],
  ...over,
});

const schema = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    typeName: "AWS::Test::Resource",
    properties: { Mode: { type: "string" }, Name: { type: "string" } },
    additionalProperties: false,
    ...extra,
  });

describe("applyEnumOverlay", () => {
  test("narrows a bare string property to a named enum definition", () => {
    const { data, applications } = applyEnumOverlay("AWS::Test::Resource", schema(), [entry()], {
      strict: true,
    });

    expect(applications).toEqual([{ entry: entry(), outcome: "applied" }]);
    const doc = JSON.parse(data as string);
    expect(doc.definitions.Mode).toEqual({ type: "string", enum: ["fast", "slow"] });
    expect(doc.properties.Mode.$ref).toBe("#/definitions/Mode");
    // The enum stays on the property too, because that is what the lexicon
    // registry's propertyConstraints are read from.
    expect(doc.properties.Mode.enum).toEqual(["fast", "slow"]);
    expect(doc.properties.Name).toEqual({ type: "string" });
  });

  test("reaches a property inside a definition", () => {
    const nested = JSON.stringify({
      typeName: "AWS::Test::Resource",
      properties: { Disk: { $ref: "#/definitions/Ebs" } },
      definitions: { Ebs: { type: "object", properties: { VolumeType: { type: "string" } } } },
    });

    const { data } = applyEnumOverlay(
      "AWS::Test::Resource",
      nested,
      [entry({ pointer: "/definitions/Ebs/properties/VolumeType", enumName: "VolumeType", values: ["gp2", "gp3"] })],
      { strict: true },
    );

    const doc = JSON.parse(data as string);
    expect(doc.definitions.VolumeType).toEqual({ type: "string", enum: ["gp2", "gp3"] });
    expect(doc.definitions.Ebs.properties.VolumeType.$ref).toBe("#/definitions/VolumeType");
  });

  test("the spec wins where it already declares allowed values", () => {
    const withEnum = schema({
      properties: { Mode: { type: "string", enum: ["fast", "slow", "medium"] } },
    });

    const { data, applications } = applyEnumOverlay("AWS::Test::Resource", withEnum, [entry()], {
      strict: true,
    });

    expect(applications[0].outcome).toBe("redundant");
    expect(applications[0].upstreamValues).toEqual(["fast", "slow", "medium"]);
    // Untouched: no definition minted, no $ref, upstream values intact.
    expect(data).toBe(withEnum);
    const doc = JSON.parse(data as string);
    expect(doc.definitions).toBeUndefined();
    expect(doc.properties.Mode.$ref).toBeUndefined();
    expect(doc.properties.Mode.enum).toEqual(["fast", "slow", "medium"]);
  });

  test("a redundant entry produces a warning naming the entry", () => {
    const withEnum = schema({ properties: { Mode: { type: "string", enum: ["fast"] } } });
    const { applications } = applyEnumOverlay("AWS::Test::Resource", withEnum, [entry()], {
      strict: true,
    });

    const warnings = redundantOverlayWarnings(applications);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].file).toBe("AWS::Test::Resource/properties/Mode");
    expect(warnings[0].error).toContain("redundant");
  });

  test("a strict run fails loudly on a property the schema does not declare", () => {
    expect(() =>
      applyEnumOverlay("AWS::Test::Resource", schema(), [entry({ pointer: "/properties/Gone" })], {
        strict: true,
      }),
    ).toThrow(/AWS::Test::Resource\/properties\/Gone names a property the schema does not declare/);
  });

  test("a fixture run records the same case as absent instead of failing", () => {
    const { applications } = applyEnumOverlay(
      "AWS::Test::Resource",
      schema(),
      [entry({ pointer: "/properties/Gone" })],
      { strict: false },
    );
    expect(applications[0].outcome).toBe("absent");
  });

  test("fails when the enum name would shadow an existing definition", () => {
    const withDef = schema({ definitions: { Mode: { type: "object", properties: {} } } });
    expect(() =>
      applyEnumOverlay("AWS::Test::Resource", withDef, [entry()], { strict: true }),
    ).toThrow(/already declares/);
  });

  test("fails when the target property already refers to a definition", () => {
    const withRef = schema({
      properties: { Mode: { $ref: "#/definitions/Other" } },
      definitions: { Other: { type: "string" } },
    });
    expect(() =>
      applyEnumOverlay("AWS::Test::Resource", withRef, [entry()], { strict: true }),
    ).toThrow(/already refers to/);
  });

  test("leaves a schema with no entries untouched", () => {
    const original = schema();
    const { data, applications } = applyEnumOverlay("AWS::Other::Thing", original, []);
    expect(data).toBe(original);
    expect(applications).toEqual([]);
  });
});

describe("assertOverlayCoverage", () => {
  test("a strict run fails on an entry whose type never appeared", () => {
    expect(() => assertOverlayCoverage([entry()], new Set(["AWS::S3::Bucket"]), true)).toThrow(
      /AWS::Test::Resource/,
    );
  });

  test("a fixture run tolerates it", () => {
    expect(() => assertOverlayCoverage([entry()], new Set(["AWS::S3::Bucket"]), false)).not.toThrow();
  });

  test("passes when every type was seen", () => {
    expect(() =>
      assertOverlayCoverage([entry()], new Set(["AWS::Test::Resource"]), true),
    ).not.toThrow();
  });
});

describe("the shipped overlay", () => {
  const entries = enumOverlayEntries();

  test("is non-empty and grouped by type without loss", () => {
    expect(entries.length).toBeGreaterThan(0);
    const grouped = [...enumOverlayByType(entries).values()].reduce((n, l) => n + l.length, 0);
    expect(grouped).toBe(entries.length);
  });

  test("addresses each property at most once", () => {
    const keys = entries.map((e) => `${e.type}${e.pointer}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every entry is well formed", () => {
    for (const e of entries) {
      expect(e.type, `${e.type} is a CloudFormation type name`).toMatch(/^[A-Za-z0-9]+(::[A-Za-z0-9]+){2}$/);
      expect(e.pointer, `${e.type}${e.pointer} is a properties pointer`).toMatch(
        /^\/(properties\/[A-Za-z0-9]+|definitions\/[A-Za-z0-9]+\/properties\/[A-Za-z0-9]+)$/,
      );
      expect(e.enumName, `${e.type}${e.pointer} names its definition`).toMatch(/^[A-Za-z0-9]+$/);
      expect(e.reviewed, `${e.type}${e.pointer} records when it was read`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.note.length, `${e.type}${e.pointer} says why it is here`).toBeGreaterThan(0);
      if (e.source.kind === "botocore") {
        expect(e.source.service).toBeTruthy();
        expect(e.source.apiVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(e.source.shape).toBeTruthy();
      } else {
        expect(e.source.url).toMatch(/^https:\/\//);
      }
    }
  });

  test("every value list is non-empty, unique and sorted", () => {
    for (const e of entries) {
      const where = `${e.type}${e.pointer}`;
      expect(e.values.length, where).toBeGreaterThan(0);
      expect(new Set(e.values).size, where).toBe(e.values.length);
      expect(e.values, where).toEqual([...e.values].sort());
    }
  });

  test("covers the headline property from chant #1497", () => {
    const ec2 = entries.find(
      (e) => e.type === "AWS::EC2::Instance" && e.pointer === "/properties/InstanceType",
    );
    expect(ec2).toBeDefined();
    expect(ec2!.values).toContain("t3.micro");
  });

  test("carries every value the repo's own examples and composites already write", () => {
    const written: Array<[string, string, string]> = [
      ["AWS::Lambda::Function", "/properties/Runtime", "nodejs20.x"],
      ["AWS::Lambda::Function", "/properties/Runtime", "nodejs18.x"],
      ["AWS::Lambda::Function", "/properties/Runtime", "python3.12"],
      ["AWS::EC2::Instance", "/properties/InstanceType", "t3.micro"],
      ["AWS::ElasticLoadBalancingV2::TargetGroup", "/properties/Protocol", "HTTP"],
      ["AWS::ElasticLoadBalancingV2::TargetGroup", "/properties/Protocol", "HTTPS"],
      ["AWS::ElasticLoadBalancingV2::TargetGroup", "/properties/Protocol", "TCP"],
      ["AWS::ElasticLoadBalancingV2::TargetGroup", "/properties/TargetType", "ip"],
      ["AWS::ElasticLoadBalancingV2::LoadBalancer", "/properties/Scheme", "internet-facing"],
      ["AWS::SNS::Subscription", "/properties/Protocol", "lambda"],
      ["AWS::DynamoDB::Table", "/properties/BillingMode", "PAY_PER_REQUEST"],
      ["AWS::DynamoDB::Table", "/definitions/AttributeDefinition/properties/AttributeType", "S"],
      ["AWS::DynamoDB::Table", "/definitions/AttributeDefinition/properties/AttributeType", "N"],
      ["AWS::DynamoDB::Table", "/definitions/KeySchema/properties/KeyType", "HASH"],
      ["AWS::DynamoDB::Table", "/definitions/KeySchema/properties/KeyType", "RANGE"],
      ["AWS::DynamoDB::Table", "/definitions/Projection/properties/ProjectionType", "ALL"],
      ["AWS::DynamoDB::Table", "/definitions/Projection/properties/ProjectionType", "INCLUDE"],
      ["AWS::DynamoDB::Table", "/definitions/StreamSpecification/properties/StreamViewType", "NEW_AND_OLD_IMAGES"],
      ["AWS::DynamoDB::Table", "/definitions/StreamSpecification/properties/StreamViewType", "KEYS_ONLY"],
      ["AWS::RDS::DBInstance", "/properties/Engine", "postgres"],
      ["AWS::RDS::DBCluster", "/properties/Engine", "aurora-postgresql"],
      ["AWS::ApplicationAutoScaling::ScalableTarget", "/properties/ServiceNamespace", "ecs"],
      ["AWS::ApplicationAutoScaling::ScalableTarget", "/properties/ServiceNamespace", "dynamodb"],
      ["AWS::ApplicationAutoScaling::ScalableTarget", "/properties/ScalableDimension", "ecs:service:DesiredCount"],
      [
        "AWS::ApplicationAutoScaling::ScalableTarget",
        "/properties/ScalableDimension",
        "dynamodb:table:ReadCapacityUnits",
      ],
    ];

    for (const [type, pointer, value] of written) {
      const e = entries.find((x) => x.type === type && x.pointer === pointer);
      expect(e, `${type}${pointer} is in the overlay`).toBeDefined();
      expect(e!.values, `${type}${pointer} accepts ${value}`).toContain(value);
    }
  });
});

describe("the overlay through the generation pipeline", () => {
  test("a bare property comes out as a named union in the .d.ts", async () => {
    const schemas = new Map<string, Buffer>([
      [
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
        Buffer.from(
          JSON.stringify({
            typeName: "AWS::ElasticLoadBalancingV2::LoadBalancer",
            properties: { Name: { type: "string" }, Scheme: { type: "string" } },
            additionalProperties: false,
          }),
        ),
      ],
    ]);

    const result = await generate({ schemaSource: schemas });

    expect(result.typesDTS).toContain(
      'export type LoadBalancer_Scheme = "internal" | "internet-facing";',
    );
    expect(result.typesDTS).toContain("Scheme?: LoadBalancer_Scheme;");

    const lexicon = JSON.parse(result.lexiconJSON);
    expect(lexicon["LoadBalancer"].propertyConstraints.Scheme.enum).toEqual([
      "internal",
      "internet-facing",
    ]);
  });

  test("a spec-declared enum survives the pipeline unchanged", async () => {
    const schemas = new Map<string, Buffer>([
      [
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
        Buffer.from(
          JSON.stringify({
            typeName: "AWS::ElasticLoadBalancingV2::LoadBalancer",
            properties: { Scheme: { type: "string", enum: ["internal"] } },
            additionalProperties: false,
          }),
        ),
      ],
    ]);

    const result = await generate({ schemaSource: schemas });

    expect(result.typesDTS).toContain('Scheme?: "internal";');
    expect(result.typesDTS).not.toContain("export type LoadBalancer_Scheme");
    expect(result.warnings.some((w) => w.error.includes("redundant"))).toBe(true);
  });
});
