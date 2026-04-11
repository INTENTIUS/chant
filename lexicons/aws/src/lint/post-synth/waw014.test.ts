import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant/declarable";
import { CHILD_PROJECT_MARKER, type ChildProjectInstance } from "@intentius/chant/child-project";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { waw014 } from "./waw014";

function makeChildProject(projectPath = "/tmp/child"): ChildProjectInstance {
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
  };
}

function makeCtx(
  entities: Map<string, Declarable>,
  templateJson: string,
): PostSynthContext {
  const outputs = new Map<string, string>([["aws", templateJson]]);
  return {
    outputs,
    entities,
    buildResult: {
      outputs,
      entities,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WAW014: Unreferenced Nested Stack Outputs", () => {
  test("check metadata", () => {
    expect(waw014.id).toBe("WAW014");
    expect(waw014.description).toContain("outputs");
  });

  test("flags child whose outputs are never referenced in parent template", () => {
    const entities = new Map<string, Declarable>([
      ["Network", makeChildProject()],
    ]);
    // Parent template doesn't reference Network via Fn::GetAtt
    const template = JSON.stringify({
      Resources: {
        Network: {
          Type: "AWS::CloudFormation::Stack",
          Properties: { TemplateURL: "network.json" },
        },
      },
    });
    const ctx = makeCtx(entities, template);
    const diags = waw014.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WAW014");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("Network");
    expect(diags[0].message).toContain("never referenced");
    expect(diags[0].entity).toBe("Network");
  });

  test("no diagnostic when child outputs are referenced via Fn::GetAtt", () => {
    const entities = new Map<string, Declarable>([
      ["Network", makeChildProject()],
    ]);
    const template = JSON.stringify({
      Resources: {
        Network: {
          Type: "AWS::CloudFormation::Stack",
          Properties: { TemplateURL: "network.json" },
        },
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: {
            VpcConfig: {
              SubnetIds: [{ "Fn::GetAtt": ["Network", "Outputs.SubnetId"] }],
            },
          },
        },
      },
    });
    const ctx = makeCtx(entities, template);
    const diags = waw014.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("no diagnostic when no child projects", () => {
    const ctx = makeCtx(new Map(), JSON.stringify({ Resources: {} }));
    const diags = waw014.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags only unreferenced children, not referenced ones", () => {
    const entities = new Map<string, Declarable>([
      ["Network", makeChildProject("/tmp/net")],
      ["Database", makeChildProject("/tmp/db")],
    ]);
    // Only Network is referenced
    const template = JSON.stringify({
      Resources: {
        MyFunc: {
          Type: "AWS::Lambda::Function",
          Properties: {
            SubnetId: { "Fn::GetAtt": ["Network", "Outputs.SubnetId"] },
          },
        },
      },
    });
    const ctx = makeCtx(entities, template);
    const diags = waw014.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("Database");
  });
});
