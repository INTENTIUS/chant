import { describe, test, expect } from "bun:test";
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
});

describe("LexiconOutput.auto", () => {
  test("creates output with auto-generated name from entity and attribute", () => {
    const bucket = new MockResource();
    const result = LexiconOutput.auto(bucket.arn, "dataBucket");

    expect(result).toBeInstanceOf(LexiconOutput);
    expect(result.outputName).toBe("dataBucket_Arn");
    expect(result.sourceLexicon).toBe("testdom");
    expect(result.sourceEntity).toBe("dataBucket");
    expect(result.sourceAttribute).toBe("Arn");
  });

  test("auto-generated name follows {entityName}_{attribute} pattern", () => {
    const bucket = new MockResource();
    const endpointRef = new AttrRef(bucket, "Endpoint");
    const result = LexiconOutput.auto(endpointRef, "myBucket");

    expect(result.outputName).toBe("myBucket_Endpoint");
  });

  test("sets sourceEntity immediately", () => {
    const bucket = new MockResource();
    const result = LexiconOutput.auto(bucket.arn, "logsBucket");

    // sourceEntity should be set right away, not empty
    expect(result.sourceEntity).toBe("logsBucket");
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
});
