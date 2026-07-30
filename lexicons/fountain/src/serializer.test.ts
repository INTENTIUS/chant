import { describe, expect, it } from "vitest";
import { fountainSerializer } from "./serializer";
import type { Declarable } from "@intentius/chant";

function primary(result: unknown): string {
  return typeof result === "string" ? result : (result as { primary: string }).primary;
}

function entity(entityType: string, props: Record<string, unknown>): Declarable {
  return { entityType, lexicon: "fountain", ...props } as unknown as Declarable;
}

describe("fountain serializer", () => {
  it("has the correct name and rule prefix", () => {
    expect(fountainSerializer.name).toBe("fountain");
    expect(fountainSerializer.rulePrefix).toBe("FTN");
  });

  it("serializes an empty map to an empty string", () => {
    expect(fountainSerializer.serialize(new Map())).toBe("");
  });

  it("emits the fountain-plan.json sidecar for the applier", () => {
    const env = entity("Fountain::V1::Environment", { name: "e" });
    const result = fountainSerializer.serialize(new Map([["e", env]]));
    expect(typeof result).toBe("object");
    const files = (result as { files: Record<string, string> }).files;
    const plan = JSON.parse(files["fountain-plan.json"]);
    expect(plan.e.kind).toBe("Environment");
  });

  it("emits a fountain manifest per entity", () => {
    const env = entity("Fountain::V1::Environment", {
      name: "concierge-env",
      networking_type: "limited",
      networking_config: { allowed_hosts: ["github.com"] },
    });

    const out = primary(fountainSerializer.serialize(new Map([["conciergeEnv", env]])));

    expect(out).toContain("apiVersion: fountain.dev/v1");
    expect(out).toContain("kind: Environment");
    expect(out).toContain("name: conciergeEnv");
    expect(out).toContain("networking_type: limited");
    expect(out).toContain("allowed_hosts:");
    expect(out).toContain("- github.com");
  });

  it("separates multiple entities with document markers", () => {
    const env = entity("Fountain::V1::Environment", { name: "e" });
    const vault = entity("Fountain::V1::Vault", { name: "v" });

    const out = primary(
      fountainSerializer.serialize(
        new Map([
          ["env", env],
          ["vault", vault],
        ]),
      ),
    );

    expect(out).toContain("---\n");
    expect(out).toContain("kind: Environment");
    expect(out).toContain("kind: Vault");
  });

  it("resolves a cross-resource reference to the referenced entity name", () => {
    const env = entity("Fountain::V1::Environment", { name: "concierge-env" });
    const agent = entity("Fountain::V1::Agent", {
      name: "researcher",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "claude",
      environment: env,
    });

    const out = primary(
      fountainSerializer.serialize(
        new Map([
          ["conciergeEnv", env],
          ["researcher", agent],
        ]),
      ),
    );

    expect(out).toContain("environment: conciergeEnv");
  });

  it("quotes YAML-ambiguous strings", () => {
    const vault = entity("Fountain::V1::Vault", {
      name: "v",
      description: "true",
    });

    const out = primary(fountainSerializer.serialize(new Map([["v", vault]])));
    expect(out).toContain('description: "true"');
  });

  it("does not use YAML aliases or tags for substitution references", () => {
    const agent = entity("Fountain::V1::Agent", {
      name: "a",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "claude",
      mcp_servers: { github: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PAT}" } } },
    });

    const out = primary(fountainSerializer.serialize(new Map([["a", agent]])));
    expect(out).toContain('GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PAT}"');
  });
});
