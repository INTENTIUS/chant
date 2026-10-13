/**
 * #3888: the principals file read by hand, for the gate-decision bundle,
 * accepts and refuses what chant's ajv-checked `parseClassData` does.
 */

import { describe, expect, test } from "vitest";
import { classDataShapeProblems, parseClassDataByHand } from "./class-data";
import { parseClassData } from "./principal-classes";

const ok = { name: "operator", description: "people who apply infrastructure", role: "ops" };

const FILES: unknown[] = [
  { schema: 1, classes: [ok] },
  { $schema: "x", $comment: "y", "x-note": 3, schema: 1, classes: [{ ...ok, "x-extra": true }] },
  { schema: 1, classes: [ok, { name: "reviewer", description: "r", role: "reviewer" }] },
  { schema: 1, classes: [ok, { ...ok, role: "other" }] },
  { schema: 1, classes: [{ ...ok, name: "agent" }] },
  { schema: 1, classes: [{ ...ok, role: "runner" }] },
  { schema: 1, classes: [ok, { ...ok, name: "other" }] },
  { schema: 2, classes: [ok] },
  { schema: "1", classes: [ok] },
  { classes: [ok] },
  { schema: 1 },
  { schema: 1, classes: [] },
  { schema: 1, classes: {} },
  { schema: 1, classes: [ok], extra: 1 },
  { $schema: 3, schema: 1, classes: [ok] },
  { $comment: null, schema: 1, classes: [ok] },
  { schema: 1, classes: [{ ...ok, other: 1 }] },
  { schema: 1, classes: [{ name: ok.name, role: ok.role }] },
  { schema: 1, classes: [{ name: ok.name, description: ok.description }] },
  { schema: 1, classes: [{ description: ok.description, role: ok.role }] },
  { schema: 1, classes: [{ ...ok, name: "Operator" }] },
  { schema: 1, classes: [{ ...ok, name: "x-operator" }] },
  { schema: 1, classes: [{ ...ok, name: "a".repeat(40) }] },
  { schema: 1, classes: [{ ...ok, name: "a".repeat(41) }] },
  { schema: 1, classes: [{ ...ok, name: "1op" }] },
  { schema: 1, classes: [{ ...ok, name: 7 }] },
  { schema: 1, classes: [{ ...ok, description: "" }] },
  { schema: 1, classes: [{ ...ok, description: 1 }] },
  { schema: 1, classes: [{ ...ok, role: "Ops" }] },
  { schema: 1, classes: [{ ...ok, role: "ops role" }] },
  { schema: 1, classes: [{ ...ok, role: "op-s2" }] },
  { schema: 1, classes: [null] },
  { schema: 1, classes: ["operator"] },
  [],
  null,
  "text",
];

describe("the principals file read without ajv", () => {
  test.each(FILES.map((f) => [JSON.stringify(f), f]))("%s reads to the classes ajv's check gives", (_, file) => {
    const text = JSON.stringify(file);
    const byAjv = parseClassData(text, "@acme/p");
    const byHand = parseClassDataByHand(text, "@acme/p");
    expect(byHand.classes).toEqual(byAjv.classes);
    expect(byHand.problems.length > 0).toBe(byAjv.problems.length > 0);
    expect(classDataShapeProblems(file, "@acme/p").length === 0).toBe(byAjv.classes.length > 0 || byAjv.problems.every((p) => /core|twice|another class/.test(p)));
  });

  test("text that is not JSON", () => {
    expect(parseClassDataByHand("{", "@acme/p")).toEqual(parseClassData("{", "@acme/p"));
  });
});
