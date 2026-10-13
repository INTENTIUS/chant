/**
 * A cedar policy set as a gate's approval policy (chant#2508), evaluated by
 * the real cedar-wasm, and reached through core's loader the way `chant
 * approve` reaches it.
 */
import { describe, test, expect } from "vitest";
import { gatePolicyRequest, gatePolicyVersion, loadGatePolicyEvaluator, gateApprovalProblems } from "@intentius/chant/op";
import { Policy, type EntityTypeName, type PolicyRef } from "./generated/index";
import { DenyByDefaultSet } from "./composites/deny-by-default-set";
import { evaluateGatePolicy, gatePolicy, GATE_AGENT_TYPE, PASS_GATE_ACTION } from "./gate-policy";

const PLAN = `sha256:${"a".repeat(64)}`;

// The generated scope types are narrowed to this package's sample `App::`
// schema. A project writing gate policies declares the `Chant` namespace in
// its own schema, and then these names type-check without a cast.
const AGENT = GATE_AGENT_TYPE as EntityTypeName;
const PASS_GATE = PASS_GATE_ACTION as unknown as PolicyRef;
const MAINTAINER = 'Chant::Role::"maintainer"' as unknown as PolicyRef;

const agentLowRisk = new Policy({
  effect: "permit",
  principal: { is: AGENT },
  action: { eq: PASS_GATE },
  when: ['context.risk == "low"'],
});
const maintainers = new Policy({
  effect: "permit",
  principal: { in: MAINTAINER },
  action: { eq: PASS_GATE },
});

function ask(kind: "human" | "agent", name: string, context: Record<string, unknown>, roles: string[] = []) {
  return gatePolicyRequest({
    op: "release", gate: "ship", resolvedBy: name, approver: { kind, roles }, planDigest: PLAN, context,
  });
}

describe("gatePolicy (chant#2508)", () => {
  test("renders the set to Cedar text with ids from the record keys, stamped with its digest", () => {
    const ref = gatePolicy("ship", { agentLowRisk, maintainers });
    expect(ref.kind).toBe("gate-policy");
    expect(ref.lexicon).toBe("cedar");
    expect(ref.text).toContain('@id("agent-low-risk")');
    expect(ref.text).toContain('@id("maintainers")');
    expect(ref.text).toContain("principal is Chant::Agent");
    expect(ref.version).toBe(gatePolicyVersion(ref.text));
    expect(gateApprovalProblems({ policy: ref, mode: "enforce" })).toEqual([]);
  });

  test("refuses a member that is not a cedar policy", () => {
    expect(() => gatePolicy("ship", [{ entityType: "Other::Thing" } as never])).toThrow("not a Cedar::Policy");
  });

  test("refuses a set that does not parse", () => {
    const broken = new Policy({ effect: "permit", when: ["context.risk =="] });
    expect(() => gatePolicy("ship", [broken])).toThrow("does not parse");
  });
});

describe("evaluateGatePolicy (chant#2508)", () => {
  const ref = gatePolicy("ship", { agentLowRisk, maintainers });

  test("permits an agent on a low-risk plan, naming the rule", () => {
    expect(evaluateGatePolicy(ref, ask("agent", "release-bot", { risk: "low" }))).toEqual({
      decision: "allow", determining: ["agent-low-risk"], errors: [],
    });
  });

  test("denies the same agent on a high-risk plan", () => {
    expect(evaluateGatePolicy(ref, ask("agent", "release-bot", { risk: "high" })).decision).toBe("deny");
  });

  test("reads a claimed role as a parent entity", () => {
    expect(evaluateGatePolicy(ref, ask("human", "alex", {}, ["maintainer"])).determining).toEqual(["maintainers"]);
    expect(evaluateGatePolicy(ref, ask("human", "pat", {}, ["viewer"])).decision).toBe("deny");
  });

  test("a policy that errors on a request does not apply, and the error is reported", () => {
    // `context.risk` is absent, so the agent rule errors rather than matching.
    const answer = evaluateGatePolicy(ref, ask("agent", "release-bot", {}));
    expect(answer.decision).toBe("deny");
    expect(answer.errors.join("\n")).toContain("agent-low-risk");
  });

  test("a DenyByDefaultSet floor overrides the agent permit, so only human approvals count", () => {
    const floored = gatePolicy("ship", DenyByDefaultSet({
      policies: [agentLowRisk],
      principal: AGENT,
      when: ["true"],
    }).all);
    const answer = evaluateGatePolicy(floored, ask("agent", "release-bot", { risk: "low" }));
    expect(answer.decision).toBe("deny");
    expect(answer.determining).toHaveLength(1);
  });

  test("core's loader finds this module by the lexicon-name convention", async () => {
    const evaluator = await loadGatePolicyEvaluator("cedar");
    expect((await evaluator.evaluateGatePolicy(ref, ask("agent", "release-bot", { risk: "low" }))).decision).toBe("allow");
  });
});
