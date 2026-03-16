import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant/declarable";
import { CHILD_PROJECT_MARKER, type ChildProjectInstance } from "@intentius/chant/child-project";
import { STACK_OUTPUT_MARKER, type StackOutput } from "@intentius/chant/stack-output";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { waw013 } from "./waw013";

function makeStackOutput(): StackOutput {
  return {
    [STACK_OUTPUT_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: "chant:output",
    kind: "output",
    sourceRef: {} as any,
  };
}

function makeChildProject(opts: {
  projectPath?: string;
  childEntities?: Map<string, Declarable>;
}): ChildProjectInstance {
  return {
    [CHILD_PROJECT_MARKER]: true,
    [DECLARABLE_MARKER]: true,
    lexicon: "aws",
    entityType: "AWS::CloudFormation::Stack",
    kind: "resource",
    projectPath: opts.projectPath ?? "/tmp/child",
    logicalName: "Child",
    outputs: {},
    options: {},
    buildResult: {
      outputs: new Map(),
      entities: opts.childEntities ?? new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
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

describe("WAW013: Child project has no stackOutput() exports", () => {
  test("check metadata", () => {
    expect(waw013.id).toBe("WAW013");
    expect(waw013.description).toContain("stackOutput");
  });

  test("flags child project with no outputs", () => {
    const child = makeChildProject({ childEntities: new Map() });
    const ctx = makeCtx(new Map([["Network", child]]));
    const diags = waw013.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW013");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("Network");
    expect(diags[0].message).toContain("no stackOutput()");
    expect(diags[0].entity).toBe("Network");
  });

  test("no diagnostic when child has stackOutput", () => {
    const childEntities = new Map<string, Declarable>([
      ["subnetId", makeStackOutput()],
    ]);
    const child = makeChildProject({ childEntities });
    const ctx = makeCtx(new Map([["Network", child]]));
    const diags = waw013.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic when no child projects", () => {
    const ctx = makeCtx(new Map());
    const diags = waw013.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("only flags children without outputs, not those with", () => {
    const goodChild = makeChildProject({
      projectPath: "/tmp/good",
      childEntities: new Map([["out", makeStackOutput()]]),
    });
    const badChild = makeChildProject({
      projectPath: "/tmp/bad",
      childEntities: new Map(),
    });
    const ctx = makeCtx(new Map<string, Declarable>([
      ["Good", goodChild],
      ["Bad", badChild],
    ]));
    const diags = waw013.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("Bad");
  });

  test("skips non-child-project entities", () => {
    const plainEntity: Declarable = {
      [DECLARABLE_MARKER]: true,
      lexicon: "aws",
      entityType: "AWS::S3::Bucket",
    };
    const ctx = makeCtx(new Map([["MyBucket", plainEntity]]));
    const diags = waw013.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
