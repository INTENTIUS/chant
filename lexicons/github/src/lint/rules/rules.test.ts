import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { useTypedActionsRule } from "./use-typed-actions";
import { useConditionBuildersRule } from "./use-condition-builders";
import { noHardcodedSecretsRule } from "./no-hardcoded-secrets";
import { useMatrixBuilderRule } from "./use-matrix-builder";
import { extractInlineStructsRule } from "./extract-inline-structs";
import { fileJobLimitRule } from "./file-job-limit";
import { noRawExpressionsRule } from "./no-raw-expressions";
import { missingRecommendedInputsRule } from "./missing-recommended-inputs";
import { deprecatedActionVersionRule } from "./deprecated-action-version";
import { jobTimeoutRule } from "./job-timeout";
import { suggestCacheRule } from "./suggest-cache";
import { validateConcurrencyRule } from "./validate-concurrency";
import { detectSecretsRule } from "./detect-secrets";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

// ── GHA001: use-typed-actions ───────────────────────────────────────

describe("GHA001: use-typed-actions", () => {
  test("flags raw uses: string for known action", () => {
    const ctx = createContext(`const s = new Step({ uses: "actions/checkout@v4" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA001");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("Checkout");
  });

  test("flags actions/setup-node", () => {
    const ctx = createContext(`const s = new Step({ uses: "actions/setup-node@v4" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("SetupNode");
  });

  test("does not flag unknown action", () => {
    const ctx = createContext(`const s = new Step({ uses: "custom/action@v1" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-uses property", () => {
    const ctx = createContext(`const s = new Step({ run: "npm test" });`);
    const diags = useTypedActionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA002: use-condition-builders ──────────────────────────────────

describe("GHA002: use-condition-builders", () => {
  test("flags ${{ in if property", () => {
    const ctx = createContext(`const j = new Job({ if: "\${{ github.ref == 'refs/heads/main' }}" });`);
    const diags = useConditionBuildersRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA002");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag Expression object in if", () => {
    const ctx = createContext(`const j = new Job({ if: branch("main") });`);
    const diags = useConditionBuildersRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag string without ${{ in if", () => {
    const ctx = createContext(`const j = new Job({ if: "always()" });`);
    const diags = useConditionBuildersRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA003: no-hardcoded-secrets ────────────────────────────────────

describe("GHA003: no-hardcoded-secrets", () => {
  test("flags ghp_ prefix", () => {
    const ctx = createContext(`const token = "ghp_1234567890abcdef";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA003");
    expect(diags[0].severity).toBe("error");
  });

  test("flags ghs_ prefix", () => {
    const ctx = createContext(`const token = "ghs_abcdef1234567890";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("flags github_pat_ prefix", () => {
    const ctx = createContext(`const token = "github_pat_ABCDEF1234567890";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("does not flag normal strings", () => {
    const ctx = createContext(`const name = "my-github-repo";`);
    const diags = noHardcodedSecretsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA004: use-matrix-builder ──────────────────────────────────────

describe("GHA004: use-matrix-builder", () => {
  test("flags inline matrix object", () => {
    const ctx = createContext(`const s = new Strategy({ matrix: { "node-version": ["18", "20"] } });`);
    const diags = useMatrixBuilderRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA004");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag matrix reference", () => {
    const ctx = createContext(`const s = new Strategy({ matrix: myMatrix });`);
    const diags = useMatrixBuilderRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA005: extract-inline-structs ──────────────────────────────────

describe("GHA005: extract-inline-structs", () => {
  test("flags deeply nested objects in Job constructor", () => {
    const ctx = createContext(`const j = new Job({ on: { push: { branches: { pattern: "main" } } } });`);
    const diags = extractInlineStructsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA005");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag shallow nesting", () => {
    const ctx = createContext(`const j = new Job({ env: { NODE_ENV: "production" } });`);
    const diags = extractInlineStructsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-resource constructors", () => {
    const ctx = createContext(`const s = new Step({ env: { a: { b: { c: "deep" } } } });`);
    const diags = extractInlineStructsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA007: file-job-limit ──────────────────────────────────────────

describe("GHA007: file-job-limit", () => {
  test("flags file with more than 10 jobs", () => {
    const jobs = Array.from({ length: 11 }, (_, i) => `const j${i} = new Job({ "runs-on": "ubuntu-latest" });`).join("\n");
    const ctx = createContext(jobs);
    const diags = fileJobLimitRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA007");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("11");
  });

  test("does not flag 10 or fewer jobs", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => `const j${i} = new Job({ "runs-on": "ubuntu-latest" });`).join("\n");
    const ctx = createContext(jobs);
    const diags = fileJobLimitRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("counts ReusableWorkflowCallJob too", () => {
    const jobs = Array.from({ length: 11 }, (_, i) => `const j${i} = new ReusableWorkflowCallJob({ uses: "owner/repo/.github/workflows/x.yml@main" });`).join("\n");
    const ctx = createContext(jobs);
    const diags = fileJobLimitRule.check(ctx);
    expect(diags).toHaveLength(1);
  });
});

// ── GHA008: no-raw-expressions ──────────────────────────────────────

describe("GHA008: no-raw-expressions", () => {
  test("flags unknown context in ${{ }}", () => {
    const ctx = createContext(`const x = "\${{ custom.unknown }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA008");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag known contexts", () => {
    const ctx = createContext(`const x = "\${{ github.ref }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag secrets context", () => {
    const ctx = createContext(`const x = "\${{ secrets.MY_TOKEN }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag function calls", () => {
    const ctx = createContext(`const x = "\${{ contains(github.ref, 'main') }}";`);
    const diags = noRawExpressionsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA010: missing-recommended-inputs ──────────────────────────────

describe("GHA010: missing-recommended-inputs", () => {
  test("flags SetupNode without version", () => {
    const ctx = createContext(`const step = SetupNode({ cache: "npm" });`);
    const diags = missingRecommendedInputsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA010");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("SetupNode");
  });

  test("does not flag SetupNode with nodeVersion", () => {
    const ctx = createContext(`const step = SetupNode({ nodeVersion: "22" });`);
    const diags = missingRecommendedInputsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-setup function calls", () => {
    const ctx = createContext(`const step = Checkout({});`);
    const diags = missingRecommendedInputsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA012: deprecated-action-version ───────────────────────────────

describe("GHA012: deprecated-action-version", () => {
  test("flags deprecated checkout version", () => {
    const ctx = createContext(`const s = "actions/checkout@v2";`);
    const diags = deprecatedActionVersionRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA012");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("v2");
  });

  test("does not flag current version", () => {
    const ctx = createContext(`const s = "actions/checkout@v4";`);
    const diags = deprecatedActionVersionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag unknown action", () => {
    const ctx = createContext(`const s = "custom/action@v1";`);
    const diags = deprecatedActionVersionRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA014: job-timeout ─────────────────────────────────────────────

describe("GHA014: job-timeout", () => {
  test("flags Job without timeoutMinutes", () => {
    const ctx = createContext(`const j = new Job({ "runs-on": "ubuntu-latest" });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA014");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag Job with timeoutMinutes", () => {
    const ctx = createContext(`const j = new Job({ "runs-on": "ubuntu-latest", timeoutMinutes: 30 });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag Job with timeout-minutes", () => {
    const ctx = createContext(`const j = new Job({ "runs-on": "ubuntu-latest", "timeout-minutes": 30 });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-Job constructors", () => {
    const ctx = createContext(`const s = new Step({ run: "test" });`);
    const diags = jobTimeoutRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA015: suggest-cache ───────────────────────────────────────────

describe("GHA015: suggest-cache", () => {
  test("flags SetupNode in steps without Cache", () => {
    const ctx = createContext(`const j = new Job({ steps: [SetupNode({ nodeVersion: "22" })] });`);
    const diags = suggestCacheRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA015");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag SetupNode with cache prop", () => {
    const ctx = createContext(`const j = new Job({ steps: [SetupNode({ nodeVersion: "22", cache: "npm" })] });`);
    const diags = suggestCacheRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag steps with Cache composite", () => {
    const ctx = createContext(`const j = new Job({ steps: [SetupNode({ nodeVersion: "22" }), Cache({ path: "node_modules" })] });`);
    const diags = suggestCacheRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA016: validate-concurrency ────────────────────────────────────

describe("GHA016: validate-concurrency", () => {
  test("flags cancelInProgress without group", () => {
    const ctx = createContext(`const c = new Concurrency({ cancelInProgress: true });`);
    const diags = validateConcurrencyRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA016");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag cancelInProgress with group", () => {
    const ctx = createContext(`const c = new Concurrency({ cancelInProgress: true, group: "ci-\${{ github.ref }}" });`);
    const diags = validateConcurrencyRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag concurrency without cancelInProgress", () => {
    const ctx = createContext(`const c = new Concurrency({ group: "ci" });`);
    const diags = validateConcurrencyRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── GHA020: detect-secrets ──────────────────────────────────────────

describe("GHA020: detect-secrets", () => {
  test("flags AWS access key", () => {
    const ctx = createContext(`const key = "AKIAIOSFODNN7EXAMPLE";`);
    const diags = detectSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("GHA020");
    expect(diags[0].severity).toBe("error");
  });

  test("flags RSA private key header", () => {
    const ctx = createContext(`const key = "-----BEGIN RSA PRIVATE KEY-----";`);
    const diags = detectSecretsRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("skips strings referencing secrets.", () => {
    const ctx = createContext(`const x = "Use secrets.DEPLOY_KEY for deployment";`);
    const diags = detectSecretsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag normal strings", () => {
    const ctx = createContext(`const name = "my-application";`);
    const diags = detectSecretsRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
