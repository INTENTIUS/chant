import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant/declarable";
import { CHILD_PROJECT_MARKER, type ChildProjectInstance } from "@intentius/chant/child-project";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { waw015 } from "./waw015";

function makeChildProject(
  projectPath: string,
  childEntities?: Map<string, Declarable>,
): ChildProjectInstance {
  return {
    [CHILD_PROJECT_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: "AWS::CloudFormation::Stack",
    kind: "resource",
    projectPath,
    logicalName: "Child",
    outputs: {},
    options: {},
    ...(childEntities && {
      buildResult: {
        outputs: new Map(),
        entities: childEntities,
        warnings: [],
        errors: [],
        sourceFileCount: 1,
      },
    }),
  };
}

function makeCtx(entities: Map<string, Declarable>): PostSynthContext {
  return {
    outputs: new Map(),
    entities,
    buildResult: {
      outputs: new Map(),
      entities,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WAW015: Circular Project References", () => {
  test("check metadata", () => {
    expect(waw015.id).toBe("WAW015");
    expect(waw015.description).toContain("Circular");
  });

  test("detects simple two-node cycle (A → B → A)", () => {
    // A's child entities include a child project pointing to B's path
    // B's child entities include a child project pointing to A's path
    const bInA = makeChildProject("/tmp/B");
    const aInB = makeChildProject("/tmp/A");

    const childA = makeChildProject("/tmp/A", new Map<string, Declarable>([
      ["B", bInA],
    ]));
    const childB = makeChildProject("/tmp/B", new Map<string, Declarable>([
      ["A", aInB],
    ]));

    const entities = new Map<string, Declarable>([
      ["A", childA],
      ["B", childB],
    ]);
    const ctx = makeCtx(entities);
    const diags = waw015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW015");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("Circular");
    expect(diags[0].message).toContain("A");
    expect(diags[0].message).toContain("B");
  });

  test("detects three-node cycle (A → B → C → A)", () => {
    const childA = makeChildProject("/tmp/A", new Map<string, Declarable>([
      ["B", makeChildProject("/tmp/B")],
    ]));
    const childB = makeChildProject("/tmp/B", new Map<string, Declarable>([
      ["C", makeChildProject("/tmp/C")],
    ]));
    const childC = makeChildProject("/tmp/C", new Map<string, Declarable>([
      ["A", makeChildProject("/tmp/A")],
    ]));

    const entities = new Map<string, Declarable>([
      ["A", childA],
      ["B", childB],
      ["C", childC],
    ]);
    const ctx = makeCtx(entities);
    const diags = waw015.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("A");
    expect(diags[0].message).toContain("B");
    expect(diags[0].message).toContain("C");
  });

  test("no diagnostic for acyclic graph (A → B, no back-edge)", () => {
    const childA = makeChildProject("/tmp/A", new Map<string, Declarable>([
      ["B", makeChildProject("/tmp/B")],
    ]));
    const childB = makeChildProject("/tmp/B", new Map<string, Declarable>());

    const entities = new Map<string, Declarable>([
      ["A", childA],
      ["B", childB],
    ]);
    const ctx = makeCtx(entities);
    const diags = waw015.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic with fewer than 2 stacks", () => {
    const childA = makeChildProject("/tmp/A", new Map());
    const entities = new Map<string, Declarable>([["A", childA]]);
    const ctx = makeCtx(entities);
    const diags = waw015.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic with no child projects", () => {
    const ctx = makeCtx(new Map());
    const diags = waw015.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("handles child without buildResult (not yet built)", () => {
    // No buildResult means no edges — no cycle possible
    const childA = makeChildProject("/tmp/A");
    const childB = makeChildProject("/tmp/B");
    // These have no buildResult, so deps map will be empty
    const entities = new Map<string, Declarable>([
      ["A", childA],
      ["B", childB],
    ]);
    const ctx = makeCtx(entities);
    const diags = waw015.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
