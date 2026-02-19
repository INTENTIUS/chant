import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { cor018CompositePreferLexiconTypeRule } from "./cor018-composite-prefer-lexicon-type";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("COR018: composite-prefer-lexicon-type", () => {
  test("rule metadata", () => {
    expect(cor018CompositePreferLexiconTypeRule.id).toBe("COR018");
    expect(cor018CompositePreferLexiconTypeRule.severity).toBe("info");
    expect(cor018CompositePreferLexiconTypeRule.category).toBe("style");
  });

  test("flags local interface used in Composite props", () => {
    const ctx = createContext(`
      interface PolicyStatement {
        effect: string;
        action: string[];
        resource: string[];
      }

      interface LambdaApiProps {
        name: string;
        policies?: PolicyStatement[];
      }

      const LambdaApi = Composite<LambdaApiProps>((props) => {
        const role = new Role({ policies: props.policies });
        return { role };
      }, "LambdaApi");
    `);
    const diags = cor018CompositePreferLexiconTypeRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("COR018");
    expect(diags[0].message).toContain("PolicyStatement");
    expect(diags[0].message).toContain("policies");
    expect(diags[0].message).toContain("lexicon property type");
  });

  test("does not flag when no local types are used", () => {
    const ctx = createContext(`
      interface LambdaApiProps {
        name: string;
        timeout?: number;
        policies?: InstanceType<typeof Role_Policy>[];
      }

      const LambdaApi = Composite<LambdaApiProps>((props) => {
        const role = new Role({ policies: props.policies });
        return { role };
      }, "LambdaApi");
    `);
    expect(cor018CompositePreferLexiconTypeRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag files without Composite", () => {
    const ctx = createContext(`
      interface MyType {
        name: string;
      }

      interface MyProps {
        item: MyType;
      }
    `);
    expect(cor018CompositePreferLexiconTypeRule.check(ctx)).toHaveLength(0);
  });

  test("flags local type alias used in Composite props", () => {
    const ctx = createContext(`
      type EncryptionConfig = {
        algorithm: string;
        keyId: string;
      };

      interface StorageProps {
        encryption: EncryptionConfig;
      }

      const Storage = Composite<StorageProps>((props) => {
        const bucket = new Bucket({ encryption: props.encryption });
        return { bucket };
      }, "Storage");
    `);
    const diags = cor018CompositePreferLexiconTypeRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("EncryptionConfig");
    expect(diags[0].message).toContain("encryption");
  });

  test("flags with _.Composite", () => {
    const ctx = createContext(`
      interface CustomPolicy {
        name: string;
      }

      interface MyProps {
        policy: CustomPolicy;
      }

      const MyComp = _.Composite<MyProps>((props) => {
        return { role: new Role({}) };
      }, "MyComp");
    `);
    const diags = cor018CompositePreferLexiconTypeRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("CustomPolicy");
  });

  test("flags multiple local types in props", () => {
    const ctx = createContext(`
      interface PolicyDoc {
        version: string;
      }

      interface TagConfig {
        key: string;
        value: string;
      }

      interface MyProps {
        policy: PolicyDoc;
        tags: TagConfig[];
      }

      const MyComp = Composite<MyProps>((props) => {
        return { role: new Role({}) };
      }, "MyComp");
    `);
    const diags = cor018CompositePreferLexiconTypeRule.check(ctx);
    expect(diags).toHaveLength(2);
  });

  test("does not flag primitives in props", () => {
    const ctx = createContext(`
      interface MyProps {
        name: string;
        count: number;
        enabled: boolean;
        tags: string[];
      }

      const MyComp = Composite<MyProps>((props) => {
        return { bucket: new Bucket({}) };
      }, "MyComp");
    `);
    expect(cor018CompositePreferLexiconTypeRule.check(ctx)).toHaveLength(0);
  });

  test("handles union types with local type", () => {
    const ctx = createContext(`
      interface CustomCode {
        zipFile: string;
      }

      interface MyProps {
        code: CustomCode | string;
      }

      const MyComp = Composite<MyProps>((props) => {
        return { func: new Function({}) };
      }, "MyComp");
    `);
    const diags = cor018CompositePreferLexiconTypeRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("CustomCode");
  });
});
