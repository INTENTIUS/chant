import { describe, test, expect } from "vitest";
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

describe("environment-aware checks (#201)", () => {
  // A policy that only fires in prod — the new env-branching primitive.
  const prodOnly: PostSynthCheck = {
    id: "ENV-PROD",
    description: "fires only in prod",
    check(ctx) {
      return ctx.env === "prod"
        ? [{ checkId: "ENV-PROD", severity: "error", message: "blocked in prod" }]
        : [];
    },
  };

  test("env is threaded into the context", () => {
    expect(runPostSynthChecks([prodOnly], createBuildResult(), "prod")).toHaveLength(1);
    expect(runPostSynthChecks([prodOnly], createBuildResult(), "dev")).toHaveLength(0);
    expect(runPostSynthChecks([prodOnly], createBuildResult())).toHaveLength(0); // env undefined
  });
});

describe("isPostSynthCheck", () => {
  test("accepts a well-formed check and rejects others", async () => {
    const { isPostSynthCheck } = await import("./post-synth");
    expect(isPostSynthCheck({ id: "X", description: "d", check: () => [] })).toBe(true);
    expect(isPostSynthCheck({ id: "X", description: "d" })).toBe(false); // no check fn
    expect(isPostSynthCheck({ check: () => [] })).toBe(false); // no id/description
    expect(isPostSynthCheck(null)).toBe(false);
    expect(isPostSynthCheck("nope")).toBe(false);
  });
});

// chant #1138 — `applyConfiguredSeverity` (the `lint.rules` severity-override
// pass over `PostSynthDiagnostic`s) is tested in `./config.test.ts`, where the
// function itself now lives — see `./config.ts`'s doc comment for why.

// ── chant #975 — ctx.docs: lazy, memoized, shared across every check ───────
describe("ctx.docs (chant #975)", () => {
  /** A Map subclass that counts how many times it was iterated — the only
   *  way `parseOutputDocs` reads its outputs — so the tests below can prove
   *  "parsed once" without reaching into module internals. */
  class CountingOutputs extends Map<string, string> {
    iterations = 0;
    [Symbol.iterator](): IterableIterator<[string, string]> {
      this.iterations++;
      return super[Symbol.iterator]();
    }
  }

  test("is not computed until first accessed", () => {
    const outputs = new CountingOutputs([["k8s", "kind: Namespace"]]);
    const check: PostSynthCheck = {
      id: "PS-DOCS-1",
      description: "never touches ctx.docs",
      check() {
        return [];
      },
    };
    runPostSynthChecks([check], createBuildResult({ outputs: outputs as never }));
    expect(outputs.iterations).toBe(0);
  });

  test("is parsed exactly once even when read by multiple checks", () => {
    const outputs = new CountingOutputs([
      ["k8s", "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ns-a"],
    ]);
    let seenByFirst: unknown;
    let seenBySecond: unknown;
    const checks: PostSynthCheck[] = [
      {
        id: "PS-DOCS-2A",
        description: "reads ctx.docs once",
        check(ctx) {
          seenByFirst = ctx.docs;
          return [];
        },
      },
      {
        id: "PS-DOCS-2B",
        description: "reads ctx.docs again, and a second time in the same check",
        check(ctx) {
          seenBySecond = ctx.docs;
          void ctx.docs; // a second read within the same check — still no reparse
          return [];
        },
      },
    ];
    runPostSynthChecks(checks, createBuildResult({ outputs: outputs as never }));
    expect(outputs.iterations).toBe(1);
    // Every reader gets the exact same array instance, not an equal copy.
    expect(seenByFirst).toBe(seenBySecond);
  });

  test("parses ctx.outputs into the expected OutputDoc shape", () => {
    const outputs = new Map<string, string>([
      ["k8s", "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ns-a"],
    ]);
    const check: PostSynthCheck = {
      id: "PS-DOCS-3",
      description: "reads a manifest field off ctx.docs",
      check(ctx) {
        const doc = (ctx.docs ?? [])[0];
        return [
          {
            checkId: "PS-DOCS-3",
            severity: "info",
            message: `kind=${(doc.value as { kind?: string }).kind}`,
          },
        ];
      },
    };
    const diags = runPostSynthChecks([check], createBuildResult({ outputs: outputs as never }));
    expect(diags[0].message).toBe("kind=Namespace");
  });

  test("two independent runPostSynthChecks calls each get their own cache", () => {
    const outputsA = new CountingOutputs([["k8s", "kind: Namespace"]]);
    const outputsB = new CountingOutputs([["k8s", "kind: Deployment"]]);
    const reader: PostSynthCheck = {
      id: "PS-DOCS-4",
      description: "reads ctx.docs",
      check(ctx) {
        void ctx.docs;
        return [];
      },
    };
    runPostSynthChecks([reader], createBuildResult({ outputs: outputsA as never }));
    runPostSynthChecks([reader], createBuildResult({ outputs: outputsB as never }));
    expect(outputsA.iterations).toBe(1);
    expect(outputsB.iterations).toBe(1);
  });
});
