/**
 * Positive and negative tests for every cedar post-synth check.
 *
 * Contexts are built with `createPostSynthContext` from the shared test utils
 * (the pattern the post-synth authoring guide documents). It serializes each
 * output object to JSON, which is exactly the artifact these checks read — the
 * `policies.cedar.json` policy-set envelope. `makePostSynthCtxFromFiles` covers
 * the two places the multi-file `SerializerResult` shape is load-bearing: the
 * schema discovery CEDE010/CEDE011 need, and the "two policy sets in one
 * build" case CEDC012 exists for.
 */
import { describe, test, expect } from "vitest";
import { createPostSynthContext, makePostSynthCtxFromFiles } from "@intentius/chant-test-utils";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { CEDAR_JSON_FILENAME } from "../../serializer";
import { postSynthChecks } from ".";
import { cedc010 } from "./cedc010";
import { cedc011 } from "./cedc011";
import { cedc012 } from "./cedc012";
import { cedc013 } from "./cedc013";
import { cedc014 } from "./cedc014";
import { cede010 } from "./cede010";
import { cede011 } from "./cede011";
import { ceds010 } from "./ceds010";
import { ceds011 } from "./ceds011";
import { ceds012 } from "./ceds012";

// ── Fixtures ───────────────────────────────────────────────────────

const ALL = { op: "All" } as const;

/** A policy in the shape the serializer emits. */
function policy(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect: "permit",
    principal: ALL,
    action: ALL,
    resource: ALL,
    conditions: [],
    annotations: {},
    ...over,
  };
}

function uid(type: string, id: string): Record<string, unknown> {
  return { type, id };
}

/** A policy set with the annotations chant's serializer always writes. */
function set(policies: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const staticPolicies: Record<string, unknown> = {};
  for (const [id, p] of Object.entries(policies)) {
    const annotations = { id, ...(p.annotations as Record<string, unknown> | undefined) };
    staticPolicies[id] = { ...p, annotations };
  }
  return { staticPolicies, templates: {}, templateLinks: [] };
}

function ctx(policies: Record<string, Record<string, unknown>>, env?: string): PostSynthContext {
  return { ...createPostSynthContext({ cedar: set(policies) }), env };
}

/** A safe, fully-constrained policy set that no check has anything to say about. */
const CLEAN = {
  "allow-admin-read": policy({
    principal: { op: "in", entity: uid("Chant::Group", "admins") },
    action: { op: "==", entity: uid("Chant::Action", "read") },
    resource: { op: "is", entity_type: "Chant::Repo" },
    conditions: [{ kind: "when", body: { __expr: "context.mfa == true" } }],
  }),
  "forbid-frozen": policy({
    effect: "forbid",
    resource: { op: "is", entity_type: "Chant::Repo" },
    conditions: [{ kind: "when", body: { __expr: "resource.frozen == true" } }],
  }),
};

// A schema covering the CLEAN set, for the validator-backed checks.
const SCHEMA = `
namespace Chant {
  entity Group;
  entity User in [Group] { frozen?: Bool };
  entity Repo { frozen: Bool };
  action read appliesTo { principal: [User], resource: [Repo], context: { mfa: Bool } };
  action write appliesTo { principal: [User], resource: [Repo], context: { mfa: Bool } };
}
`;

function ctxWithSchema(
  policies: Record<string, Record<string, unknown>>,
  schema: string = SCHEMA,
): PostSynthContext {
  return makePostSynthCtxFromFiles(
    "cedar",
    {
      [CEDAR_JSON_FILENAME]: JSON.stringify(set(policies)),
      "chant.cedarschema": schema,
    },
    "// cedar text",
  );
}

// ── Barrel ─────────────────────────────────────────────────────────

describe("the cedar post-synth barrel", () => {
  test("ships every check exactly once, all under the CED prefix", () => {
    const ids = postSynthChecks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("CED"))).toBe(true);
    expect(ids.length).toBeGreaterThanOrEqual(10);
  });

  test("every check is silent on a build with no cedar output", () => {
    const empty = createPostSynthContext({ k8s: { kind: "ConfigMap" } });
    for (const check of postSynthChecks) {
      expect(check.check(empty), check.id).toEqual([]);
    }
  });

  test("every check is silent on a clean, fully-constrained policy set", () => {
    const clean = ctxWithSchema(CLEAN);
    for (const check of postSynthChecks) {
      expect(check.check(clean).map((d) => d.message), check.id).toEqual([]);
    }
  });
});

// ── CEDC010 ────────────────────────────────────────────────────────

describe("CEDC010: the emitted policy set must parse as Cedar", () => {
  test("flags a policy set that is not readable as JSON", () => {
    const broken: PostSynthContext = {
      ...createPostSynthContext({}),
      outputs: new Map([["cedar", "{ not json"]]),
    };
    const diags = cedc010.check(broken);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDC010");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("not readable as JSON");
  });

  test("flags a policy whose scope Cedar's deserializer rejects", () => {
    const diags = cedc010.check(ctx({ bad: policy({ principal: { op: "nonsense" } }) }));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("CEDC010");
    expect(diags[0].severity).toBe("error");
  });

  test("passes a policy set Cedar parses", () => {
    expect(cedc010.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDC011 ────────────────────────────────────────────────────────

describe("CEDC011: condition expressions must parse", () => {
  test("flags an unparseable when clause and names the expression", () => {
    const diags = cedc011.check(
      ctx({ "bad-guard": policy({ conditions: [{ kind: "when", body: { __expr: "context.mfa ==" } }] }) }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDC011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("bad-guard");
    expect(diags[0].message).toContain("context.mfa ==");
  });

  test("flags an unparseable unless clause too", () => {
    const diags = cedc011.check(
      ctx({ "bad-guard": policy({ conditions: [{ kind: "unless", body: { __expr: "resource." } }] }) }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("unless clause");
  });

  test("passes expressions Cedar parses", () => {
    expect(cedc011.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDC012 ────────────────────────────────────────────────────────

describe("CEDC012: no two policies may claim the same id", () => {
  test("flags two policies annotating the same @id", () => {
    const clash = {
      staticPolicies: {
        "allow-read": { ...policy(), annotations: { id: "shared" } },
        "allow-list": { ...policy(), annotations: { id: "shared" } },
      },
    };
    const diags = cedc012.check(createPostSynthContext({ cedar: clash }));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDC012");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("shared");
    expect(diags[0].message).toContain("allow-read");
    expect(diags[0].message).toContain("allow-list");
  });

  test("flags the same id emitted into two policy sets in one build", () => {
    const one = JSON.stringify(set({ "allow-read": policy() }));
    const clash = makePostSynthCtxFromFiles("cedar", {
      "a.cedar.json": one,
      "b.cedar.json": one,
    });
    const diags = cedc012.check(clash);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("allow-read");
  });

  test("passes distinct ids", () => {
    expect(cedc012.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDC013 ────────────────────────────────────────────────────────

describe("CEDC013: annotation hygiene", () => {
  test("flags an @id annotation that disagrees with the policy id", () => {
    const mismatch = { staticPolicies: { "allow-read": { ...policy(), annotations: { id: "something-else" } } } };
    const diags = cedc013.check(createPostSynthContext({ cedar: mismatch }));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDC013");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("something-else");
  });

  test("flags an empty annotation value", () => {
    const diags = cedc013.check(ctx({ "allow-read": policy({ annotations: { doc: "  " } }) }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("empty @doc");
  });

  test("flags a non-string annotation value", () => {
    const diags = cedc013.check(ctx({ "allow-read": policy({ annotations: { doc: 7 } }) }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("non-string @doc");
  });

  test("a missing @id is not a finding — chant derives one", () => {
    const derived = { staticPolicies: { "allow-read": policy() } };
    expect(cedc013.check(createPostSynthContext({ cedar: derived }))).toHaveLength(0);
  });

  test("passes matching ids and non-empty annotations", () => {
    expect(cedc013.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDC014 ────────────────────────────────────────────────────────

describe("CEDC014: scope entity references must be full UIDs", () => {
  test("flags the empty-id degradation a non-UID reference produces", () => {
    const diags = cedc014.check(
      ctx({ "allow-read": policy({ principal: { op: "==", entity: uid("alice", "") } }) }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDC014");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("principal");
  });

  test("flags a degraded reference inside an in-list", () => {
    const diags = cedc014.check(
      ctx({
        "allow-read": policy({
          action: { op: "in", entities: [uid("Chant::Action", "read"), uid("write", "")] },
        }),
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("action");
  });

  test("flags a degraded reference under an `is T in E` constraint", () => {
    const diags = cedc014.check(
      ctx({
        "allow-read": policy({
          resource: { op: "is", entity_type: "Chant::Repo", in: { entity: uid("core", "") } },
        }),
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("resource");
  });

  test("passes well-formed UIDs and unconstrained scopes", () => {
    expect(cedc014.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDE010 ────────────────────────────────────────────────────────

describe("CEDE010: the policy set validates against the schema", () => {
  test("flags a policy naming an entity type the schema does not define", () => {
    const diags = cede010.check(
      ctxWithSchema({
        ghost: policy({
          principal: { op: "is", entity_type: "Chant::Ghost" },
          action: { op: "==", entity: uid("Chant::Action", "read") },
          resource: { op: "is", entity_type: "Chant::Repo" },
        }),
      }),
    );
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("CEDE010");
    expect(diags[0].severity).toBe("error");
    expect(diags.map((d) => d.message).join(" ")).toContain("Ghost");
  });

  test("flags a policy naming an attribute the schema does not define", () => {
    const diags = cede010.check(
      ctxWithSchema({
        typo: policy({
          principal: { op: "is", entity_type: "Chant::User" },
          action: { op: "==", entity: uid("Chant::Action", "read") },
          resource: { op: "is", entity_type: "Chant::Repo" },
          conditions: [{ kind: "when", body: { __expr: "resource.frozn == true" } }],
        }),
      }),
    );
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain("frozn");
  });

  test("reports validation errors in a stable order (the wasm's own order is not)", () => {
    const noisy = ctxWithSchema({
      "ghost-a": policy({
        principal: { op: "is", entity_type: "Chant::Ghost" },
        action: { op: "==", entity: uid("Chant::Action", "read") },
        resource: { op: "is", entity_type: "Chant::Repo" },
      }),
      "ghost-b": policy({
        principal: { op: "is", entity_type: "Chant::Phantom" },
        action: { op: "==", entity: uid("Chant::Action", "write") },
        resource: { op: "is", entity_type: "Chant::Repo" },
      }),
    });
    const runs = Array.from({ length: 8 }, () => cede010.check(noisy).map((d) => d.message));
    for (const run of runs) expect(run).toEqual(runs[0]);
    expect(runs[0].length).toBeGreaterThanOrEqual(2);
  });

  test("advises rather than passing silently when no schema was emitted", () => {
    const diags = cede010.check(ctx(CLEAN));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("No Cedar schema");
  });

  test("passes a policy set the validator accepts", () => {
    expect(cede010.check(ctxWithSchema(CLEAN))).toHaveLength(0);
  });
});

// ── CEDE011 ────────────────────────────────────────────────────────

describe("CEDE011: the validator's warnings", () => {
  test("flags an impossible policy", () => {
    const diags = cede011.check(
      ctxWithSchema({
        impossible: policy({
          principal: { op: "is", entity_type: "Chant::User" },
          action: { op: "==", entity: uid("Chant::Action", "read") },
          resource: { op: "is", entity_type: "Chant::Repo" },
          conditions: [{ kind: "when", body: { __expr: "1 == 2" } }],
        }),
      }),
    );
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("CEDE011");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("impossible");
  });

  test("says nothing about a policy set the validator is happy with", () => {
    expect(cede011.check(ctxWithSchema(CLEAN))).toHaveLength(0);
  });

  test("stays quiet when there is no schema — CEDE010 owns that advisory", () => {
    expect(cede011.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDS010 ────────────────────────────────────────────────────────

describe("CEDS010: the bare-permit wall", () => {
  test("errors on a bare permit in a production build", () => {
    const diags = ceds010.check(ctx({ "allow-all": policy() }, "prod"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDS010");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("allow-all");
  });

  test("warns on the same policy outside production", () => {
    const diags = ceds010.check(ctx({ "allow-all": policy() }));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("a forbid over everything is not the finding — a deny-all is safe", () => {
    expect(ceds010.check(ctx({ "deny-all": policy({ effect: "forbid" }) }, "prod"))).toHaveLength(0);
  });

  test("a single when guard is enough to take it out of scope", () => {
    const guarded = ctx(
      { "allow-all": policy({ conditions: [{ kind: "when", body: { __expr: "context.mfa" } }] }) },
      "prod",
    );
    expect(ceds010.check(guarded)).toHaveLength(0);
  });

  test("passes a constrained permit", () => {
    expect(ceds010.check(ctx(CLEAN, "prod"))).toHaveLength(0);
  });
});

// ── CEDS011 ────────────────────────────────────────────────────────

describe("CEDS011: a policy set with no forbid", () => {
  test("warns once for a permit-only set", () => {
    const diags = ceds011.check(
      ctx({
        "allow-read": policy({ principal: { op: "in", entity: uid("Chant::Group", "admins") } }),
        "allow-write": policy({ principal: { op: "in", entity: uid("Chant::Group", "admins") } }),
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDS011");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes a set carrying a forbid", () => {
    expect(ceds011.check(ctx(CLEAN))).toHaveLength(0);
  });
});

// ── CEDS012 ────────────────────────────────────────────────────────

describe("CEDS012: an unconstrained action scope", () => {
  test("warns on a permit that constrains the principal but not the action", () => {
    const diags = ceds012.check(
      ctx({
        "allow-admins": policy({
          principal: { op: "in", entity: uid("Chant::Group", "admins") },
        }),
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("CEDS012");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("allow-admins");
  });

  test("leaves the fully-bare permit to CEDS010", () => {
    expect(ceds012.check(ctx({ "allow-all": policy() }))).toHaveLength(0);
  });

  test("says nothing about a forbid over every action", () => {
    const denyAll = ctx({
      "forbid-frozen": policy({
        effect: "forbid",
        resource: { op: "is", entity_type: "Chant::Repo" },
      }),
    });
    expect(ceds012.check(denyAll)).toHaveLength(0);
  });

  test("passes a permit naming its actions", () => {
    expect(ceds012.check(ctx(CLEAN))).toHaveLength(0);
  });
});
