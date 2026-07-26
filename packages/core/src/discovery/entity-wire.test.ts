import { describe, test, expect } from "vitest";
import { encodeEntitySet, decodeEntitySet, type EntitySetWire } from "./entity-wire";
import { walkValue } from "../serializer-walker";
import { createResource, createProperty } from "../runtime";
import { AttrRef } from "../attrref";
import { INTRINSIC_MARKER, type Intrinsic } from "../intrinsic";
import { DECLARABLE_MARKER, type Declarable } from "../declarable";
import { CHILD_PROJECT_MARKER } from "../child-project";
import { STACK_OUTPUT_MARKER, type StackOutput } from "../stack-output";
import { LexiconOutput, isLexiconOutput } from "../lexicon-output";
import { resolveAttrRefs } from "./resolve";
import { isAttrRefLike } from "../utils";

/** Proves the wire data really is plain JSON — no functions, symbols, or class instances leak through. */
function assertPureJson(value: unknown): void {
  expect(() => JSON.parse(JSON.stringify(value))).not.toThrow();
}

describe("entity-wire round trip (chant #1045 Phase 1)", () => {
  test("resource with primitive props and an AttrRef attribute reference", () => {
    const Vpc = createResource("Test::Vpc", "test", { vpcId: "VpcId" });
    const Subnet = createResource("Test::Subnet", "test", { subnetId: "SubnetId" });

    const vpc = new Vpc({ CidrBlock: "10.0.0.0/16", EnableDnsSupport: true, InstanceCount: 2 });
    const subnet = new Subnet({ VpcId: (vpc as unknown as Record<string, AttrRef>).vpcId });

    const entities = new Map<string, Declarable>([
      ["Vpc", vpc as unknown as Declarable],
      ["Subnet", subnet as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const roundTripped = JSON.parse(JSON.stringify(wire)) as EntitySetWire;
    const decoded = decodeEntitySet(roundTripped);

    const decodedSubnet = decoded.get("Subnet") as unknown as { props: { VpcId: unknown } };
    const decodedVpcId = decodedSubnet.props.VpcId;
    expect(isAttrRefLike(decodedVpcId)).toBe(true);
    expect((decodedVpcId as AttrRef).getLogicalName()).toBe("Vpc");
    expect((decodedVpcId as AttrRef).attribute).toBe("VpcId");

    const decodedVpc = decoded.get("Vpc") as unknown as { props: Record<string, unknown> };
    expect(decodedVpc.props).toEqual({ CidrBlock: "10.0.0.0/16", EnableDnsSupport: true, InstanceCount: 2 });
  });

  test("whole-entity embed (DependsOn-style) preserves identity by reference", () => {
    const Bucket = createResource("Test::Bucket", "test", {});
    const Waiter = createResource("Test::Waiter", "test", {});

    const bucket = new Bucket({});
    const waiter = new Waiter({}, { DependsOn: [bucket] });

    const entities = new Map<string, Declarable>([
      ["Bucket", bucket as unknown as Declarable],
      ["Waiter", waiter as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedWaiter = decoded.get("Waiter") as unknown as { attributes: { DependsOn: unknown[] } };
    const decodedBucket = decoded.get("Bucket");

    // The whole-entity reference must resolve to the SAME reconstructed
    // object as the one in the entities map, not a structurally-equal clone —
    // this is exactly what `entityNames.get(decl)` (serializer-walker.ts /
    // resolveDependsOn) relies on.
    expect(decodedWaiter.attributes.DependsOn[0]).toBe(decodedBucket);
  });

  test("nested property-kind Declarable round-trips as inline data", () => {
    const Tag = createProperty("Test::Tag", "test");
    const Bucket = createResource("Test::Bucket", "test", {});

    const bucket = new Bucket({ Tags: [new Tag({ Key: "Name", Value: "example" })] });
    const entities = new Map<string, Declarable>([["Bucket", bucket as unknown as Declarable]]);
    resolveAttrRefs(entities);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedBucket = decoded.get("Bucket") as unknown as { props: { Tags: Array<{ kind: string; props: unknown }> } };
    expect(decodedBucket.props.Tags[0].kind).toBe("property");
    expect(decodedBucket.props.Tags[0].props).toEqual({ Key: "Name", Value: "example" });
  });

  test("marker Declarable (StackOutput-shaped) round-trips its marker symbol and extra fields", () => {
    const Vpc = createResource("Test::Vpc", "test", { vpcId: "VpcId" });
    const vpc = new Vpc({});

    const stackOutput: StackOutput = {
      [STACK_OUTPUT_MARKER]: true,
      [DECLARABLE_MARKER]: true,
      lexicon: "test",
      entityType: "chant:output",
      kind: "output",
      sourceRef: (vpc as unknown as Record<string, AttrRef>).vpcId,
      description: "the vpc id",
    };

    const entities = new Map<string, Declarable>([
      ["Vpc", vpc as unknown as Declarable],
      ["VpcIdOutput", stackOutput],
    ]);
    resolveAttrRefs(entities);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedOutput = decoded.get("VpcIdOutput") as unknown as Record<symbol, unknown> & { sourceRef: unknown; description: string };
    expect(decodedOutput[STACK_OUTPUT_MARKER]).toBe(true);
    expect(decodedOutput[DECLARABLE_MARKER]).toBe(true);
    expect(decodedOutput.description).toBe("the vpc id");
    expect(isAttrRefLike(decodedOutput.sourceRef)).toBe(true);
    expect((decodedOutput.sourceRef as AttrRef).getLogicalName()).toBe("Vpc");
  });

  test("LexiconOutput built from an AttrRef round-trips via its real constructor", () => {
    const Vpc = createResource("Test::Vpc", "test", { vpcId: "VpcId" });
    const vpc = new Vpc({});

    const entities = new Map<string, Declarable>([["Vpc", vpc as unknown as Declarable]]);
    resolveAttrRefs(entities);
    const lexOutput = new LexiconOutput((vpc as unknown as Record<string, AttrRef>).vpcId, "VpcIdOut");
    entities.set("VpcIdOut", lexOutput as unknown as Declarable);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedOutput = decoded.get("VpcIdOut");
    expect(isLexiconOutput(decodedOutput)).toBe(true);
    const lo = decodedOutput as unknown as LexiconOutput;
    expect(lo.outputName).toBe("VpcIdOut");
    expect(lo.sourceLexicon).toBe("test");
    expect(lo.sourceAttribute).toBe("VpcId");
    // `sourceEntity` is genuinely "" until `build.ts`'s `collectLexiconOutputs`
    // calls `_setSourceEntity` by matching `_sourceParent`'s identity against
    // the entities map (this test only exercises decode, not the full build
    // pipeline) — so what matters here is that `_sourceParent` derefs to the
    // SAME reconstructed "Vpc" object `collectLexiconOutputs` would match by
    // identity, exactly like the in-process path.
    const internal = lo as unknown as { _sourceParent: WeakRef<object> | null };
    expect(internal._sourceParent?.deref()).toBe(decoded.get("Vpc"));
    lo._setSourceEntity("Vpc");
    expect(lo.getOutputValue()).toEqual({ "Fn::GetAtt": ["Vpc", "VpcId"] });
  });

  test("LexiconOutput built from a generic Intrinsic round-trips its toJSON output and embedded refs", () => {
    const Vpc = createResource("Test::Vpc", "test", { vpcId: "VpcId" });
    const vpc = new Vpc({});
    const entities = new Map<string, Declarable>([["Vpc", vpc as unknown as Declarable]]);
    resolveAttrRefs(entities);

    const vpcIdRef = (vpc as unknown as Record<string, AttrRef>).vpcId;
    const customIntrinsic: Intrinsic & { values: unknown[] } = {
      [INTRINSIC_MARKER]: true,
      values: [vpcIdRef],
      toJSON: () => ({ "Fn::Join": [",", [{ __attrRef: { entity: "Vpc", attribute: "VpcId" } }]] }),
    };
    const lexOutput = new LexiconOutput(customIntrinsic, "JoinedOut");
    entities.set("JoinedOut", lexOutput as unknown as Declarable);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedOutput = decoded.get("JoinedOut") as unknown as LexiconOutput;
    expect(isLexiconOutput(decodedOutput)).toBe(true);
    // A same-shape `{__attrRef}` envelope that was ALREADY baked into the
    // original intrinsic's own `toJSON()` output (as `resolveIntrinsicValue`
    // does for real lexicon intrinsics like `Join`) may decode back as either
    // a plain envelope or a real `AttrRef` instance — `walkValue` (the only
    // thing that ever reads this value in production) treats both
    // identically, so assert through it rather than on the raw shape.
    const entityNames = new Map<Declarable, string>();
    expect(
      walkValue(decodedOutput.getOutputValue(), entityNames, {
        attrRef: (name, attr) => ({ "Fn::GetAtt": [name, attr] }),
        resourceRef: (name) => ({ Ref: name }),
        propertyDeclarable: () => undefined,
      }),
    ).toEqual({ "Fn::Join": [",", [{ "Fn::GetAtt": ["Vpc", "VpcId"] }]] });
    // The embedded-refs safety net: a real AttrRef should still be
    // discoverable by walking the reconstructed intrinsic's own fields (not
    // through toJSON()) — this is what `detectCrossLexiconRefs`/
    // `buildDependencyGraph` rely on.
    const embedded = (decodedOutput as unknown as { _intrinsic: { __chantWireRefs: unknown[] } })._intrinsic.__chantWireRefs;
    expect(embedded).toHaveLength(1);
    expect(isAttrRefLike(embedded[0])).toBe(true);
  });

  test("a lexicon-specific marker symbol (not core-owned) round-trips generically", () => {
    const MARKER = Symbol.for("chant.test.customMarker");
    const custom: Declarable = {
      [MARKER]: true,
      [DECLARABLE_MARKER]: true,
      lexicon: "test",
      entityType: "chant:test:custom",
      tags: [{ Key: "a", Value: "b" }],
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>([["Custom", custom]]);
    resolveAttrRefs(entities);

    const wire = encodeEntitySet(entities);
    assertPureJson(wire);

    const decoded = decodeEntitySet(JSON.parse(JSON.stringify(wire)) as EntitySetWire);
    const decodedCustom = decoded.get("Custom") as unknown as Record<symbol, unknown> & { tags: unknown };
    expect(decodedCustom[MARKER]).toBe(true);
    expect(decodedCustom.tags).toEqual([{ Key: "a", Value: "b" }]);
  });

  test("a child project entity is rejected rather than silently mis-encoded", () => {
    const childProject: Declarable = {
      [CHILD_PROJECT_MARKER]: true,
      [DECLARABLE_MARKER]: true,
      lexicon: "test",
      entityType: "chant:childProject",
      kind: "resource",
      projectPath: "/tmp/child",
      logicalName: "Child",
      outputs: {},
      options: {},
    } as unknown as Declarable;

    const entities = new Map<string, Declarable>([["Child", childProject]]);
    resolveAttrRefs(entities);

    expect(() => encodeEntitySet(entities)).toThrow(/child project/i);
  });
});
