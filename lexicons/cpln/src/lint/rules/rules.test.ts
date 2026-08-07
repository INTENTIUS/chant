import { describe, expect, it } from "vitest";
import ts from "typescript";
import type { LintContext } from "@intentius/chant/lint/rule";
import { rules, noSecretLiteralsRule, preferResourceReferenceRule } from "./index";

function lint(rule: (typeof rules)[number], source: string) {
  const sourceFile = ts.createSourceFile("infra.ts", source, ts.ScriptTarget.Latest, true);
  return rule.check({ sourceFile, entities: [], filePath: "infra.ts", lexicon: "cpln" } as LintContext);
}

describe("cpln lint rules", () => {
  it("registers rules with unique ids under the CPL prefix", () => {
    expect(rules.length).toBeGreaterThan(0);
    const ids = rules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("CPL")).toBe(true);
  });
});

describe("CPL001 no secret literals", () => {
  it("flags a private key in a Secret", () => {
    const found = lint(
      noSecretLiteralsRule,
      `const s = new Secret({ name: "tls", type: "tls", data: { key: "-----BEGIN RSA PRIVATE KEY-----abc" } });`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].ruleId).toBe("CPL001");
    expect(found[0].severity).toBe("error");
    expect(found[0].line).toBe(1);
  });

  it("flags a database URL with an inline password in a Workload", () => {
    const found = lint(
      noSecretLiteralsRule,
      `const w = new Workload({ name: "api", gvc: "prod", spec: { containers: [{ env: [{ name: "URL", value: "postgres://u:p@host/db" }] }] } });`,
    );
    expect(found).toHaveLength(1);
  });

  it("flags an AWS access key id", () => {
    expect(
      lint(noSecretLiteralsRule, `const s = new Secret({ name: "k", data: { accessKey: "AKIAIOSFODNN7EXAMPLE" } });`),
    ).toHaveLength(1);
  });

  it("ignores credential shapes outside a cpln declaration", () => {
    // The rule is scoped to cpln constructors on purpose — a fixture in a test
    // file or an unrelated const is not this rule's business.
    expect(lint(noSecretLiteralsRule, `const fixture = "AKIAIOSFODNN7EXAMPLE";`)).toEqual([]);
  });

  it("accepts a secret reference", () => {
    expect(
      lint(
        noSecretLiteralsRule,
        `const w = new Workload({ spec: { containers: [{ env: [{ value: "cpln://secret/db.payload" }] }] } });`,
      ),
    ).toEqual([]);
  });
});

describe("CPL002 prefer a resource reference", () => {
  it("flags a hand-written GVC-qualified link", () => {
    const found = lint(
      preferResourceReferenceRule,
      `const w = new Workload({ name: "api", spec: { identityLink: "//gvc/prod/identity/api" } });`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
  });

  it("flags a hand-written org-scoped link", () => {
    expect(
      lint(preferResourceReferenceRule, `const p = new Policy({ targetLinks: ["//secret/db-password"] });`),
    ).toHaveLength(1);
  });

  it("leaves runtime resolution URIs alone", () => {
    // `cpln://secret/…` is read by the container at runtime, not a reference
    // between resources, so there is no reference form to prefer.
    expect(
      lint(
        preferResourceReferenceRule,
        `const w = new Workload({ spec: { containers: [{ env: [{ value: "cpln://secret/db.payload" }] }] } });`,
      ),
    ).toEqual([]);
    expect(
      lint(preferResourceReferenceRule, `const w = new Workload({ spec: { containers: [{ volumes: [{ uri: "cpln://volumeset/data" }] }] } });`),
    ).toEqual([]);
  });

  it("leaves location links alone", () => {
    // `/org/…/location/…` names a platform-provided resource this lexicon does
    // not model, so there is nothing to pass instead.
    expect(
      lint(
        preferResourceReferenceRule,
        `const g = new Gvc({ spec: { staticPlacement: { locationLinks: ["/org/acme/location/aws-us-east-1"] } } });`,
      ),
    ).toEqual([]);
  });

  it("ignores ordinary strings", () => {
    expect(lint(preferResourceReferenceRule, `const w = new Workload({ name: "api", description: "the api" });`)).toEqual(
      [],
    );
  });
});
