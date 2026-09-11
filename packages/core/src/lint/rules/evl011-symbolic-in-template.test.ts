import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { evl011SymbolicInTemplateRule } from "./evl011-symbolic-in-template";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL011: a symbolic reference in a plain template", () => {
  test("rule metadata", () => {
    expect(evl011SymbolicInTemplateRule.id).toBe("EVL011");
    expect(evl011SymbolicInTemplateRule.severity).toBe("error");
    expect(evl011SymbolicInTemplateRule.category).toBe("correctness");
  });

  test("flags a resource attribute in a plain template, at the reference", () => {
    const ctx = createContext(`
      const bucket = new S3Bucket({ name: "b" });
      const x = \`\${bucket.arn}-suffix\`;
    `);
    const found = evl011SymbolicInTemplateRule.check(ctx);
    expect(found).toHaveLength(1);
    expect(found[0].ruleId).toBe("EVL011");
    expect(found[0].message).toContain("bucket.arn");
    // The remedy, not just the complaint — the whole reason this rule exists
    // alongside a refusal that already fails the build.
    expect(found[0].message).toMatch(/Sub|intrinsic/);
    expect(found[0].line).toBe(3);
  });

  test("flags every offending span, not just the first", () => {
    const ctx = createContext(`
      const bucket = new S3Bucket({ name: "b" });
      const queue = new Queue({ name: "q" });
      const x = \`\${bucket.arn}/\${queue.url}\`;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(2);
  });

  test("allows a tagged template — that is the documented remedy", () => {
    const ctx = createContext(`
      const bucket = new S3Bucket({ name: "b" });
      const x = Sub\`\${bucket.arn}-suffix\`;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(0);
  });

  test("allows an ordinary const in a template", () => {
    const ctx = createContext(`
      const region = "us-east-1";
      const x = \`bucket-\${region}\`;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(0);
  });

  test("allows a property access on something that is not a resource", () => {
    // The false positive worth avoiding: this code works, and flagging it
    // would train people to suppress the rule.
    const ctx = createContext(`
      const config = { region: "us-east-1" };
      const x = \`bucket-\${config.region}\`;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(0);
  });


  test("flags a nested construction used as a value (#2397)", () => {
    const ctx = createContext(`
      const x = \`\${new Image({ name: "n" })}-tag\`;
    `);
    const found = evl011SymbolicInTemplateRule.check(ctx);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("new Image");
  });

  test("flags a composite `.step` (#2397)", () => {
    const ctx = createContext(`
      const x = \`\${Checkout({}).step}\`;
    `);
    const found = evl011SymbolicInTemplateRule.check(ctx);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("Checkout(…).step");
  });

  test("an ordinary `.step`-less property on a call is not flagged", () => {
    // The false positive worth avoiding: `.step` is the idiom, and a rule
    // cannot know which callees are composites, so only that name qualifies.
    const ctx = createContext(`
      const x = \`\${getConfig().region}\`;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(0);
  });

  test("says nothing about a reference outside a template", () => {
    const ctx = createContext(`
      const bucket = new S3Bucket({ name: "b" });
      const x = bucket.arn;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(0);
  });

  test("a missed shape is a cost the refusal already covers", () => {
    // Reached through an array rather than a plain identifier: lint sees
    // syntax, not values, so this is not flagged — and `fold()` still refuses
    // it (#2349). Documented as a deliberate limit rather than left to be
    // discovered as a gap.
    const ctx = createContext(`
      const bucket = new S3Bucket({ name: "b" });
      const all = [bucket];
      const x = \`\${all[0].arn}-suffix\`;
    `);
    expect(evl011SymbolicInTemplateRule.check(ctx)).toHaveLength(0);
  });
});
