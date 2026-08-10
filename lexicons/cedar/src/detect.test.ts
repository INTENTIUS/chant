import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { detectTemplate } from "./detect";

const testdata = (file: string) => readFileSync(join(import.meta.dirname, "import", "testdata", file), "utf8");

describe("what cedar claims", () => {
  test("the JSON policy-set envelope, parsed", () => {
    expect(detectTemplate(JSON.parse(testdata("full.cedar.json")))).toBe(true);
  });

  test("the JSON policy-set envelope, as a raw string", () => {
    expect(detectTemplate(testdata("full.cedar.json"))).toBe(true);
  });

  test("`.cedar` policy text", () => {
    expect(detectTemplate(testdata("simple.cedar"))).toBe(true);
    expect(detectTemplate(testdata("realistic.cedar"))).toBe(true);
  });

  test("a document that is only templates", () => {
    expect(detectTemplate('@id("t") permit (principal == ?principal, action, resource);')).toBe(true);
  });
});

describe("what cedar leaves alone", () => {
  test("another lexicon's JSON", () => {
    expect(detectTemplate({ apiVersion: "apps/v1", kind: "Deployment", metadata: { name: "web" } })).toBe(false);
    expect(detectTemplate({ AWSTemplateFormatVersion: "2010-09-09", Resources: {} })).toBe(false);
    expect(detectTemplate({ services: { web: { image: "nginx" } } })).toBe(false);
    expect(detectTemplate({ $schema: "https://schema.management.azure.com/", resources: [] })).toBe(false);
  });

  test("an empty policy set — `{}` parses as one, and claiming it would swallow everything", () => {
    expect(detectTemplate({})).toBe(false);
    expect(detectTemplate({ staticPolicies: {} })).toBe(false);
    expect(detectTemplate({ staticPolicies: {}, templates: {}, templateLinks: [] })).toBe(false);
    expect(detectTemplate("")).toBe(false);
    expect(detectTemplate("   ")).toBe(false);
  });

  test("an envelope with one foreign key beside the known ones", () => {
    expect(detectTemplate({ staticPolicies: { p: {} }, Resources: {} })).toBe(false);
  });

  test("a well-formed envelope whose policies are not Cedar", () => {
    expect(detectTemplate({ staticPolicies: { p: { effect: "maybe" } } })).toBe(false);
  });

  test("text that is not Cedar", () => {
    expect(detectTemplate("FROM node:20\nRUN npm ci\n")).toBe(false);
    expect(detectTemplate("apiVersion: v1\nkind: Pod\n")).toBe(false);
    expect(detectTemplate("# a readme\n\nSome prose.\n")).toBe(false);
  });

  test("scalars, arrays and nothing", () => {
    expect(detectTemplate(null)).toBe(false);
    expect(detectTemplate(undefined)).toBe(false);
    expect(detectTemplate(42)).toBe(false);
    expect(detectTemplate([])).toBe(false);
    expect(detectTemplate([{ staticPolicies: {} }])).toBe(false);
  });
});
