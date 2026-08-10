import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CedarParser } from "./parser";
import { CedarGenerator, loadActionConstants, sanitizeName } from "./generator";
import type { CedarPolicyIR } from "./parser";

const testdata = (file: string) => readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

const generate = (entities: CedarPolicyIR[], actionConstants?: Record<string, string>) =>
  new CedarGenerator({ actionConstants }).generate(entities).source;

const fromFixture = (file: string, actionConstants?: Record<string, string>) =>
  generate(new CedarParser().parse(testdata(file)).entities, actionConstants);

// ── 1–3. The shape of a generated policy ───────────────────────────

describe("emitting a policy", () => {
  test("1. a policy becomes an exported Policy construction", () => {
    expect(fromFixture("simple.cedar")).toContain("export const allowAliceRead = new Policy({");
  });

  test("2. every captured prop is emitted, with identifier keys unquoted", () => {
    const source = fromFixture("simple.cedar");
    expect(source).toContain('effect: "permit"');
    expect(source).toContain('principal: {\n    eq: "App::User::\\"alice\\""\n  }');
    expect(source).toContain('resource: {\n    is: "App::Document"\n  }');
    expect(source).toContain('id: "allow-alice-read"');
  });

  test("3. when and unless clauses are emitted as the strings they are", () => {
    const source = fromFixture("realistic.cedar");
    expect(source).toContain('when: [\n    "resource.owner == principal"\n  ]');
    expect(source).toContain('unless: [\n    "context.mfa == false"\n  ]');
  });
});

// ── 4–5. The import line ───────────────────────────────────────────

describe("the import line", () => {
  test("4. one line, naming the authoring class", () => {
    const lines = fromFixture("simple.cedar").split("\n");
    expect(lines[0]).toBe('import { Policy } from "@intentius/chant-lexicon-cedar";');
    expect(lines.filter((l) => l.startsWith("import "))).toHaveLength(1);
  });

  test("5. generated action constants join it, sorted, when the schema is known", () => {
    const source = fromFixture("realistic.cedar", loadActionConstants());
    expect(source.split("\n")[0]).toBe(
      'import { DeleteAction, ListAction, Policy, ReadAction, WriteAction } from "@intentius/chant-lexicon-cedar";',
    );
  });
});

// ── 6–7. Typed refs vs. literal fallback ───────────────────────────

describe("action refs", () => {
  test("6. a known action UID is emitted as its generated constant", () => {
    const source = fromFixture("realistic.cedar", loadActionConstants());
    expect(source).toContain("action: {\n    in: [\n      ReadAction,\n      ListAction\n    ]\n  }");
    expect(source).toContain("action: {\n    eq: DeleteAction\n  }");
  });

  test("7. with no registry the UID literal is the fallback, and still typechecks", () => {
    const source = fromFixture("realistic.cedar");
    expect(source).toContain('eq: "App::Action::\\"delete\\""');
    expect(source).not.toContain("DeleteAction");
  });

  test("an action UID inside a when clause is left as expression text", () => {
    const source = generate(
      [{ kind: "policy", name: "p", props: { effect: "permit", when: ['action == App::Action::"read"'] } }],
      { 'App::Action::"read"': "ReadAction" },
    );
    expect(source).toContain('"action == App::Action::\\"read\\""');
    expect(source.split("\n")[0]).toBe('import { Policy } from "@intentius/chant-lexicon-cedar";');
  });
});

// ── 8–9. Names ─────────────────────────────────────────────────────

describe("export names", () => {
  test("8. kebab-case and snake_case ids become camelCase exports", () => {
    expect(sanitizeName("allow-alice-read")).toBe("allowAliceRead");
    expect(sanitizeName("legacy_policy_name")).toBe("legacyPolicyName");
    expect(sanitizeName("simple")).toBe("simple");
    expect(sanitizeName("SOC2-AC-3")).toBe("soc2AC3");
    expect(sanitizeName("2fa-required")).toBe("policy2faRequired");
    expect(sanitizeName("class")).toBe("classPolicy");
    expect(sanitizeName("!!!")).toBe("policy");
  });

  test("9. two ids that reduce to the same identifier still get one export each", () => {
    const source = generate([
      { kind: "policy", name: "allow-read", props: { effect: "permit" } },
      { kind: "policy", name: "allow.read", props: { effect: "forbid" } },
    ]);
    expect(source).toContain("export const allowRead = ");
    expect(source).toContain("export const allowRead2 = ");
  });
});

// ── 10–11. Templates and empty input ───────────────────────────────

describe("templates and empty documents", () => {
  test("10. a template is emitted with its slots, and called out in a comment", () => {
    const source = fromFixture("full.cedar");
    expect(source).toContain("/** Cedar template");
    expect(source).toContain("export const shareWithSlots = new Policy({");
    expect(source).toContain('eq: "?principal"');
    expect(source).toContain('in: "?resource"');
  });

  test("11. an empty document still emits a compilable file, with a warning", () => {
    const { source, warnings } = new CedarGenerator().generate([]);
    expect(source).toBe('import { Policy } from "@intentius/chant-lexicon-cedar";\n');
    expect(warnings).toEqual(["no Cedar policies were found in this document"]);
  });
});

// ── The registry lookup ────────────────────────────────────────────

describe("loadActionConstants", () => {
  test("maps every generated action UID to its constant", () => {
    const constants = loadActionConstants();
    expect(constants['App::Action::"read"']).toBe("ReadAction");
    expect(Object.values(constants).every((name) => name.endsWith("Action"))).toBe(true);
  });

  test("a package with no generated registry yields no constants, not a throw", () => {
    expect(loadActionConstants("/nowhere/at/all")).toEqual({});
  });
});
