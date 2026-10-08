import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalText, diffCanonical, failureClass, measurementConfig, summarise } from "./import-roundtrip-bytes";

const dir = join(import.meta.dirname, "..", "test", "import-roundtrip");

describe("canonical form", () => {
  test("key order and short-form tags do not matter", () => {
    const a = `Resources:\n  B:\n    Type: AWS::SNS::Topic\n    Properties:\n      TopicName: !Sub "\${AWS::StackName}-t"\n      DisplayName: !GetAtt A.Arn\n`;
    const b = JSON.stringify({
      Resources: { B: { Properties: { DisplayName: { "Fn::GetAtt": ["A", "Arn"] }, TopicName: { "Fn::Sub": "${AWS::StackName}-t" } }, Type: "AWS::SNS::Topic" } },
    });
    expect(canonicalText(a, "aws")).toBe(canonicalText(b, "aws"));
  });

  test("kubernetes documents are ordered by kind, namespace and name", () => {
    const a = "kind: Service\nmetadata: {name: b}\n---\nkind: ConfigMap\nmetadata: {name: a}\n";
    const b = "kind: ConfigMap\nmetadata: {name: a}\n---\nkind: Service\nmetadata: {name: b}\n";
    expect(canonicalText(a, "k8s")).toBe(canonicalText(b, "k8s"));
  });

  test("comments are not part of the comparison", () => {
    expect(canonicalText("# hi\nkind: Pod\nmetadata: {name: p}\n", "k8s")).toBe(canonicalText("kind: Pod\nmetadata: {name: p}\n", "k8s"));
  });
});

describe("difference classes", () => {
  const reasons = (a: string, b: string, lex: "aws" | "k8s" = "aws") => [...new Set(diffCanonical(a, b, lex).map((d) => d.reason))];

  test("dropped section and field", () => {
    expect(reasons('{"Description":"x","Resources":{"R":{"Type":"T","DeletionPolicy":"Retain"}}}', '{"Resources":{"R":{"Type":"T"}}}').sort()).toEqual(["field-dropped", "section-dropped"]);
  });
  test("added field", () => {
    expect(reasons('{"Resources":{}}', '{"Resources":{},"Outputs":{}}')).toEqual(["field-added"]);
  });
  test("string and number", () => {
    expect(reasons('{"A":"5"}', '{"A":5}')).toEqual(["type-coercion"]);
  });
  test("intrinsic form", () => {
    expect(reasons('{"A":{"Fn::Sub":"x"}}', '{"A":{"Fn::Sub":["x",{}]}}')).toEqual(["intrinsic-form"]);
  });
  test("api version and empty value", () => {
    expect(reasons("apiVersion: v1beta1\nkind: X\nmetadata: {name: a}\n", "apiVersion: v1\nkind: X\nmetadata: {name: a}\n", "k8s")).toEqual(["api-version-changed"]);
    expect(reasons("kind: X\nmetadata: {name: a}\nspec: {egress: [{}]}\n", "kind: X\nmetadata: {name: a}\nspec: {egress: null}\n", "k8s")).toEqual(["empty-value-collapsed"]);
  });
  test("failure classes", () => {
    expect(failureClass("stackOutput(ref): ref must be an attribute reference")).toBe("output-of-a-bare-Ref");
    expect(failureClass("LambdaIAMRole is not defined")).toBe("generated-file-references-missing-name");
  });
});

describe("measurement config", () => {
  test("builds with only the checks the inputs themselves trip turned off", () => {
    expect(measurementConfig("aws")).toContain('lint: { rules: {"WAW049":"off","WAW021":"off","WAW039":"off","WAW042":"off"} }');
    expect(measurementConfig("k8s")).toContain('lint: { rules: {"WK8005":"off"} }');
    expect(measurementConfig("aws")).not.toContain("WAW019");
    expect(measurementConfig("aws")).toContain("attribution: false");
  });
});

describe("recorded results", () => {
  const prov = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf-8")) as any[];

  test("every input has provenance and a vendored file", () => {
    expect(prov.filter((p) => p.lexicon === "aws").length).toBeGreaterThanOrEqual(10);
    expect(prov.filter((p) => p.lexicon === "k8s").length).toBeGreaterThanOrEqual(10);
    for (const p of prov) {
      expect(p.source).toMatch(/^https:\/\//);
      expect(p.license).toBeTruthy();
      expect(existsSync(join(dir, p.file))).toBe(true);
    }
  });

  test("results cover every input and the identical count has not dropped", () => {
    const r = JSON.parse(readFileSync(join(dir, "results.json"), "utf-8"));
    expect(r.entries.map((e: any) => e.file).sort()).toEqual(prov.map((p) => p.file).sort());
    const s = summarise(r.entries);
    expect(s.k8s.identical).toBeGreaterThanOrEqual(19);
    expect(s.aws.identical).toBeGreaterThanOrEqual(0);
    expect(r.summary.k8s.identical).toBe(s.k8s.identical);
  });
});
