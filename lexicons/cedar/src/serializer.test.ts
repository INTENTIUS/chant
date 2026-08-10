import { describe, test, expect } from "vitest";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { cedarSerializer, CEDAR_JSON_FILENAME, policyIdFromLogicalName } from "./serializer";

// ── Mock entities ──────────────────────────────────────────────────
//
// The typed policy classes arrive with schema-driven codegen (#1650); until
// then the serializer is exercised against the same shape they will produce.

function mockPolicy(props: Record<string, unknown>): Declarable {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "cedar",
    entityType: "Cedar::Policy",
    kind: "resource",
    props,
  } as unknown as Declarable;
}

function mockProperty(entityType: string, props: Record<string, unknown>): Declarable {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "cedar",
    entityType,
    kind: "property",
    props,
  } as unknown as Declarable;
}

function entitiesOf(...pairs: Array<[string, Declarable]>): Map<string, Declarable> {
  return new Map(pairs);
}

/** Every non-empty serialization is a SerializerResult — text plus JSON. */
function result(entities: Map<string, Declarable>): SerializerResult {
  const out = cedarSerializer.serialize(entities);
  if (typeof out === "string") throw new Error(`expected a SerializerResult, got: ${JSON.stringify(out)}`);
  return out;
}

function text(entities: Map<string, Declarable>): string {
  return result(entities).primary;
}

function json(entities: Map<string, Declarable>): {
  staticPolicies: Record<string, Record<string, unknown>>;
  templates: Record<string, unknown>;
  templateLinks: unknown[];
} {
  const files = result(entities).files ?? {};
  return JSON.parse(files[CEDAR_JSON_FILENAME] as string);
}

// ── 1–2. Identity ──────────────────────────────────────────────────

describe("cedar serializer identity", () => {
  test("name is the lexicon name", () => {
    expect(cedarSerializer.name).toBe("cedar");
  });

  test("rulePrefix is CED", () => {
    expect(cedarSerializer.rulePrefix).toBe("CED");
  });
});

// ── 3. Empty ───────────────────────────────────────────────────────

describe("empty input", () => {
  test("an empty map serializes to an empty string", () => {
    expect(cedarSerializer.serialize(new Map())).toBe("");
  });

  test("a map with nothing this lexicon owns also serializes to an empty string", () => {
    const foreign = {
      [DECLARABLE_MARKER]: true,
      lexicon: "docker",
      entityType: "Docker::Compose::Service",
      kind: "resource",
      props: { image: "nginx" },
    } as unknown as Declarable;
    expect(cedarSerializer.serialize(entitiesOf(["api", foreign]))).toBe("");
  });
});

// ── 4. Single resource ─────────────────────────────────────────────

describe("a single policy", () => {
  const entities = entitiesOf([
    "allowAliceRead",
    mockPolicy({
      effect: "permit",
      principal: { eq: 'User::"alice"' },
      action: { eq: 'Action::"read"' },
      resource: { is: "Photo" },
    }),
  ]);

  test("produces canonical Cedar policy text", () => {
    expect(text(entities)).toBe(
      `@id("allow-alice-read")
permit (
  principal == User::"alice",
  action == Action::"read",
  resource is Photo
);
`,
    );
  });

  test("produces a Cedar JSON policy-set file alongside it", () => {
    const doc = json(entities);
    expect(Object.keys(doc.staticPolicies)).toEqual(["allow-alice-read"]);
    expect(doc.templates).toEqual({});
    expect(doc.templateLinks).toEqual([]);
    expect(doc.staticPolicies["allow-alice-read"]).toMatchObject({
      effect: "permit",
      principal: { op: "==", entity: { type: "User", id: "alice" } },
      action: { op: "==", entity: { type: "Action", id: "read" } },
      resource: { op: "is", entity_type: "Photo" },
    });
  });

  test("the JSON file is the only extra file emitted", () => {
    expect(Object.keys(result(entities).files ?? {})).toEqual([CEDAR_JSON_FILENAME]);
  });
});

// ── 5. Generated name ──────────────────────────────────────────────

describe("policy id generation", () => {
  test("a camelCase export becomes a kebab-case @id", () => {
    const out = text(entitiesOf(["allowAdminReadAll", mockPolicy({ effect: "permit" })]));
    expect(out).toContain('@id("allow-admin-read-all")');
  });

  test("acronyms and underscores collapse the same way", () => {
    expect(policyIdFromLogicalName("allowMFAUsers")).toBe("allow-mfa-users");
    expect(policyIdFromLogicalName("legacy_policy_name")).toBe("legacy-policy-name");
    expect(policyIdFromLogicalName("simple")).toBe("simple");
  });
});

// ── 6. Explicit name preserved ─────────────────────────────────────

describe("explicit policy id", () => {
  const entities = entitiesOf([
    "allowAdminRead",
    mockPolicy({ effect: "permit", annotations: { id: "SOC2-AC-3" } }),
  ]);

  test("an author-set @id wins over the derived one", () => {
    const out = text(entities);
    expect(out).toContain('@id("SOC2-AC-3")');
    expect(out).not.toContain("allow-admin-read");
  });

  test("the JSON policy is keyed by the same id", () => {
    expect(Object.keys(json(entities).staticPolicies)).toEqual(["SOC2-AC-3"]);
  });
});

// ── 7. Multi-policy join ───────────────────────────────────────────

describe("multiple policies", () => {
  const entities = entitiesOf(
    ["allowRead", mockPolicy({ effect: "permit", action: { eq: 'Action::"read"' } })],
    ["denyDelete", mockPolicy({ effect: "forbid", action: { eq: 'Action::"delete"' } })],
  );

  test("policies are separated by a blank line and each ends in a semicolon", () => {
    const out = text(entities);
    expect(out.split("\n\n")).toHaveLength(2);
    expect(out.endsWith(";\n")).toBe(true);
    expect(out.match(/;/g)).toHaveLength(2);
  });

  test("both land in the JSON policy set, in declaration order", () => {
    expect(Object.keys(json(entities).staticPolicies)).toEqual(["allow-read", "deny-delete"]);
  });
});

// ── 8. Defaults ────────────────────────────────────────────────────

describe("defaults", () => {
  test("omitted scopes emit the unconstrained Cedar form", () => {
    const out = text(entitiesOf(["allowAnything", mockPolicy({ effect: "permit" })]));
    expect(out).toContain("permit (\n  principal,\n  action,\n  resource\n)");
  });

  test("an omitted effect defaults to permit", () => {
    expect(text(entitiesOf(["bare", mockPolicy({})]))).toContain("permit (");
  });

  test("an unconstrained scope is op: All in the JSON form", () => {
    const doc = json(entitiesOf(["allowAnything", mockPolicy({})]));
    expect(doc.staticPolicies["allow-anything"]).toMatchObject({
      principal: { op: "All" },
      action: { op: "All" },
      resource: { op: "All" },
      conditions: [],
    });
  });
});

// ── 9. Overrides win ───────────────────────────────────────────────

describe("overrides", () => {
  test("an explicit forbid overrides the permit default", () => {
    const out = text(entitiesOf(["denyAll", mockPolicy({ effect: "forbid" })]));
    expect(out).toContain("forbid (");
    expect(out).not.toContain("permit (");
  });

  test("an explicit scope overrides the unconstrained default", () => {
    const out = text(entitiesOf([
      "scoped",
      mockPolicy({ principal: { in: 'Group::"admins"' } }),
    ]));
    expect(out).toContain('principal in Group::"admins",');
  });
});

// ── 10. kind: "property" is skipped ────────────────────────────────

describe("property-kind entities", () => {
  test("a property Declarable is not emitted as its own policy", () => {
    const entities = entitiesOf(
      ["allowRead", mockPolicy({ effect: "permit" })],
      ["someScope", mockProperty("Cedar::Scope", { eq: 'User::"alice"' })],
    );
    expect(text(entities).match(/;/g)).toHaveLength(1);
    expect(Object.keys(json(entities).staticPolicies)).toEqual(["allow-read"]);
  });

  test("a property Declarable referenced from a policy is inlined, not named", () => {
    const scope = mockProperty("Cedar::Scope", { eq: 'User::"alice"' });
    const entities = entitiesOf(
      ["allowRead", mockPolicy({ effect: "permit", principal: scope })],
      ["aliceScope", scope],
    );
    expect(text(entities)).toContain('principal == User::"alice",');
  });
});

// ── 11. Key ordering ───────────────────────────────────────────────

describe("key ordering", () => {
  test("scope clauses emit principal, action, resource regardless of prop order", () => {
    const out = text(entitiesOf([
      "shuffled",
      mockPolicy({
        resource: { is: "Photo" },
        when: ["resource.owner == principal"],
        action: { eq: 'Action::"view"' },
        effect: "permit",
        principal: { is: "User" },
      }),
    ]));
    const lines = out.trim().split("\n");
    expect(lines).toEqual([
      '@id("shuffled")',
      "permit (",
      "  principal is User,",
      '  action == Action::"view",',
      "  resource is Photo",
      ")",
      "when { resource.owner == principal };",
    ]);
  });

  test("@id precedes the author's own annotations", () => {
    const out = text(entitiesOf([
      "annotated",
      mockPolicy({ annotations: { owner: "platform", ticket: "SEC-12" } }),
    ]));
    expect(out.split("\n").slice(0, 3)).toEqual([
      '@id("annotated")',
      '@owner("platform")',
      '@ticket("SEC-12")',
    ]);
  });
});

// ── 12. Cedar-specific: forbid with unless ─────────────────────────

describe("forbid with guards", () => {
  const entities = entitiesOf([
    "denyUnlessMfa",
    mockPolicy({
      effect: "forbid",
      principal: { is: "User", in: 'Group::"contractors"' },
      action: { in: ['Action::"delete"', 'Action::"purge"'] },
      when: ["resource.classification == \"restricted\""],
      unless: ["context.mfaAuthenticated", "principal.isBreakGlass"],
    }),
  ]);

  test("renders is/in, an action set, and every guard clause", () => {
    expect(text(entities)).toBe(
      `@id("deny-unless-mfa")
forbid (
  principal is User in Group::"contractors",
  action in [Action::"delete", Action::"purge"],
  resource
)
when { resource.classification == "restricted" }
unless { context.mfaAuthenticated }
unless { principal.isBreakGlass };
`,
    );
  });

  test("the JSON form carries the same scope and guards", () => {
    expect(json(entities).staticPolicies["deny-unless-mfa"]).toMatchObject({
      effect: "forbid",
      principal: { op: "is", entity_type: "User", in: { entity: { type: "Group", id: "contractors" } } },
      action: {
        op: "in",
        entities: [
          { type: "Action", id: "delete" },
          { type: "Action", id: "purge" },
        ],
      },
      resource: { op: "All" },
      conditions: [
        { kind: "when", body: { __expr: 'resource.classification == "restricted"' } },
        { kind: "unless", body: { __expr: "context.mfaAuthenticated" } },
        { kind: "unless", body: { __expr: "principal.isBreakGlass" } },
      ],
    });
  });
});

// ── Cedar-specific: annotations ────────────────────────────────────

describe("annotations", () => {
  test("each annotation becomes its own @key(\"value\") line", () => {
    const out = text(entitiesOf([
      "documented",
      mockPolicy({ annotations: { description: "read-only access", owner: "platform" } }),
    ]));
    expect(out).toContain('@description("read-only access")');
    expect(out).toContain('@owner("platform")');
  });

  test("quotes and backslashes in an annotation value are escaped", () => {
    const out = text(entitiesOf([
      "quoted",
      mockPolicy({ annotations: { note: 'say "hi"\\done' } }),
    ]));
    expect(out).toContain('@note("say \\"hi\\"\\\\done")');
  });

  test("annotations reach the JSON form with the id merged in", () => {
    const doc = json(entitiesOf([
      "documented",
      mockPolicy({ annotations: { owner: "platform" } }),
    ]));
    expect(doc.staticPolicies["documented"].annotations).toEqual({
      id: "documented",
      owner: "platform",
    });
  });
});

// ── Cedar-specific: entity UID parsing in the JSON form ────────────

describe("entity UID handling", () => {
  test("a namespaced type keeps its namespace", () => {
    const doc = json(entitiesOf([
      "namespaced",
      mockPolicy({ principal: { eq: 'PhotoApp::User::"alice"' } }),
    ]));
    expect(doc.staticPolicies["namespaced"].principal).toEqual({
      op: "==",
      entity: { type: "PhotoApp::User", id: "alice" },
    });
  });

  test("a single in-scope emits entity, an array emits entities", () => {
    const doc = json(entitiesOf([
      "grouped",
      mockPolicy({
        principal: { in: 'Group::"admins"' },
        action: { in: ['Action::"read"'] },
      }),
    ]));
    expect(doc.staticPolicies["grouped"].principal).toEqual({
      op: "in",
      entity: { type: "Group", id: "admins" },
    });
    expect(doc.staticPolicies["grouped"].action).toEqual({
      op: "in",
      entities: [{ type: "Action", id: "read" }],
    });
  });
});
