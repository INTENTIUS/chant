import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CedarParser, isPolicySetEnvelope } from "./parser";
import { extractClauses } from "./clause-text";

const testdata = (file: string) => readFileSync(join(import.meta.dirname, "testdata", file), "utf8");

const parse = (content: string) => new CedarParser().parse(content);

/** The one policy in a single-policy document. */
const only = (content: string) => {
  const { entities } = parse(content);
  expect(entities).toHaveLength(1);
  return entities[0];
};

const byName = (content: string, name: string) => {
  const found = parse(content).entities.find((e) => e.name === name);
  if (!found) throw new Error(`no policy named ${name}`);
  return found;
};

// ── 1–4. Scope constraints ─────────────────────────────────────────

describe("scope constraints", () => {
  test("1. `== E` becomes an eq scope carrying the full entity UID", () => {
    expect(only(testdata("simple.cedar")).props.principal).toEqual({ eq: 'App::User::"alice"' });
  });

  test("2. `is T` becomes an is scope", () => {
    expect(only(testdata("simple.cedar")).props.resource).toEqual({ is: "App::Document" });
  });

  test("3. `is T in E` keeps both halves", () => {
    expect(byName(testdata("full.cedar"), "full-grant").props.principal).toEqual({
      is: "App::User",
      in: 'App::Group::"engineering"',
    });
  });

  test("4. an action set becomes an in scope with an array", () => {
    expect(byName(testdata("realistic.cedar"), "owner-read").props.action).toEqual({
      in: ['App::Action::"read"', 'App::Action::"list"'],
    });
  });

  test("a one-element action set is Cedar's own normalization, not a lost prop", () => {
    // `action in [X]` and `action in X` are the same constraint, and the module
    // collapses the first into the second before this file ever sees it — so a
    // round-trip rewrites the brackets away and cannot be made not to.
    const { entities } = parse('@id("one") permit (principal, action in [App::Action::"read"], resource);');
    expect(entities[0].props.action).toEqual({ in: 'App::Action::"read"' });
  });
});

// ── 5–6. Effects and unconstrained scopes ──────────────────────────

describe("effect and defaults", () => {
  test("5. forbid is captured as the effect", () => {
    expect(byName(testdata("full.cedar"), "deny-anonymous").props.effect).toBe("forbid");
  });

  test("6. an unconstrained scope is left out — `{}` and absent are one value", () => {
    const props = byName(testdata("full.cedar"), "deny-anonymous").props;
    expect(props.principal).toBeUndefined();
    expect(props.action).toBeUndefined();
    expect(props.resource).toBeUndefined();
    expect(Object.keys(props)).toEqual(["effect", "annotations"]);
  });
});

// ── 7–9. Conditions ────────────────────────────────────────────────

describe("conditions", () => {
  test("7. a when clause survives as the text it was written as", () => {
    expect(byName(testdata("realistic.cedar"), "owner-read").props.when).toEqual([
      "resource.owner == principal",
    ]);
  });

  test("8. when and unless are captured separately, each in order", () => {
    const props = byName(testdata("full.cedar"), "full-grant").props;
    expect(props.when).toEqual([
      "resource.owner == principal && context.mfa == true",
      'principal.department == "eng"',
    ]);
    expect(props.unless).toEqual([
      'resource.classification == "secret"',
      'context.ip.isInRange(ip("10.0.0.0/8"))',
    ]);
  });

  test("9. braces inside a string literal do not end the clause", () => {
    expect(byName(testdata("full.cedar"), "quoted-note").props.when).toEqual([
      'context.note == "a } b { c"',
    ]);
  });
});

// ── 10–11. Annotations ─────────────────────────────────────────────

describe("annotations", () => {
  test("10. every annotation is captured, including the id", () => {
    expect(byName(testdata("full.cedar"), "full-grant").props.annotations).toEqual({
      doc: "Everything the authoring model can carry, in one policy.",
      id: "full-grant",
      owner: "platform",
      ticket: "SEC-12",
    });
  });

  test("11. escapes in an annotation value are decoded, not carried as source", () => {
    expect(byName(testdata("full.cedar"), "quoted-note").props.annotations).toMatchObject({
      note: 'say "hi" \\ done',
    });
  });
});

// ── 12–13. Templates and document shape ────────────────────────────

describe("templates", () => {
  test("12. a policy with slots is read as a template, with the slots kept", () => {
    const template = byName(testdata("full.cedar"), "share-with-slots");
    expect(template.kind).toBe("template");
    expect(template.props.principal).toEqual({ eq: "?principal" });
    expect(template.props.resource).toEqual({ in: "?resource" });
  });

  test("13. static policies and templates come back from one document", () => {
    const { entities } = parse(testdata("full.cedar"));
    expect(entities.map((e) => `${e.kind}:${e.name}`)).toEqual([
      "policy:full-grant",
      "policy:deny-anonymous",
      "policy:quoted-note",
      "template:share-with-slots",
    ]);
  });
});

// ── 14–16. The JSON policy-set envelope ────────────────────────────

describe("the JSON policy-set envelope", () => {
  test("14. an envelope parses to the same policies as the text beside it", () => {
    const fromText = parse(testdata("full.cedar")).entities;
    const fromJSON = parse(testdata("full.cedar.json")).entities;
    expect(fromJSON.map((e) => `${e.kind}:${e.name}`)).toEqual(fromText.map((e) => `${e.kind}:${e.name}`));
    expect(fromJSON[0].props.annotations).toEqual(fromText[0].props.annotations);
  });

  test("15. an envelope's conditions come back re-rendered, since there is no source to quote", () => {
    const props = parse(testdata("full.cedar.json")).entities[0].props;
    // Semantically the same clause as the text fixture's, defensively
    // parenthesized on the way out of the module (#1648 §1).
    expect(props.when).toEqual([
      "((resource.owner) == principal) && ((context.mfa) == true)",
      '(principal.department) == "eng"',
    ]);
  });

  test("16. template links are reported rather than silently dropped", () => {
    const { warnings } = parse(
      JSON.stringify({
        staticPolicies: {},
        templates: {
          t: {
            effect: "permit",
            principal: { op: "==", slot: "?principal" },
            action: { op: "All" },
            resource: { op: "All" },
            conditions: [],
            annotations: { id: "t" },
          },
        },
        templateLinks: [{ templateId: "t", newId: "t0", values: { "?principal": { type: "App::User", id: "a" } } }],
      }),
    );
    expect(warnings.join(" ")).toContain("template link(s) were not imported");
  });

  test("an envelope keyed by id names the policy even without an @id annotation", () => {
    const { entities } = parse(
      JSON.stringify({
        staticPolicies: {
          "from-the-key": {
            effect: "permit",
            principal: { op: "All" },
            action: { op: "All" },
            resource: { op: "All" },
            conditions: [],
          },
        },
      }),
    );
    expect(entities.map((e) => e.name)).toEqual(["from-the-key"]);
  });

  test("staticPolicies given as raw Cedar text is read as text", () => {
    const { entities } = parse(JSON.stringify({ staticPolicies: testdata("simple.cedar") }));
    expect(entities.map((e) => e.name)).toEqual(["allow-alice-read"]);
  });
});

// ── 17–18. Document-level behaviour ────────────────────────────────

describe("documents", () => {
  test("17. an empty document produces no entities and no noise", () => {
    expect(parse("   \n  ")).toEqual({ entities: [], warnings: [] });
  });

  test("18. text the module rejects raises rather than importing half a policy", () => {
    expect(() => parse("this is not cedar")).toThrow(/could not parse the policy document/);
  });

  test("comments are dropped — they are in no grammar the module round-trips", () => {
    const { entities } = parse(`// a note about alice\n${testdata("simple.cedar")}`);
    expect(entities).toHaveLength(1);
    expect(JSON.stringify(entities[0].props)).not.toContain("a note about alice");
  });
});

// ── The envelope shape test ────────────────────────────────────────

describe("isPolicySetEnvelope", () => {
  test("accepts the serializer's own document", () => {
    expect(isPolicySetEnvelope(JSON.parse(testdata("full.cedar.json")))).toBe(true);
  });

  test("rejects a document carrying keys Cedar has never heard of", () => {
    expect(isPolicySetEnvelope({ apiVersion: "v1", kind: "Pod" })).toBe(false);
    expect(isPolicySetEnvelope({ staticPolicies: {}, Resources: {} })).toBe(false);
    expect(isPolicySetEnvelope([])).toBe(false);
    expect(isPolicySetEnvelope(null)).toBe(false);
    expect(isPolicySetEnvelope({ templateLinks: [] })).toBe(false);
  });
});

// ── The clause scanner on its own ──────────────────────────────────

describe("extractClauses", () => {
  test("returns the bodies of every clause, in order", () => {
    expect(
      extractClauses('@id("x")\npermit (principal, action, resource)\nwhen { a == 1 }\nunless { b };'),
    ).toEqual([
      { kind: "when", body: "a == 1" },
      { kind: "unless", body: "b" },
    ]);
  });

  test("an annotation's parentheses are not mistaken for the scope's", () => {
    expect(extractClauses('@doc("(not the scope)")\npermit (principal, action, resource);')).toEqual([]);
  });

  test("a comment inside a clause is skipped, braces and all", () => {
    expect(extractClauses("permit (principal, action, resource)\nwhen {\n  // } not the end\n  a\n};")).toEqual([
      { kind: "when", body: "// } not the end\n  a" },
    ]);
  });

  test("gives up rather than guessing at anything it does not recognize", () => {
    expect(extractClauses("permit (principal, action, resource) when { unbalanced ;")).toBeNull();
    expect(extractClauses("allow (principal, action, resource);")).toBeNull();
    expect(extractClauses("permit (principal, action, resource); trailing")).toBeNull();
  });
});
