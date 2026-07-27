import { describe, test, expect, vi } from "vitest";
import { LexiconOutput, output, isLexiconOutput } from "./lexicon-output";
import { AttrRef } from "./attrref";
import { INTRINSIC_MARKER } from "./intrinsic";
import { DECLARABLE_MARKER } from "./declarable";
import { collectLexiconOutputs } from "./build";
import type { Declarable } from "./declarable";

// Mock entity with lexicon field
class MockResource {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "testdom";
  readonly entityType = "TestDom::Storage::Bucket";
  readonly arn: AttrRef;
  readonly props: Record<string, unknown>;

  constructor() {
    this.arn = new AttrRef(this, "Arn");
    this.props = {};
  }
}

describe("LexiconOutput", () => {
  test("implements Intrinsic marker", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(lexiconOutput[INTRINSIC_MARKER]).toBe(true);
  });

  test("extracts sourceLexicon from parent entity", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(lexiconOutput.sourceLexicon).toBe("testdom");
  });

  test("extracts sourceAttribute from AttrRef", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(lexiconOutput.sourceAttribute).toBe("Arn");
  });

  test("stores outputName", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(lexiconOutput.outputName).toBe("DataBucketArn");
  });

  test("sourceEntity starts empty and can be set internally", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(lexiconOutput.sourceEntity).toBe("");
    lexiconOutput._setSourceEntity("dataBucket");
    expect(lexiconOutput.sourceEntity).toBe("dataBucket");
  });

  test("toJSON serializes to chant::output marker", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(lexiconOutput.toJSON()).toEqual({ "chant::output": "DataBucketArn" });
  });

  test("throws when parent has no lexicon field", () => {
    const noLexiconParent = {};
    const ref = new AttrRef(noLexiconParent, "Arn");

    expect(() => new LexiconOutput(ref, "Test")).toThrow("no lexicon field");
  });

  test("accepts an Intrinsic and sets sourceAttribute to null", () => {
    const mockIntrinsic = { [INTRINSIC_MARKER]: true as const, toJSON: () => ({ "Fn::Sub": "hello" }) };
    const lo = new LexiconOutput(mockIntrinsic, "MyOutput");
    expect(lo.sourceAttribute).toBeNull();
    expect(lo.sourceLexicon).toBe("");
    expect(lo.outputName).toBe("MyOutput");
  });

  test("getOutputValue() returns Fn::GetAtt for AttrRef-based output", () => {
    const bucket = new MockResource();
    const lo = new LexiconOutput(bucket.arn, "BucketArn");
    lo._setSourceEntity("myBucket");
    expect(lo.getOutputValue()).toEqual({ "Fn::GetAtt": ["myBucket", "Arn"] });
  });

  // chant #1137 — the constructor used to check `ref instanceof AttrRef`,
  // which returns false for an AttrRef built by a SEPARATELY-LOADED copy of
  // `./attrref` (the same dual-npm-copy hazard #1122 fixed for
  // `isLexiconOutput` itself). Because AttrRef also implements Intrinsic,
  // the miss was not loud: a foreign AttrRef fell into the `isIntrinsic(ref)`
  // branch instead, stored as `_intrinsic` rather than recognized as an
  // AttrRef-sourced output — so `getOutputValue()` called the foreign
  // AttrRef's own `toJSON()` (the `{__attrRef}` wire envelope) instead of
  // emitting `Fn::GetAtt`, a broken Output with no error at synth time.
  // `vi.resetModules()` + a fresh dynamic import reproduces the split
  // module graph exactly.
  test("recognizes an AttrRef built by a second, separately-loaded copy of AttrRef", async () => {
    const bucket = new MockResource();

    vi.resetModules();
    const secondCopy = await import("./attrref");
    expect(secondCopy.AttrRef).not.toBe(AttrRef);

    const foreignRef = new secondCopy.AttrRef(bucket, "Arn");

    // The historic bug: instanceof fails across separately-loaded copies of
    // chant-core, even though the two classes are structurally identical.
    expect(foreignRef instanceof AttrRef).toBe(false);

    const lo = new LexiconOutput(foreignRef, "BucketArn");
    lo._setSourceEntity("myBucket");

    // The fix: recognized as AttrRef-sourced, not misfiled as a generic
    // Intrinsic — sourceAttribute is set and getOutputValue() emits a real
    // Fn::GetAtt, not the foreign AttrRef's own wire-envelope toJSON().
    expect(lo.sourceLexicon).toBe("testdom");
    expect(lo.sourceAttribute).toBe("Arn");
    expect(lo.getOutputValue()).toEqual({ "Fn::GetAtt": ["myBucket", "Arn"] });
    vi.resetModules();
  });

  test("getOutputValue() returns intrinsic toJSON for Intrinsic-based output", () => {
    const mockIntrinsic = { [INTRINSIC_MARKER]: true as const, toJSON: () => ({ "Fn::Sub": "http://${Param}/path" }) };
    const lo = new LexiconOutput(mockIntrinsic, "MyUrl");
    expect(lo.getOutputValue()).toEqual({ "Fn::Sub": "http://${Param}/path" });
  });

  // chant #1121 — an already-resolved plain value (not a reference to
  // anything) must be emitted verbatim as the Output's Value, never coerced
  // into a bogus Fn::GetAtt pointing at the output's own logical id.
  describe("literal-valued output (chant #1121)", () => {
    test("accepts a string literal and sets no source entity/attribute", () => {
      const lo = new LexiconOutput("us-east-1", "Region");
      expect(lo.sourceLexicon).toBe("");
      expect(lo.sourceEntity).toBe("");
      expect(lo.sourceAttribute).toBeNull();
      expect(lo.outputName).toBe("Region");
    });

    test("getOutputValue() returns a string literal verbatim", () => {
      const lo = new LexiconOutput("fold-output-repro", "oParamName");
      expect(lo.getOutputValue()).toBe("fold-output-repro");
    });

    test("getOutputValue() returns a number literal verbatim", () => {
      const lo = new LexiconOutput(42, "oCount");
      expect(lo.getOutputValue()).toBe(42);
    });

    test("getOutputValue() returns a boolean literal verbatim (including false)", () => {
      expect(new LexiconOutput(true, "oEnabled").getOutputValue()).toBe(true);
      expect(new LexiconOutput(false, "oDisabled").getOutputValue()).toBe(false);
    });

    test("getOutputValue() returns 0 and empty string verbatim (falsy but valid)", () => {
      expect(new LexiconOutput(0, "oZero").getOutputValue()).toBe(0);
      expect(new LexiconOutput("", "oEmpty").getOutputValue()).toBe("");
    });

    test("_setSourceEntity has no effect on getOutputValue() for a literal", () => {
      const lo = new LexiconOutput("v1", "oVersion");
      lo._setSourceEntity("someUnrelatedEntity");
      expect(lo.getOutputValue()).toBe("v1");
    });

    test("throws for a ref that is neither an AttrRef, an Intrinsic, nor a string/number/boolean literal", () => {
      // Mirrors what a resource member access that resolves to `undefined`
      // looks like at runtime (e.g. a typo, or a non-attribute field a
      // generated resource class never echoes onto the instance).
      expect(() => new LexiconOutput(undefined as unknown as string, "oBroken")).toThrow(
        /must be an AttrRef, an Intrinsic, or an already-resolved string\/number\/boolean/,
      );
    });

    test("throws for null", () => {
      expect(() => new LexiconOutput(null as unknown as string, "oBroken")).toThrow(
        /must be an AttrRef, an Intrinsic, or an already-resolved string\/number\/boolean/,
      );
    });
  });
});

describe("LexiconOutput.auto", () => {
  test("creates output with auto-generated name from entity and attribute", () => {
    const bucket = new MockResource();
    const result = LexiconOutput.auto(bucket.arn, "dataBucket");

    expect(result).toBeInstanceOf(LexiconOutput);
    expect(result.outputName).toBe("dataBucketArn");
    expect(result.sourceLexicon).toBe("testdom");
    expect(result.sourceEntity).toBe("dataBucket");
    expect(result.sourceAttribute).toBe("Arn");
  });

  test("auto-generated name follows {entityName}{Attribute} camelCase pattern", () => {
    const bucket = new MockResource();
    const endpointRef = new AttrRef(bucket, "Endpoint");
    const result = LexiconOutput.auto(endpointRef, "myBucket");

    expect(result.outputName).toBe("myBucketEndpoint");
  });

  test("sets sourceEntity immediately", () => {
    const bucket = new MockResource();
    const result = LexiconOutput.auto(bucket.arn, "logsBucket");

    // sourceEntity should be set right away, not empty
    expect(result.sourceEntity).toBe("logsBucket");
  });

  // chant#930 — CFN logical ids (including Outputs keys) must be alphanumeric
  // only. A nested Fn::GetAtt attribute path (dots) must not leak through.
  test("sanitizes dotted nested-attribute paths to a valid CFN logical id", () => {
    const bucket = new MockResource();
    const nestedRef = new AttrRef(
      bucket,
      "MetadataConfiguration.AnnotationTableConfiguration.TableArn"
    );
    const result = LexiconOutput.auto(nestedRef, "foundationArtifactBucket");

    expect(result.outputName).toMatch(/^[A-Za-z0-9]+$/);
    expect(result.outputName).toBe(
      "foundationArtifactBucketMetadataConfigurationAnnotationTableConfigurationTableArn"
    );
  });

  test("auto-generated output names are always valid CFN logical ids", () => {
    const bucket = new MockResource();
    const cases: Array<[string, string]> = [
      ["dataBucket", "Arn"],
      ["my-bucket_2", "Some.Nested.Attr"],
      ["logsBucket", "Endpoint.Hostname"],
    ];

    for (const [entityName, attribute] of cases) {
      const ref = new AttrRef(bucket, attribute);
      const result = LexiconOutput.auto(ref, entityName);
      expect(result.outputName).toMatch(/^[A-Za-z0-9]+$/);
    }
  });
});

describe("output() helper", () => {
  test("creates LexiconOutput from AttrRef and name", () => {
    const bucket = new MockResource();
    const result = output(bucket.arn, "DataBucketArn");

    expect(result).toBeInstanceOf(LexiconOutput);
    expect(result.sourceLexicon).toBe("testdom");
    expect(result.sourceAttribute).toBe("Arn");
    expect(result.outputName).toBe("DataBucketArn");
  });

  // chant #1121
  test.each([
    ["string", "v1"],
    ["number", 42],
    ["boolean", true],
  ] as const)("creates a literal-valued LexiconOutput from a %s and emits it verbatim", (_kind, value) => {
    const result = output(value, "oLiteral");

    expect(result).toBeInstanceOf(LexiconOutput);
    expect(result.sourceEntity).toBe("");
    expect(result.sourceAttribute).toBeNull();
    expect(result.getOutputValue()).toBe(value);
  });
});

describe("isLexiconOutput", () => {
  test("returns true for LexiconOutput instances", () => {
    const bucket = new MockResource();
    const lexiconOutput = new LexiconOutput(bucket.arn, "DataBucketArn");

    expect(isLexiconOutput(lexiconOutput)).toBe(true);
  });

  test("returns false for non-LexiconOutput values", () => {
    expect(isLexiconOutput(null)).toBe(false);
    expect(isLexiconOutput(undefined)).toBe(false);
    expect(isLexiconOutput("string")).toBe(false);
    expect(isLexiconOutput(42)).toBe(false);
    expect(isLexiconOutput({})).toBe(false);
  });

  test("returns false for AttrRef", () => {
    const parent = { lexicon: "testdom" };
    const ref = new AttrRef(parent, "Arn");

    expect(isLexiconOutput(ref)).toBe(false);
  });

  // chant #1122 — the guard used to be `value instanceof LexiconOutput`,
  // which returns false when the value was built by a SEPARATELY-LOADED
  // copy of this module (a plain npm-dedupe outcome: a lexicon pinned to a
  // chant range that doesn't overlap the project's own gets its own nested
  // `node_modules/@intentius/chant`). `vi.resetModules()` + a fresh dynamic
  // import reproduces that split module graph exactly, without needing an
  // actual second install on disk — the resulting instance is structurally
  // and behaviorally identical to a real LexiconOutput, just built from a
  // distinct `LexiconOutput` class object.
  test("recognizes a LexiconOutput built by a second, separately-loaded copy of this module", async () => {
    vi.resetModules();
    const secondCopy = await import("./lexicon-output");

    // Sanity check that this really is a distinct module instance — the
    // premise the rest of the test depends on.
    expect(secondCopy.LexiconOutput).not.toBe(LexiconOutput);

    const second = new secondCopy.LexiconOutput("v2", "oFromSecondCopy");

    // The historic bug: instanceof fails across separately-loaded copies of
    // chant-core, even though the two classes are structurally identical.
    expect(second instanceof LexiconOutput).toBe(false);

    // The fix: a Symbol.for global marker holds across copies the way
    // DECLARABLE_MARKER/INTRINSIC_MARKER/STACK_OUTPUT_MARKER already do —
    // isLexiconOutput (from EITHER copy) recognizes the other copy's output.
    expect(isLexiconOutput(second)).toBe(true);
    expect(secondCopy.isLexiconOutput(second)).toBe(true);

    // And the callers that gate on this guard only ever read own-prototype
    // members that survive the cross-copy split.
    expect(second.getOutputValue()).toBe("v2");
    vi.resetModules();
  });
});

describe("collectLexiconOutputs", () => {
  test("collects LexiconOutputs from entity props", () => {
    const bucket = new MockResource();
    const lexiconOutput = output(bucket.arn, "DataBucketArn");
    bucket.props.outputRef = lexiconOutput;

    const entities = new Map<string, Declarable>();
    entities.set("dataBucket", bucket as unknown as Declarable);

    const collected = collectLexiconOutputs(entities);

    expect(collected).toHaveLength(1);
    expect(collected[0].outputName).toBe("DataBucketArn");
    expect(collected[0].sourceEntity).toBe("dataBucket");
  });

  test("returns empty array when no LexiconOutputs found", () => {
    const entities = new Map<string, Declarable>();
    entities.set("bucket", {
      lexicon: "testdom",
      entityType: "TestDom::Storage::Bucket",
      [DECLARABLE_MARKER]: true,
    } as Declarable);

    const collected = collectLexiconOutputs(entities);
    expect(collected).toHaveLength(0);
  });

  test("collects LexiconOutputs from nested props", () => {
    const bucket = new MockResource();
    const lexiconOutput = output(bucket.arn, "BucketArn");
    bucket.props.nested = { deep: { ref: lexiconOutput } };

    const entities = new Map<string, Declarable>();
    entities.set("dataBucket", bucket as unknown as Declarable);

    const collected = collectLexiconOutputs(entities);

    expect(collected).toHaveLength(1);
    expect(collected[0].outputName).toBe("BucketArn");
  });

  // chant #1121 — a literal-valued output has no source entity. Before this
  // fix, a top-level `export const x = output("literal", "x")` fell back to
  // naming the output's OWN map key as its "source entity" (there being no
  // `_sourceParent` to resolve), which `getOutputValue()`'s `Fn::GetAtt`
  // fallback then read back out as a self-referencing, invalid reference.
  test("does NOT fall back to the output's own key as sourceEntity for a literal-valued output", () => {
    const literalOutput = output("fold-output-repro", "oParamName");

    const entities = new Map<string, Declarable>();
    entities.set("oParamName", literalOutput as unknown as Declarable);

    const collected = collectLexiconOutputs(entities);

    expect(collected).toHaveLength(1);
    expect(collected[0].sourceEntity).toBe("");
    expect(collected[0].getOutputValue()).toBe("fold-output-repro");
  });

  test("does NOT fall back to the containing entity's name for a literal-valued output nested in props", () => {
    const bucket = new MockResource();
    const literalOutput = output(123, "oNested");
    bucket.props.nested = literalOutput;

    const entities = new Map<string, Declarable>();
    entities.set("dataBucket", bucket as unknown as Declarable);

    const collected = collectLexiconOutputs(entities);

    expect(collected).toHaveLength(1);
    expect(collected[0].sourceEntity).toBe("");
    expect(collected[0].getOutputValue()).toBe(123);
  });
});
