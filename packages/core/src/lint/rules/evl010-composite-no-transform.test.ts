import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { evl010CompositeNoTransformRule } from "./evl010-composite-no-transform";
import type { LintContext } from "../rule";

function createContext(code: string, filePath = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath, lexicon: undefined };
}

describe("EVL010: composite-no-transform", () => {
  test("rule metadata", () => {
    expect(evl010CompositeNoTransformRule.id).toBe("EVL010");
    expect(evl010CompositeNoTransformRule.severity).toBe("warning");
    expect(evl010CompositeNoTransformRule.category).toBe("style");
  });

  test("flags .map() inside Composite factory", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.items.map(x => new Policy(x)),
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl010CompositeNoTransformRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("EVL010");
    expect(diags[0].message).toContain(".map()");
  });

  test("flags .filter() inside Composite factory", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.items.filter(Boolean),
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl010CompositeNoTransformRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(".filter()");
  });

  test("flags .reduce() inside Composite factory", () => {
    const ctx = createContext(`
      const MyComp = _.Composite((props) => {
        const tags = Object.keys(props.env).reduce((acc, k) => {
          acc[k] = props.env[k];
          return acc;
        }, {});
        const bucket = new Bucket({ tags });
        return { bucket };
      }, "MyComp");
    `);
    const diags = evl010CompositeNoTransformRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(".reduce()");
  });

  test("flags .flatMap() inside Composite factory", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.groups.flatMap(g => g.policies),
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl010CompositeNoTransformRule.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(".flatMap()");
  });

  test("does not flag .map() outside Composite factory", () => {
    const ctx = createContext(`
      const items = data.map(x => new Thing(x));
    `);
    expect(evl010CompositeNoTransformRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag props pass-through", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.policies,
        });
        return { role };
      }, "MyComp");
    `);
    expect(evl010CompositeNoTransformRule.check(ctx)).toHaveLength(0);
  });

  test("does not flag array literal", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          managedPolicyArns: [props.arn],
        });
        return { role };
      }, "MyComp");
    `);
    expect(evl010CompositeNoTransformRule.check(ctx)).toHaveLength(0);
  });

  test("flags multiple transforms", () => {
    const ctx = createContext(`
      const MyComp = Composite((props) => {
        const role = new Role({
          policies: props.items.map(x => new Policy(x)),
          tags: props.tags.filter(t => t.active),
        });
        return { role };
      }, "MyComp");
    `);
    const diags = evl010CompositeNoTransformRule.check(ctx);
    expect(diags).toHaveLength(2);
  });
});
