import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl009CompositeNoConstantRule } from "./evl009-composite-no-constant";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL009: composite-no-constant", () => {
  test("rule metadata", () => {
    expect(evl009CompositeNoConstantRule.id).toBe("EVL009");
    expect(evl009CompositeNoConstantRule.severity).toBe("warning");
    expect(evl009CompositeNoConstantRule.category).toBe("style");
  });

  test("flags inline object literal that doesn't reference props", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          assumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
          },
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl009CompositeNoConstantRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL009");
    expect(diags[0].message).toContain("assumeRolePolicyDocument");
    expect(diags[0].message).toContain("_.$.name");
  });

  test("flags inline array with objects that doesn't reference props", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          managedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole", "arn:aws:iam::aws:policy/AmazonS3ReadOnly"],
        });
        return { role };
      }, "MyComp");
    `);
    // Array of simple strings — NOT flagged (no objects inside)
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("flags array containing objects", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: [{ policyName: "S3Access", policyDocument: { Version: "2012-10-17" } }],
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl009CompositeNoConstantRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("policies");
  });

  test("allows barrel refs (_.$.name)", () => {
    const ctx = createContext(`
      const MyComp = _.Composite((props) => {
        const role = new Role({
          assumeRolePolicyDocument: _.$.lambdaTrustPolicy,
        });
        return { role };
      }, "MyComp");
    `);
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("allows props references", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.policies,
        });
        return { role };
      }, "MyComp");
    `);
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("allows object containing props reference", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const func = new Function({
          environment: { variables: { NAME: props.name } },
        });
        return { func };
      }, "MyComp");
    `);
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("allows sibling member reference", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({ assumeRolePolicyDocument: _.$.trustPolicy });
        const func = new Function({
          config: { roleArn: role.arn },
        });
        return { role, func };
      }, "MyComp");
    `);
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("allows simple string literals (not extractable)", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const perm = new Permission({
          action: "lambda:InvokeFunction",
          principal: "apigateway.amazonaws.com",
        });
        return { perm };
      }, "MyComp");
    `);
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag outside Composite", () => {
    const ctx = createContext(`
      const role = new Role({
        assumeRolePolicyDocument: { Version: "2012-10-17" },
      });
    `);
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });

  test("flags multiple extractable constants", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          trustPolicy: { Version: "2012-10-17", Statement: [] },
          config: { retryAttempts: 3, timeout: 30 },
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl009CompositeNoConstantRule.check(ctx);
    expect(diags).toHaveLength(2);
  });

  test("allows array wrapping barrel ref", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          managedPolicyArns: [_.$.lambdaBasicExecutionArn],
        });
        return { role };
      }, "MyComp");
    `);
    // Array with barrel ref inside — not flagged (contains barrel ref)
    // Also it's an array of identifiers, no objects inside
    expect(evl009CompositeNoConstantRule.check(ctx)).toHaveLength(0);
  });
});
