import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { resolveSelector, registerSelector, collectNodes } from "./selectors";

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", code, ts.ScriptTarget.Latest, true);
}

describe("selectors", () => {
  describe("collectNodes", () => {
    test("collects matching nodes recursively", () => {
      const sf = parse(`const a = "hello"; const b = "world";`);
      const strings = collectNodes(sf, (node) => ts.isStringLiteral(node));
      expect(strings).toHaveLength(2);
    });

    test("returns empty for no matches", () => {
      const sf = parse(`const a = 1;`);
      const strings = collectNodes(sf, (node) => ts.isStringLiteral(node));
      expect(strings).toHaveLength(0);
    });
  });

  describe("built-in selectors", () => {
    test("resource selector matches new expressions", () => {
      const sf = parse(`const b = new Bucket({ name: "test" });`);
      const sel = resolveSelector("resource");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(1);
      expect(ts.isNewExpression(nodes[0])).toBe(true);
    });

    test("any-resource is alias for resource", () => {
      const sf = parse(`const b = new Bucket({}); const c = new Table({});`);
      const sel = resolveSelector("any-resource");
      expect(sel(sf)).toHaveLength(2);
    });

    test("string-literal matches string literals", () => {
      const sf = parse(`const a = "hello"; const b = 42;`);
      const sel = resolveSelector("string-literal");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(1);
      expect(ts.isStringLiteral(nodes[0])).toBe(true);
    });

    test("export-name matches exported declarations", () => {
      const sf = parse(`export const a = 1; const b = 2; export function foo() {}`);
      const sel = resolveSelector("export-name");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(2);
    });

    test("import-source matches import declarations", () => {
      const sf = parse(`import { Bucket } from "@aws/s3"; import * as iam from "@aws/iam";`);
      const sel = resolveSelector("import-source");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(2);
    });

    test("property matches property assignments", () => {
      const sf = parse(`const x = { a: 1, b: 2 };`);
      const sel = resolveSelector("property");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(2);
    });

    test("resource-type matches new expressions with type arguments", () => {
      const sf = parse(`const b = new Bucket<MyType>({}); const c = new Table({});`);
      const sel = resolveSelector("resource-type");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(1);
    });

    test("exported-const matches exported const declarations", () => {
      const sf = parse(`export const a = 1; export let b = 2; const c = 3;`);
      const sel = resolveSelector("exported-const");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(1);
    });
  });

  describe("compound selectors", () => {
    test("resource > property scopes to children", () => {
      const sf = parse(`const b = new Bucket({ name: "test", region: "us" }); const other = { x: 1 };`);
      const sel = resolveSelector("resource > property");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(2);
    });
  });

  describe("registerSelector", () => {
    test("registers and resolves custom selector", () => {
      registerSelector("number-literal", (sf) =>
        collectNodes(sf, (node) => ts.isNumericLiteral(node))
      );
      const sf = parse(`const a = 42; const b = "hello";`);
      const sel = resolveSelector("number-literal");
      const nodes = sel(sf);
      expect(nodes).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    test("throws for unknown selector", () => {
      expect(() => resolveSelector("nonexistent")).toThrow('Unknown selector: "nonexistent"');
    });

    test("throws for unknown compound part", () => {
      expect(() => resolveSelector("resource > nonexistent")).toThrow('Unknown selector: "nonexistent"');
    });
  });
});
