import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { deprecatedOnlyExceptRule } from "./deprecated-only-except";
import { missingScriptRule } from "./missing-script";
import { missingStageRule } from "./missing-stage";
import { artifactNoExpiryRule } from "./artifact-no-expiry";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

// ── WGL001: deprecated only/except ──────────────────────────────────

describe("WGL001: deprecated-only-except", () => {
  test("flags 'only' in new Job()", () => {
    const ctx = createContext(`const j = new Job({ only: ["main"], script: ["test"] });`);
    const diags = deprecatedOnlyExceptRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WGL001");
    expect(diags[0].message).toContain("only");
  });

  test("flags 'except' in new Job()", () => {
    const ctx = createContext(`const j = new Job({ except: ["tags"], script: ["test"] });`);
    const diags = deprecatedOnlyExceptRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("except");
  });

  test("flags both 'only' and 'except'", () => {
    const ctx = createContext(`const j = new Job({ only: ["main"], except: ["tags"], script: ["test"] });`);
    const diags = deprecatedOnlyExceptRule.check(ctx);
    expect(diags).toHaveLength(2);
  });

  test("does not flag 'rules'", () => {
    const ctx = createContext(`const j = new Job({ rules: [{ if: "$CI" }], script: ["test"] });`);
    const diags = deprecatedOnlyExceptRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag 'only' outside new expression", () => {
    const ctx = createContext(`const only = "main";`);
    const diags = deprecatedOnlyExceptRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── WGL002: missing script ──────────────────────────────────────────

describe("WGL002: missing-script", () => {
  test("flags Job without script, trigger, or run", () => {
    const ctx = createContext(`const j = new Job({ stage: "test" });`);
    const diags = missingScriptRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WGL002");
    expect(diags[0].severity).toBe("error");
  });

  test("does not flag Job with script", () => {
    const ctx = createContext(`const j = new Job({ script: ["test"] });`);
    const diags = missingScriptRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag Job with trigger", () => {
    const ctx = createContext(`const j = new Job({ trigger: "other/project" });`);
    const diags = missingScriptRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag Job with run", () => {
    const ctx = createContext(`const j = new Job({ run: ["echo test"] });`);
    const diags = missingScriptRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags gl.Job() without script", () => {
    const ctx = createContext(`const j = new gl.Job({ stage: "build" });`);
    const diags = missingScriptRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("does not flag non-Job constructors", () => {
    const ctx = createContext(`const c = new Cache({ paths: ["node_modules/"] });`);
    const diags = missingScriptRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── WGL003: missing stage ───────────────────────────────────────────

describe("WGL003: missing-stage", () => {
  test("flags Job without stage", () => {
    const ctx = createContext(`const j = new Job({ script: ["test"] });`);
    const diags = missingStageRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WGL003");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("test");
  });

  test("does not flag Job with stage", () => {
    const ctx = createContext(`const j = new Job({ stage: "build", script: ["make"] });`);
    const diags = missingStageRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── WGL004: artifact no expiry ──────────────────────────────────────

describe("WGL004: artifact-no-expiry", () => {
  test("flags Artifacts without expireIn", () => {
    const ctx = createContext(`const a = new Artifacts({ paths: ["dist/"] });`);
    const diags = artifactNoExpiryRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("WGL004");
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag Artifacts with expireIn", () => {
    const ctx = createContext(`const a = new Artifacts({ paths: ["dist/"], expireIn: "1 week" });`);
    const diags = artifactNoExpiryRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("does not flag Artifacts with expire_in", () => {
    const ctx = createContext(`const a = new Artifacts({ paths: ["dist/"], expire_in: "30 days" });`);
    const diags = artifactNoExpiryRule.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("flags gl.Artifacts without expiry", () => {
    const ctx = createContext(`const a = new gl.Artifacts({ paths: ["dist/"] });`);
    const diags = artifactNoExpiryRule.check(ctx);
    expect(diags).toHaveLength(1);
  });

  test("does not flag non-Artifacts constructors", () => {
    const ctx = createContext(`const j = new Job({ script: ["test"] });`);
    const diags = artifactNoExpiryRule.check(ctx);
    expect(diags).toHaveLength(0);
  });
});
