import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import * as chant from "../index";

/**
 * The shape classifier is part of the public entry so a conformance adapter
 * (INTENTIUS/typescript-as-data#11) and downstream tooling can ask "will this
 * fold?" without running a fold. This pins the export and its two answers.
 */
describe("findSubsetViolation is exported from the package entry", () => {
  const initializerOf = (src: string) => {
    const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
    return (sf.statements[0] as ts.VariableStatement).declarationList.declarations[0].initializer!;
  };
  test("is a function on the public namespace", () => {
    expect(typeof chant.findSubsetViolation).toBe("function");
    expect(typeof chant.checkObjectMember).toBe("function");
  });
  test("classifies a call as EVL001 and a literal as clean", () => {
    const call = chant.findSubsetViolation(initializerOf("export const x = getId();"));
    expect(call?.ruleId).toBe("EVL001");
    expect(chant.findSubsetViolation(initializerOf('export const x = "ok";'))).toBeUndefined();
  });
  test("classifies a dynamic element-access key as EVL003", () => {
    expect(chant.findSubsetViolation(initializerOf("export const x = cfg[key];"))?.ruleId).toBe("EVL003");
  });
});
