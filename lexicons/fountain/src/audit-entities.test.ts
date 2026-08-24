import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { fountainAuditEntities } from "./audit-entities";
import { fountainSerializer } from "./serializer";
import { postSynthChecks } from "./lint/post-synth";
import { propsOf } from "./entity-props";

function ctxOf(entities: Map<string, Declarable>): PostSynthContext {
  return {
    outputs: new Map(),
    entities,
    buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 0 },
  } as unknown as PostSynthContext;
}

const runAll = (entities: Map<string, Declarable>) => postSynthChecks.flatMap((c) => c.check(ctxOf(entities)));

const DIRTY = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: dev
spec:
  networking_type: unrestricted
  env_vars:
    API_URL: https://api.example.com
    AWS_SECRET_ACCESS_KEY: not-a-real-secret
---
apiVersion: fountain.dev/v1
kind: Vault
metadata:
  name: staging
spec:
  secrets:
    - key: API_URL
      value: https://staging.example.com
`;

const CLEAN = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: dev
spec:
  networking_type: limited
  networking_config:
    allowed_hosts:
      - github.com
  env_vars:
    API_URL: https://api.example.com
---
apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: researcher
spec:
  model: anthropic/claude-sonnet-4-6
  runtime: claude
  environment: dev
`;

describe("fountainAuditEntities (parse-to-graph, #1567)", () => {
  it("parses manifests into entities keyed by metadata.name, props under .props", () => {
    const entities = fountainAuditEntities(DIRTY);
    expect([...entities.keys()].sort()).toEqual(["dev", "staging"]);
    const dev = entities.get("dev")!;
    expect(dev.entityType).toBe("Fountain::V1::Environment");
    expect(propsOf(dev).networking_type).toBe("unrestricted");
    expect(propsOf(dev).name).toBe("dev");
    expect(entities.get("staging")!.entityType).toBe("Fountain::V1::Vault");
  });

  it("the existing FTN checks fire unchanged over the parsed graph", () => {
    const diags = runAll(fountainAuditEntities(DIRTY));
    const ids = diags.map((d) => d.checkId).sort();
    expect(ids).toContain("FTN011"); // unrestricted networking
    expect(ids).toContain("FTN012"); // credential-shaped env_vars key
    expect(ids).toContain("FTN014"); // vault shadows API_URL
    expect(diags.find((d) => d.checkId === "FTN012")!.severity).toBe("error");
  });

  it("a clean manifest set yields no findings", () => {
    expect(runAll(fountainAuditEntities(CLEAN))).toEqual([]);
  });

  it("a name declared twice keeps both entities (suffixed key), so FTN017 sees the collision", () => {
    const twice = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: dev
spec:
  networking_type: limited
---
apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: dev
spec:
  networking_type: limited
`;
    const entities = fountainAuditEntities(twice);
    expect([...entities.keys()].sort()).toEqual(["dev", "dev#2"]);
    expect(runAll(entities).map((d) => d.checkId)).toContain("FTN017");
  });

  it("a malformed document contributes nothing; the rest of the file still parses", () => {
    const mixed = `{not yaml [
---
apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: dev
spec:
  networking_type: limited
`;
    const entities = fountainAuditEntities(mixed);
    expect([...entities.keys()]).toEqual(["dev"]);
  });

  it("non-fountain documents in the file are skipped, not misread", () => {
    const entities = fountainAuditEntities("apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n");
    expect(entities.size).toBe(0);
  });

  it("round-trips: serialize -> parse -> same entities (guards the #1286 class)", () => {
    const entity = (entityType: string, props: Record<string, unknown>): Declarable =>
      ({ entityType, lexicon: "fountain", props }) as unknown as Declarable;
    const src = new Map<string, Declarable>([
      [
        "dev",
        entity("Fountain::V1::Environment", {
          name: "dev",
          networking_type: "limited",
          networking_config: { allowed_hosts: ["github.com"] },
          env_vars: { API_URL: "https://api.example.com" },
        }),
      ],
      [
        "researcher",
        entity("Fountain::V1::Agent", {
          name: "researcher",
          runtime: "claude",
          model: "anthropic/claude-sonnet-4-6",
          environment: "dev",
        }),
      ],
    ]);
    const parsed = fountainAuditEntities(fountainSerializer.serialize(src) as string);
    expect([...parsed.keys()].sort()).toEqual(["dev", "researcher"]);
    for (const [name, before] of src) {
      const after = parsed.get(name)!;
      expect(after.entityType).toBe(before.entityType);
      expect(propsOf(after)).toEqual(propsOf(before));
    }
    // and the parsed graph is as quiet as the declared one
    expect(runAll(parsed)).toEqual([]);
  });
});
