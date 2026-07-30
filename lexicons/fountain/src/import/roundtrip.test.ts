import { describe, expect, it } from "vitest";
import { FountainParser } from "./parser";
import { FountainGenerator } from "./generator";
import { detectFountainTemplate } from "../detect";
import { exportResources } from "../export-resources";
import type { FountainHttp } from "../op/activities/fountain-apply";

const MANIFESTS = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: concierge-env
spec:
  name: concierge-env
  networking_type: limited
  networking_config:
    allowed_hosts:
      - github.com
  repositories:
    - url: https://github.com/org/repo
      mount_path: /app
---
apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: researcher
spec:
  name: researcher
  model: anthropic/claude-sonnet-4-6
  runtime: claude
  environment: concierge-env
`;

describe("detect", () => {
  it("detects manifest YAML and plan JSON, rejects noise", () => {
    expect(detectFountainTemplate(MANIFESTS)).toBe(true);
    expect(detectFountainTemplate('{"e":{"kind":"Environment","spec":{}}}')).toBe(true);
    expect(detectFountainTemplate("apiVersion: v1\nkind: Pod")).toBe(false);
    expect(detectFountainTemplate("{}")).toBe(false);
  });
});

describe("parser", () => {
  it("parses multi-document manifests into IR", () => {
    const ir = new FountainParser().parse(MANIFESTS);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fountain::V1::Environment",
      "Fountain::V1::Agent",
    ]);
    expect(ir.resources[0].logicalId).toBe("concierge-env");
    expect(ir.resources[0].properties.networking_type).toBe("limited");
  });

  it("parses the fountain-plan.json sidecar", () => {
    const ir = new FountainParser().parse(
      JSON.stringify({ v: { kind: "Vault", spec: { name: "staging", id: "drop-me" } } }),
    );
    expect(ir.resources).toHaveLength(1);
    expect(ir.resources[0].properties.name).toBe("staging");
    expect(ir.resources[0].properties.id).toBeUndefined();
  });
});

describe("generator", () => {
  it("emits typed constructors with Repository wrapping", () => {
    const ir = new FountainParser().parse(MANIFESTS);
    const [file] = new FountainGenerator().generate(ir);
    expect(file.content).toContain('from "@intentius/chant-lexicon-fountain"');
    expect(file.content).toContain("export const conciergeEnv = new Environment({");
    expect(file.content).toContain("new Repository({");
    expect(file.content).toContain("export const researcher = new Agent({");
  });
});

describe("exportResources", () => {
  it("strips server fields, resolves env refs, and warns on secrets", async () => {
    const warnings: string[] = [];
    const http: FountainHttp = async (_m, path) => {
      if (path === "/api/environments")
        return {
          status: 200,
          json: { data: [{ id: "env-1", name: "e", inserted_at: "x", metadata: { "managed-by": "chant" } }] },
        };
      if (path === "/api/environments/env-1/secrets")
        return { status: 200, json: { data: [{ key: "K" }] } };
      if (path === "/api/vaults") return { status: 200, json: { data: [] } };
      if (path === "/api/agents")
        return {
          status: 200,
          json: { data: [{ id: "a-1", name: "r", environment_id: "env-1", model: "a/m", runtime: "claude" }] },
        };
      throw new Error(`unrouted ${path}`);
    };

    const ir = await exportResources({ environment: "local", http, warn: (m) => warnings.push(m) });
    const agent = ir.resources.find((r) => r.type === "Fountain::V1::Agent")!;
    expect(agent.properties.environment).toBe("e");
    expect(agent.properties.environment_id).toBeUndefined();
    expect(agent.properties.id).toBeUndefined();
    expect(warnings.some((w) => w.includes("1 secret"))).toBe(true);
  });

  it("owned filter drops unmarked resources", async () => {
    const http: FountainHttp = async (_m, path) => {
      if (path === "/api/environments") return { status: 200, json: { data: [] } };
      if (path === "/api/vaults") return { status: 200, json: { data: [] } };
      if (path === "/api/agents")
        return { status: 200, json: { data: [{ id: "a-1", name: "r", metadata: {} }] } };
      throw new Error(`unrouted ${path}`);
    };
    const ir = await exportResources({ environment: "local", owned: true, http });
    expect(ir.resources).toHaveLength(0);
  });
});
