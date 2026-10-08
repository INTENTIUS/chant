import { describe, test, expect } from "vitest";
import { Mapping, isMapping, MAPPING_ENTITY_TYPE } from "./mapping";
import { FindInMap, Ref } from "./intrinsics";
import { AWS } from "./pseudo";
import { Parameter } from "./parameter";
import { awsSerializer } from "./serializer";
import { createResource } from "@intentius/chant/runtime";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import type { Declarable } from "@intentius/chant/declarable";

const Subnet = createResource("AWS::EC2::Subnet", "aws", {});

function serialize(entities: Map<string, Declarable>): Record<string, any> {
  resolveAttrRefs(entities);
  return JSON.parse(awsSerializer.serialize(entities) as string);
}

describe("Mapping and FindInMap", () => {
  test("a Mapping is lifted into Mappings and FindInMap reads it by name", () => {
    const regionMap = new Mapping({ "us-east-1": { AZs: ["us-east-1a", "us-east-1b"] } });
    const env = new Parameter("String");
    const subnet = new Subnet({
      AvailabilityZone: FindInMap(regionMap, AWS.Region, "AZs"),
      Tag: FindInMap("Other", Ref(env), "Key"),
    });
    const template = serialize(
      new Map<string, Declarable>([
        ["RegionMap", regionMap],
        ["Env", env],
        ["Subnet", subnet],
      ]),
    );
    expect(template.Mappings).toEqual({ RegionMap: { "us-east-1": { AZs: ["us-east-1a", "us-east-1b"] } } });
    expect(template.Resources.Subnet.Properties.AvailabilityZone).toEqual({
      "Fn::FindInMap": ["RegionMap", { Ref: "AWS::Region" }, "AZs"],
    });
    expect(template.Resources.Subnet.Properties.Tag).toEqual({ "Fn::FindInMap": ["Other", { Ref: "Env" }, "Key"] });
  });

  test("a Mapping's name option is its key in Mappings and in FindInMap", () => {
    const map = new Mapping({ a: { b: "c" } }, { name: "Shared" });
    const subnet = new Subnet({ Tag: FindInMap(map, "a", "b") });
    const template = serialize(new Map<string, Declarable>([["SharedMapping", map], ["Subnet", subnet]]));
    expect(Object.keys(template.Mappings)).toEqual(["Shared"]);
    expect(template.Resources.Subnet.Properties.Tag).toEqual({ "Fn::FindInMap": ["Shared", "a", "b"] });
  });

  test("isMapping and the entity type", () => {
    const map = new Mapping({});
    expect(map.entityType).toBe(MAPPING_ENTITY_TYPE);
    expect(isMapping(map)).toBe(true);
    expect(isMapping(new Parameter("String"))).toBe(false);
    expect(() => new Mapping([] as never)).toThrow(/map must be an object/);
  });
});

describe("an import envelope in the template", () => {
  test("fails the build instead of being written as CloudFormation", () => {
    const subnet = new Subnet({ AvailabilityZone: { __intrinsic: "FindInMap", mapName: "RegionMap", firstKey: "a", secondKey: "b" } });
    expect(() => serialize(new Map<string, Declarable>([["Subnet", subnet]]))).toThrow(
      /Resources\.Subnet\.Properties\.AvailabilityZone: \{ __intrinsic: "FindInMap" \} is an import envelope/,
    );
  });
});
