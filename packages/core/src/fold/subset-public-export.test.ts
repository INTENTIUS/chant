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

/**
 * chant#2424 — the specification's conformance adapter reads `SPEC_VERSION`
 * off exactly this namespace:
 *
 * ```ts
 * specVersion: (chant as { SPEC_VERSION?: string }).SPEC_VERSION ?? "undeclared",
 * ```
 *
 * so a suite that finds nothing there reports chant as `undeclared` rather
 * than as implementing anything. The barrel is the thing that can silently
 * drop it, which is what this pins.
 */
describe("SPEC_VERSION is declared on the package entry (chant#2424)", () => {
  test("the public namespace carries it", () => {
    expect(typeof chant.SPEC_VERSION).toBe("string");
    expect(chant.SPEC_VERSION).not.toBe("");
  });

  test("it is a specification version, not a chant release", () => {
    // `spec/VERSION` carries a two-part version that moves separately from
    // chant's own releases (INTENTIUS/typescript-as-data#18), so a value that
    // looks like a package version is the mistake worth catching.
    expect(chant.SPEC_VERSION).toMatch(/^\d+\.\d+$/);
  });

  test("and it is the same string the subset module defines", async () => {
    const { SPEC_VERSION } = await import("./subset");
    expect(chant.SPEC_VERSION).toBe(SPEC_VERSION);
  });
});
