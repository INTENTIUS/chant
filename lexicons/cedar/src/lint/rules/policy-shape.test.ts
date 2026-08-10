import { describe, test, expect } from "vitest";
import { createMockLintContext } from "@intentius/chant-test-utils";
import { cedarPolicyShapeRule } from "./policy-shape";
import { rules } from ".";

function check(source: string, filePath = "policies.ts") {
  return cedarPolicyShapeRule.check(createMockLintContext(source, filePath));
}

const IMPORT = `import { Policy } from "@intentius/chant-lexicon-cedar";\n`;

describe("CEDC001: Cedar policy shape", () => {
  test("is wired into the lexicon's rule list", () => {
    expect(rules.map((r) => r.id)).toContain("CEDC001");
    expect(cedarPolicyShapeRule.severity).toBe("error");
    expect(cedarPolicyShapeRule.category).toBe("correctness");
  });

  test('flags effect: "deny" — the word every other policy language uses', () => {
    const diags = check(`${IMPORT}export const p = new Policy("blockOutsiders", { effect: "deny" });`);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("CEDC001");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain('"deny"');
    expect(diags[0].line).toBe(2);
    expect(diags[0].column).toBeGreaterThan(0);
  });

  test("flags any other non-Cedar effect", () => {
    const diags = check(`${IMPORT}export const p = new Policy("p", { effect: "Permit" });`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Permit");
  });

  test("flags an empty when entry", () => {
    const diags = check(`${IMPORT}export const p = new Policy("p", { when: ["", "context.mfa"] });`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("empty when clause");
  });

  test("flags a whitespace-only unless entry", () => {
    const diags = check(`${IMPORT}export const p = new Policy("p", { unless: ["   "] });`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("empty unless clause");
  });

  test("flags an empty guard given as a bare string rather than an array", () => {
    const diags = check(`${IMPORT}export const p = new Policy("p", { when: "" });`);
    expect(diags).toHaveLength(1);
  });

  test("reports both problems on one declaration", () => {
    const diags = check(`${IMPORT}export const p = new Policy("p", { effect: "allow", when: [""] });`);
    expect(diags).toHaveLength(2);
  });

  test("works on a factory call as well as a constructor", () => {
    const source = `import { policy } from "@intentius/chant-lexicon-cedar";\nexport const p = policy({ effect: "deny" });`;
    expect(check(source)).toHaveLength(1);
  });

  test("passes a well-formed permit", () => {
    const source = `${IMPORT}export const p = new Policy("allowAdminRead", {
      effect: "permit",
      principal: { in: 'Chant::Group::"admins"' },
      when: ["context.mfa == true"],
    });`;
    expect(check(source)).toHaveLength(0);
  });

  test("passes a well-formed forbid, and an omitted effect", () => {
    expect(check(`${IMPORT}export const p = new Policy("p", { effect: "forbid" });`)).toHaveLength(0);
    expect(check(`${IMPORT}export const p = new Policy("p", { when: ["resource.frozen"] });`)).toHaveLength(0);
  });

  test("ignores an effect built from anything but a string literal", () => {
    const source = `${IMPORT}const e = "deny";\nexport const p = new Policy("p", { effect: e });`;
    expect(check(source)).toHaveLength(0);
  });

  test("ignores a file that imports nothing from this lexicon", () => {
    const source = `import { Bucket } from "@intentius/chant-lexicon-aws";\nexport const b = new Bucket("b", { effect: "deny", when: [""] });`;
    expect(check(source)).toHaveLength(0);
  });

  test("ignores a call to something not imported from this lexicon", () => {
    const source = `${IMPORT}export const other = new Something({ effect: "deny" });`;
    expect(check(source)).toHaveLength(0);
  });
});
