import { describe, expect, it } from "vitest";
import { checkParsePolicySet } from "@cedar-policy/cedar-wasm/nodejs";
import { build } from "@intentius/chant/build";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTCORE_STATEMENT_MAX,
  agentCorePolicyDefinition,
  agentCorePolicyName,
  agentCorePolicyResource,
  agentCorePolicySet,
  agentCoreStagedPolicy,
  agentCoreStatement,
} from "./embed";
import { cedarSerializer, type CedarPolicyProps } from "../serializer";
import { DOGWOOD_POLICY_FILENAME, TemporalPolicy, type TemporalPolicyProps } from "../dogwood/policy";
import { Document, Policy } from "../generated/index";
import { ctx, formerly, predicate } from "../dogwood/temporal";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../examples/agentcore-policy/src");

const denyWrite: CedarPolicyProps = {
  effect: "forbid",
  principal: { is: "App::ServiceAccount" },
  action: { eq: 'App::Action::"write"' },
  resource: { is: "App::Document" },
  unless: ["context.authenticated == true"],
};

const needsApproval: TemporalPolicyProps = {
  effect: "permit",
  principal: { is: "App::ServiceAccount" },
  action: { eq: 'App::Action::"write"' },
  resource: { is: "App::Document" },
  whenTemporal: [
    formerly("1h", predicate('App::Action::"approve"', "response", { "input.document": ctx("input.document") })),
  ],
};

async function buildExample() {
  const result = await build(exampleDir, [cedarSerializer]);
  expect(result.errors).toEqual([]);
  const output = result.outputs.get("cedar");
  if (typeof output === "string" || output === undefined) throw new Error("expected a multi-file result");
  return { result, cedarText: output.primary, dwText: output.files?.[DOGWOOD_POLICY_FILENAME] ?? "" };
}

// ── The statement ─────────────────────────────────────────────────

describe("the AgentCore statement", () => {
  it("is Cedar the real parser accepts, for the plain-Cedar arm", () => {
    const statement = agentCoreStatement("denyWrite", denyWrite);
    expect(checkParsePolicySet({ staticPolicies: statement }).type).toBe("success");
  });

  it("carries the @id the live policy is matched back on", () => {
    expect(agentCoreStatement("denyWrite", denyWrite)).toContain('@id("deny-write")');
    expect(agentCoreStatement("denyWrite", denyWrite, { policyId: "override" })).toContain('@id("override")');
  });

  it("renders a temporal policy as .dw text", () => {
    const statement = agentCoreStatement("needsApproval", needsApproval);
    expect(statement).toContain("when temporal {");
    expect(statement).toContain('formerly within 1h App::Action::"approve"::response{');
  });

  it("is byte-identical to what the serializer writes to .cedar", async () => {
    const { result, cedarText } = await buildExample();
    const set = agentCorePolicySet(result.entities);

    const cedarArm = Object.values(set).filter((d) => d.Cedar !== undefined);
    expect(cedarArm.length).toBeGreaterThan(0);
    for (const definition of cedarArm) {
      expect(cedarText).toContain(definition.Cedar!.Statement);
    }
  });

  it("is byte-identical to what the serializer writes to policies.dw", async () => {
    const { result, dwText } = await buildExample();
    const set = agentCorePolicySet(result.entities);

    const policyArm = Object.values(set).filter((d) => d.Policy !== undefined);
    expect(policyArm.length).toBe(2);
    for (const definition of policyArm) {
      expect(dwText).toContain(definition.Policy!.Statement);
    }
  });

  it("refuses a template — AgentCore statements are static", () => {
    expect(() =>
      agentCoreStatement("ownerOnly", {
        effect: "permit",
        principal: { eq: "?principal" },
        action: { eq: 'App::Action::"read"' },
        resource: { is: "App::Document" },
      }),
    ).toThrow(/carries a Cedar template slot/);

    expect(() =>
      agentCoreStatement("resourceSlot", {
        effect: "permit",
        principal: { is: "App::User" },
        action: { eq: 'App::Action::"read"' },
        resource: { eq: "?resource" },
      }),
    ).toThrow(/no template-linked arm/);
  });

  it("names the declaration when there is nothing to embed", () => {
    expect(() => agentCoreStatement("empty", new Map())).toThrow(/rendered no policy text/);
  });

  it("refuses a statement past AgentCore's own length cap", () => {
    const long = { ...denyWrite, unless: ["context.authenticated == true".padEnd(AGENTCORE_STATEMENT_MAX, " ")] };
    expect(() => agentCoreStatement("tooLong", long)).toThrow(/maximum is 10000/);
  });
});

// ── The Definition union ──────────────────────────────────────────

describe("the AgentCore Definition union", () => {
  it("puts plain Cedar in the Cedar arm and nothing else", () => {
    const definition = agentCorePolicyDefinition("denyWrite", denyWrite);
    expect(Object.keys(definition)).toEqual(["Cedar"]);
    expect(typeof definition.Cedar!.Statement).toBe("string");
  });

  it("puts temporal text in the language-agnostic Policy arm and nothing else", () => {
    const definition = agentCorePolicyDefinition("needsApproval", needsApproval);
    expect(Object.keys(definition)).toEqual(["Policy"]);
    expect(definition.Policy!.Statement).toContain("when temporal {");
  });

  it("reads the entity type off a declared TemporalPolicy", () => {
    const definition = agentCorePolicyDefinition("needsApproval", new TemporalPolicy(needsApproval));
    expect(Object.keys(definition)).toEqual(["Policy"]);
  });

  it("reads the entity type off a declared Cedar Policy", () => {
    // Built against the generated class rather than spread from `denyWrite`:
    // `PolicyProps` narrows every scope to the schema's own entity and action
    // names, which `CedarPolicyProps` leaves as strings.
    const declared = new Policy({
      effect: "forbid",
      principal: { is: "App::ServiceAccount" },
      action: { eq: 'App::Action::"write"' },
      resource: { is: "App::Document" },
      unless: ["context.authenticated == true"],
    });
    const definition = agentCorePolicyDefinition("denyWrite", declared);
    expect(Object.keys(definition)).toEqual(["Cedar"]);
    expect(definition.Cedar!.Statement).toBe(agentCoreStatement("denyWrite", denyWrite));
  });

  it("refuses a declared entity that is not a policy at all", () => {
    const document = new Document({ owner: 'App::User::"alice"' } as never);
    expect(() => agentCorePolicyDefinition("doc", document)).toThrow(/which is not a policy/);
  });

  it("lets plain Cedar be forced into the Policy arm, because dogwood embeds Cedar", () => {
    const definition = agentCorePolicyDefinition("denyWrite", denyWrite, { language: "dogwood" });
    expect(Object.keys(definition)).toEqual(["Policy"]);
    expect(definition.Policy!.Statement).toContain("forbid");
  });

  it("refuses to force temporal text into the Cedar arm", () => {
    expect(() => agentCorePolicyDefinition("needsApproval", needsApproval, { language: "cedar" })).toThrow(
      /has no `when temporal` rule/,
    );
  });

  it("takes a whole policy set and lands it in the Policy arm when any policy is temporal", async () => {
    const { result, cedarText, dwText } = await buildExample();
    const definition = agentCorePolicyDefinition("gateway", result.entities);

    expect(Object.keys(definition)).toEqual(["Policy"]);
    // Cedar first, then temporal, both verbatim from the emitted artifacts.
    expect(definition.Policy!.Statement).toContain(cedarText.trimEnd());
    for (const line of ['@id("write-needs-approval")', '@id("session-spend-budget")']) {
      expect(definition.Policy!.Statement).toContain(line);
      expect(dwText).toContain(line);
    }
  });
});

// ── The resource props ────────────────────────────────────────────

describe("the resource form", () => {
  it("fills every required prop of the generated class", () => {
    const resource = agentCorePolicyResource("denyWrite", denyWrite, "GatewayEngine-abcdefghij");
    expect(resource.PolicyEngineId).toBe("GatewayEngine-abcdefghij");
    expect(resource.Name).toBe("denyWrite");
    expect(resource.Definition.Cedar!.Statement).toContain("forbid");
    expect(resource.EnforcementMode).toBeUndefined();
  });

  it("carries the stage and the description when asked", () => {
    const resource = agentCorePolicyResource("denyWrite", denyWrite, "engine", {
      stage: "log-only",
      description: "watch it first",
    });
    expect(resource.EnforcementMode).toBe("LOG_ONLY");
    expect(resource.Description).toBe("watch it first");
  });

  it("checks Name against AgentCore's create-only pattern instead of coercing it", () => {
    expect(agentCorePolicyName("writeNeedsApproval")).toBe("writeNeedsApproval");
    expect(() => agentCorePolicyName("write-needs-approval")).toThrow(/not a legal/);
    expect(() => agentCorePolicyName("9lives")).toThrow(/not a legal/);
    expect(() => agentCorePolicyName("a".repeat(49))).toThrow(/maximum is 48/);
  });
});

// ── Staging ───────────────────────────────────────────────────────

describe("the staged form", () => {
  it("is the three props the generated class needs beside PolicyEngineId", () => {
    const staged = agentCoreStagedPolicy("needsApproval", needsApproval, "log-only");
    expect(staged.Name).toBe("needsApproval");
    expect(staged.EnforcementMode).toBe("LOG_ONLY");
    expect(staged.Definition.Policy!.Statement).toContain("when temporal {");
  });

  it("promotes on one token", () => {
    const observed = agentCoreStagedPolicy("needsApproval", needsApproval, "log-only");
    const enforced = agentCoreStagedPolicy("needsApproval", needsApproval, "enforce");
    expect(enforced.EnforcementMode).toBe("ACTIVE");
    expect(enforced.Definition).toEqual(observed.Definition);
  });
});

// ── The whole-set form ────────────────────────────────────────────

describe("the whole-set form", () => {
  it("keys one definition per policy by chant entity name", async () => {
    const { result } = await buildExample();
    const set = agentCorePolicySet(result.entities);
    expect(Object.keys(set).sort()).toEqual([
      "denyUnauthenticatedWrite",
      "sessionSpendBudget",
      "writeNeedsApproval",
    ]);
  });

  it("keeps each policy on its own arm, so EnforcementMode stays per policy", async () => {
    const { result } = await buildExample();
    const set = agentCorePolicySet(result.entities);
    expect(Object.keys(set.denyUnauthenticatedWrite)).toEqual(["Cedar"]);
    expect(Object.keys(set.writeNeedsApproval)).toEqual(["Policy"]);
    expect(checkParsePolicySet({ staticPolicies: set.denyUnauthenticatedWrite.Cedar!.Statement }).type).toBe(
      "success",
    );
  });
});
