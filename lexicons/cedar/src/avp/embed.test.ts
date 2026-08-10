import { describe, expect, it } from "vitest";
import { checkParsePolicySet } from "@cedar-policy/cedar-wasm/nodejs";
import { build } from "@intentius/chant/build";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  avpPolicyDefinition,
  avpPolicyResource,
  avpPolicySet,
  avpStatement,
  avpStatementJSON,
} from "./embed";
import { decodeOwnershipDescription, descriptionIsOwned } from "./ownership";
import { cedarSerializer, type CedarPolicyProps } from "../serializer";

const ownerRead: CedarPolicyProps = {
  effect: "permit",
  principal: { is: "App::User" },
  action: { eq: 'App::Action::"read"' },
  resource: { is: "App::Document" },
  when: ["resource.owner == principal"],
};

describe("the AVP statement", () => {
  it("is Cedar the real parser accepts", () => {
    const statement = avpStatement("ownerRead", ownerRead);
    expect(checkParsePolicySet({ staticPolicies: statement }).type).toBe("success");
  });

  it("carries the @id a live policy is matched back on", () => {
    expect(avpStatement("ownerRead", ownerRead)).toContain('@id("owner-read")');
    expect(avpStatement("ownerRead", { ...ownerRead, annotations: { id: "explicit" } })).toContain(
      '@id("explicit")',
    );
    expect(avpStatement("ownerRead", ownerRead, { policyId: "override" })).toContain('@id("override")');
  });

  it("is byte-identical to what the serializer writes to .cedar", async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../examples/getting-started/src");
    const result = await build(dir, [cedarSerializer]);
    const output = result.outputs.get("cedar");
    const text = typeof output === "string" ? output : (output?.primary ?? "");

    // One renderer, not two: every statement the embedding emits appears
    // verbatim in the .cedar file the same build produced.
    for (const statement of Object.values(avpPolicySet(result.entities))) {
      expect(text).toContain(statement.Static.Statement);
    }
  });

  it("also emits the Cedar JSON form, for evaluators that take JSON", () => {
    const json = avpStatementJSON("ownerRead", ownerRead);
    expect(json.effect).toBe("permit");
    expect(json.annotations?.id).toBe("owner-read");
    // Cedar's own reading, so a condition is an expression tree — not the
    // `{ __expr: "…" }` escape the model-derived encoder used to write.
    expect(JSON.stringify(json)).not.toContain("__expr");
    expect(json.conditions?.[0]?.kind).toBe("when");
  });

  it("refuses to hand back JSON for a policy Cedar cannot read", () => {
    expect(() => avpStatementJSON("broken", { when: ["this is not an expression"] })).toThrow(
      /did not parse/,
    );
  });
});

describe("the AVP Definition envelope", () => {
  it("is the Static shape AWS::VerifiedPermissions::Policy declares", () => {
    const definition = avpPolicyDefinition("ownerRead", ownerRead);
    expect(Object.keys(definition)).toEqual(["Static"]);
    expect(typeof definition.Static.Statement).toBe("string");
    expect(definition.Static.Description).toBeUndefined();
  });

  it("stamps the ownership marker into the description when asked", () => {
    const definition = avpPolicyDefinition("ownerRead", ownerRead, {
      description: "Owners read their own documents.",
      ownership: { stack: "authz", env: "prod" },
    });

    expect(descriptionIsOwned(definition.Static.Description)).toBe(true);
    const decoded = decodeOwnershipDescription(definition.Static.Description);
    expect(decoded.text).toBe("Owners read their own documents.");
    expect(decoded.policyId).toBe("owner-read");
  });

  it("keeps a plain description untouched when no marker is requested", () => {
    const definition = avpPolicyDefinition("ownerRead", ownerRead, { description: "just prose" });
    expect(definition.Static.Description).toBe("just prose");
  });

  it("fills both required props of the generated class", () => {
    const resource = avpPolicyResource("ownerRead", ownerRead, "store-123");
    expect(resource.PolicyStoreId).toBe("store-123");
    expect(resource.Definition.Static.Statement).toContain("permit");
  });
});

describe("the whole-set form", () => {
  it("keys definitions by chant entity name", async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../../examples/getting-started/src");
    const result = await build(dir, [cedarSerializer]);

    const set = avpPolicySet(result.entities, {
      ownership: { stack: "authz", env: "prod" },
    });
    expect(Object.keys(set).sort()).toEqual(["ownerRead", "requireMfa"]);
    for (const definition of Object.values(set)) {
      expect(descriptionIsOwned(definition.Static.Description)).toBe(true);
      expect(checkParsePolicySet({ staticPolicies: definition.Static.Statement }).type).toBe("success");
    }
  });
});
