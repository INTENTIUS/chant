import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { trafficLevelShapeRule } from "./traffic-level-shape";

function run(source: string) {
  const sourceFile = ts.createSourceFile("infra.ts", source, ts.ScriptTarget.ES2022, true);
  return trafficLevelShapeRule.check({ sourceFile, filePath: "infra.ts" } as unknown as LintContext);
}

describe("AUG001 — a traffic level that is a bare quantity", () => {
  it("reports a level that is only a number", () => {
    const found = run(`export const peak = new Profile({ traffic: "1000" });`);
    expect(found).toHaveLength(1);
    expect(found[0].ruleId).toBe("AUG001");
    expect(found[0].message).toContain('"1000"');
    expect(found[0].message).toContain("names no unit and no percentile");
  });

  it("reports an empty level", () => {
    const found = run(`export const nothing = new Profile({ traffic: "" });`);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("is empty");
  });

  it("reports a decimal with no unit", () => {
    expect(run(`export const p = new Profile({ traffic: "12.5" });`)).toHaveLength(1);
  });

  it("accepts a level written the way the answer will be read", () => {
    expect(run(`export const p = new Profile({ traffic: "1000 rps, p99" });`)).toEqual([]);
    expect(run(`export const p = new Profile({ traffic: "peak hour, black friday" });`)).toEqual([]);
    expect(run(`export const p = new Profile({ traffic: "steady state" });`)).toEqual([]);
  });

  it("reports the call form as well as the constructed one", () => {
    expect(run(`export const p = Profile({ traffic: "100" });`)).toHaveLength(1);
  });

  it("leaves a traffic property that is not a Profile's alone", () => {
    // A `traffic` somewhere else is someone else's property, and a rule that
    // fires on the name alone would report other lexicons' declarations.
    expect(run(`export const svc = new Service({ traffic: "100" });`)).toEqual([]);
    expect(run(`const settings = { traffic: "100" };`)).toEqual([]);
  });

  it("says nothing about a level it cannot read at authoring time", () => {
    // A computed level is not a literal, and guessing at what it evaluates to
    // is how a lint rule reports a project that is fine.
    expect(run(`export const p = new Profile({ traffic: LEVELS.peak });`)).toEqual([]);
    expect(run("export const p = new Profile({ traffic: `${rps} rps` });")).toEqual([]);
  });

  it("finds a profile nested inside other source", () => {
    const found = run(`
      export function levels() {
        return [new Profile({ traffic: "100 rps, p50" }), new Profile({ traffic: "500" })];
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
  });
});
