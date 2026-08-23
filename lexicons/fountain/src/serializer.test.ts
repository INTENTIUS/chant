import { describe, expect, it } from "vitest";
import { fountainSerializer } from "./serializer";
import { parseManifest } from "./op/activities/fountain-apply";
import type { Declarable } from "@intentius/chant";

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

  it("emits only the manifest YAML — no sidecar file", () => {
    const env = entity("Fountain::V1::Environment", { name: "e" });
    const result = fountainSerializer.serialize(new Map([["e", env]]));
    expect(typeof result).toBe("string");
    expect(result).toContain("kind: Environment");
  });

  it("emits a fountain manifest per entity", () => {
    const env = entity("Fountain::V1::Environment", {
      name: "concierge-env",
      networking_type: "limited",
      networking_config: { allowed_hosts: ["github.com"] },
    });

    const out = fountainSerializer.serialize(new Map([["conciergeEnv", env]]));

    expect(out).toContain("apiVersion: fountain.dev/v1");
    expect(out).toContain("kind: Environment");
    // The declared name, not the export name — fountain upserts by this.
    expect(out).toContain("name: concierge-env");
    expect(out).not.toContain("name: conciergeEnv");
    expect(out).toContain("networking_type: limited");
    expect(out).toContain("allowed_hosts:");
    expect(out).toContain("- github.com");
  });

  it("carries the name in metadata only, never under spec (#1606)", () => {
    const agent = entity("Fountain::V1::Agent", {
      name: "tech-lead",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "claude",
    });

    const out = fountainSerializer.serialize(new Map([["techLead", agent]])) as string;

    expect(out).toContain("metadata:\n  name: tech-lead\n");
    expect(out).not.toContain("spec:\n  name:");
    expect(out.match(/^\s*name: /gm)).toHaveLength(1);

    // The apply payload fountain receives has exactly one name per resource.
    const [resource] = parseManifest(out);
    expect(resource.name).toBe("tech-lead");
    expect(resource.spec).not.toHaveProperty("name");
  });

  it("separates multiple entities with document markers", () => {
    const env = entity("Fountain::V1::Environment", { name: "e" });
    const vault = entity("Fountain::V1::Vault", { name: "v" });

    const out = fountainSerializer.serialize(
      new Map([
        ["env", env],
        ["vault", vault],
      ]),
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

    const out = fountainSerializer.serialize(
      new Map([
        ["conciergeEnv", env],
        ["researcher", agent],
      ]),
    );

    // Resolves to the referenced entity's fountain name, so the reference and
    // the environment's own manifest agree on one identity.
    expect(out).toContain("environment: concierge-env");
  });

  it("falls back to the export name when no name is declared", () => {
    const vault = entity("Fountain::V1::Vault", { description: "no name here" });
    const out = fountainSerializer.serialize(new Map([["stagingCreds", vault]]));
    expect(out).toContain("name: stagingCreds");
  });

  it("quotes YAML-ambiguous strings", () => {
    const vault = entity("Fountain::V1::Vault", {
      name: "v",
      description: "true",
    });

    const out = fountainSerializer.serialize(new Map([["v", vault]]));
    expect(out).toContain('description: "true"');
  });

  it("folds the first line of a map list item onto the dash", () => {
    const agent = entity("Fountain::V1::Agent", {
      name: "a",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "claude",
      skills: [{ source: "anthropics/skills", name: "frontend-design" }],
    });

    const out = fountainSerializer.serialize(new Map([["a", agent]])) as string;
    expect(out).toContain("    - source: anthropics/skills\n      name: frontend-design");
    expect(out).not.toMatch(/^\s*-$/m);
  });

  it("round-trips its own output through parseManifest", () => {
    // A list-of-maps field plus a spec-level `metadata` key is the shape
    // that used to collapse in parseYAML (#1286): the list item's keys
    // leaked to the top level and spec.metadata clobbered the document
    // metadata, blanking every resource name.
    const env = entity("Fountain::V1::Environment", {
      name: "e",
      secrets: [{ key: "GITHUB_TOKEN", value: "infisical:///dev/GITHUB_TOKEN" }],
      metadata: { "managed-by": "chant" },
    });
    const agent = entity("Fountain::V1::Agent", {
      name: "a",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "claude",
      environment: env,
      skills: [{ source: "anthropics/skills", name: "frontend-design" }],
      metadata: { "managed-by": "chant" },
    });

    const out = fountainSerializer.serialize(
      new Map([
        ["e", env],
        ["a", agent],
      ]),
    ) as string;
    const resources = parseManifest(out);

    expect(resources.map((r) => `${r.kind}/${r.name}`)).toEqual(["Environment/e", "Agent/a"]);
    expect(resources[0].spec.secrets).toEqual([
      { key: "GITHUB_TOKEN", value: "infisical:///dev/GITHUB_TOKEN" },
    ]);
    expect(resources[1].spec.skills).toEqual([
      { source: "anthropics/skills", name: "frontend-design" },
    ]);
    expect(resources[1].spec.metadata).toEqual({ "managed-by": "chant" });
  });

  it("does not use YAML aliases or tags for substitution references", () => {
    const agent = entity("Fountain::V1::Agent", {
      name: "a",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "claude",
      mcp_servers: { github: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PAT}" } } },
    });

    const out = fountainSerializer.serialize(new Map([["a", agent]]));
    expect(out).toContain('GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PAT}"');
  });
});
