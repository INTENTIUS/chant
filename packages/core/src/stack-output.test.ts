import { describe, test, expect, vi } from "vitest";
import { stackOutput, isStackOutput, STACK_OUTPUT_MARKER } from "./stack-output";
import { AttrRef } from "./attrref";
import { INTRINSIC_MARKER } from "./intrinsic";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";

const vpc: Declarable = {
  lexicon: "aws",
  entityType: "AWS::EC2::VPC",
  [DECLARABLE_MARKER]: true,
};

describe("stackOutput", () => {
  test("wraps a bare AttrRef and derives lexicon from its parent", () => {
    const ref = new AttrRef(vpc, "VpcId");
    const out = stackOutput(ref);

    expect(out[STACK_OUTPUT_MARKER]).toBe(true);
    expect(out[DECLARABLE_MARKER]).toBe(true);
    expect(out.lexicon).toBe("aws");
    expect(out.kind).toBe("output");
    expect(out.sourceRef).toBe(ref);
  });

  test("wraps an intrinsic nesting an AttrRef and borrows the AttrRef's lexicon", () => {
    const ref = new AttrRef(vpc, "VpcId");
    const join = {
      [INTRINSIC_MARKER]: true as const,
      values: [ref, "-suffix"],
      toJSON: () => ({ "Fn::Join": ["", ["VpcId", "-suffix"]] }),
    };

    const out = stackOutput(join);
    expect(out.lexicon).toBe("aws");
    expect(out.sourceRef).toBe(join);
  });

  test("records an optional description", () => {
    const ref = new AttrRef(vpc, "VpcId");
    const out = stackOutput(ref, { description: "Primary VPC id" });
    expect(out.description).toBe("Primary VPC id");
  });

  test("throws for a value that is neither AttrRef-like nor an Intrinsic", () => {
    expect(() => stackOutput("not-a-ref" as unknown as AttrRef)).toThrow(
      "stackOutput(ref): ref must be an attribute reference or an intrinsic wrapping one",
    );
  });

  test("falls back to lexicon 'unknown' when the anchor's parent has no lexicon field", () => {
    const ref = new AttrRef({}, "attr");
    const out = stackOutput(ref);
    expect(out.lexicon).toBe("unknown");
  });

  // chant #1137 — `stackOutput()` used to check `ref instanceof AttrRef` (in
  // both its input validation and its lexicon-deriving anchor selection),
  // which returns false for an AttrRef built by a SEPARATELY-LOADED copy of
  // `./attrref` (the same dual-npm-copy hazard #1122 fixed for
  // `LexiconOutput`). `firstAttrRef` had the same raw `instanceof` check, so
  // even the "wrapped in an intrinsic" fallback path missed a foreign
  // AttrRef too. Before the fix, a foreign-copy AttrRef silently anchored on
  // nothing and the output's `lexicon` field became `"unknown"` instead of
  // the real producing lexicon — no error, just a wrong value.
  // `vi.resetModules()` + a fresh dynamic import reproduces the split module
  // graph exactly.
  test("derives lexicon from a bare AttrRef built by a second, separately-loaded copy", async () => {
    vi.resetModules();
    const secondCopy = await import("./attrref");
    expect(secondCopy.AttrRef).not.toBe(AttrRef);

    const foreignRef = new secondCopy.AttrRef(vpc, "VpcId");

    // The historic bug: instanceof fails across separately-loaded copies of
    // chant-core, even though the two classes are structurally identical.
    expect(foreignRef instanceof AttrRef).toBe(false);

    const out = stackOutput(foreignRef);
    expect(out.lexicon).toBe("aws");
    expect(out.sourceRef).toBe(foreignRef);
    vi.resetModules();
  });

  test("derives lexicon from a foreign-copy AttrRef nested inside an intrinsic", async () => {
    vi.resetModules();
    const secondCopy = await import("./attrref");
    const foreignRef = new secondCopy.AttrRef(vpc, "VpcId");
    expect(foreignRef instanceof AttrRef).toBe(false);

    const join = {
      [INTRINSIC_MARKER]: true as const,
      values: [foreignRef, "-suffix"],
      toJSON: () => ({ "Fn::Join": ["", ["VpcId", "-suffix"]] }),
    };

    const out = stackOutput(join);
    expect(out.lexicon).toBe("aws");
    vi.resetModules();
  });
});

describe("isStackOutput", () => {
  test("returns true for a StackOutput", () => {
    const ref = new AttrRef(vpc, "VpcId");
    expect(isStackOutput(stackOutput(ref))).toBe(true);
  });

  test("returns false for a plain AttrRef", () => {
    const ref = new AttrRef(vpc, "VpcId");
    expect(isStackOutput(ref)).toBe(false);
  });

  test("returns false for null/primitives", () => {
    expect(isStackOutput(null)).toBe(false);
    expect(isStackOutput("x")).toBe(false);
    expect(isStackOutput(42)).toBe(false);
  });
});
