import { describe, expect, it } from "vitest";
import { GOVERNANCE_VERBS, isGovernanceVerb, type GovernanceVerb } from "./governance.js";
import { renderChangeSet, runReconcile, type ChangeSet, type Cycle } from "./reconcile.js";

describe("governance verbs (#790)", () => {
  it("the runtime list and the type stay in sync", () => {
    // Compile-time: assigning the list's element type to GovernanceVerb and
    // back fails if either side gains a member the other lacks.
    const fromList: GovernanceVerb = GOVERNANCE_VERBS[0];
    const toList: (typeof GOVERNANCE_VERBS)[number] = "audit-sink" satisfies GovernanceVerb;
    expect(isGovernanceVerb(fromList)).toBe(true);
    expect(isGovernanceVerb(toList)).toBe(true);
    expect(isGovernanceVerb("teams")).toBe(false);
    expect(isGovernanceVerb(undefined)).toBe(false);
  });

  it("runReconcile stamps the cycle's verb onto entries that lack one", async () => {
    const cycle: Cycle<null, Record<string, never>, null> = {
      name: "teams",
      verb: "membership",
      fetchLive: async () => null,
      buildDesired: (c) => c,
      apply: async () => {},
    };
    const result = await runReconcile({
      scopes: { acme: {} },
      client: null,
      cycles: [cycle],
      mode: "apply",
      diff: (org) => ({
        org,
        entries: [
          { kind: "create", resourceType: "team", key: "platform" },
          // A diff that stamps its own verb wins over the cycle's.
          { kind: "delete", resourceType: "grant", key: "bot", verb: "identity-assignment" },
        ],
      }),
    });
    expect(result.cycles[0].verb).toBe("membership");
    expect(result.cycles[0].applied.map((e) => e.verb)).toEqual(["membership", "identity-assignment"]);
  });

  it("renderChangeSet groups by verb without changing line format", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "create", resourceType: "webhook", key: "audit", verb: "audit-sink" },
        { kind: "create", resourceType: "ou", key: "Security", verb: "org-unit" },
        { kind: "create", resourceType: "team", key: "platform", verb: "membership" },
      ],
    };
    const out = renderChangeSet(cs);
    // Vocabulary order: org-unit before membership before audit-sink.
    expect(out.indexOf("[ou] Security")).toBeLessThan(out.indexOf("[team] platform"));
    expect(out.indexOf("[team] platform")).toBeLessThan(out.indexOf("[webhook] audit"));
    // Line format is untouched — no verb appears in the rendering.
    expect(out).not.toContain("org-unit");
  });

  it("a verbless change set renders exactly as before", () => {
    const cs: ChangeSet = {
      org: "acme",
      entries: [
        { kind: "create", resourceType: "b", key: "2" },
        { kind: "create", resourceType: "a", key: "1" },
      ],
    };
    expect(renderChangeSet(cs)).toBe(
      "Plan for acme: 2 to create, 0 to update, 0 to delete\n\nCREATE:\n  [b] 2\n  [a] 1",
    );
  });
});
