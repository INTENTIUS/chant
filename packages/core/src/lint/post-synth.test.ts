import { describe, test, expect } from "bun:test";
import { runPostSynthChecks } from "./post-synth";
import type { PostSynthCheck, PostSynthContext } from "./post-synth";

function createBuildResult(overrides: Partial<PostSynthContext["buildResult"]> = {}) {
  return {
    outputs: new Map<string, string>(),
    entities: new Map(),
    warnings: [] as string[],
    errors: [] as Array<{ message: string; name: string }>,
    sourceFileCount: 0,
    ...overrides,
  };
}

describe("post-synth checks", () => {
  test("runs check and collects diagnostics", () => {
    const check: PostSynthCheck = {
      id: "PS001",
      description: "Check for empty outputs",
      check(ctx) {
        if (ctx.outputs.size === 0) {
          return [{ checkId: "PS001", severity: "warning", message: "No outputs produced" }];
        }
        return [];
      },
    };

    const result = createBuildResult();
    const diags = runPostSynthChecks([check], result);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("PS001");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toBe("No outputs produced");
  });

  test("returns empty when no issues found", () => {
    const check: PostSynthCheck = {
      id: "PS002",
      description: "Always passes",
      check() {
        return [];
      },
    };

    const diags = runPostSynthChecks([check], createBuildResult());
    expect(diags).toHaveLength(0);
  });

  test("aggregates diagnostics from multiple checks", () => {
    const checks: PostSynthCheck[] = [
      {
        id: "PS003A",
        description: "Check A",
        check() {
          return [{ checkId: "PS003A", severity: "error", message: "Error A" }];
        },
      },
      {
        id: "PS003B",
        description: "Check B",
        check() {
          return [
            { checkId: "PS003B", severity: "warning", message: "Warning B1" },
            { checkId: "PS003B", severity: "info", message: "Info B2" },
          ];
        },
      },
    ];

    const diags = runPostSynthChecks(checks, createBuildResult());
    expect(diags).toHaveLength(3);
    expect(diags[0].checkId).toBe("PS003A");
    expect(diags[1].checkId).toBe("PS003B");
    expect(diags[2].checkId).toBe("PS003B");
  });

  test("provides entities and outputs in context", () => {
    const entities = new Map([["myBucket", { kind: "resource" }]]);
    const outputs = new Map([["aws", '{"AWSTemplateFormatVersion":"2010-09-09"}']]);

    const check: PostSynthCheck = {
      id: "PS004",
      description: "Check entities",
      check(ctx) {
        const diags = [];
        for (const [name] of ctx.entities) {
          diags.push({
            checkId: "PS004",
            severity: "info" as const,
            message: `Found entity: ${name}`,
            entity: name,
            lexicon: "aws",
          });
        }
        return diags;
      },
    };

    const diags = runPostSynthChecks(
      [check],
      createBuildResult({ entities: entities as never, outputs }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("myBucket");
    expect(diags[0].lexicon).toBe("aws");
  });

  test("handles empty check list", () => {
    const diags = runPostSynthChecks([], createBuildResult());
    expect(diags).toHaveLength(0);
  });
});
