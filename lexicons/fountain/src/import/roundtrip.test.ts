import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant";
import { FountainParser } from "./parser";
import { FountainGenerator } from "./generator";
import { detectFountainTemplate } from "../detect";
import { exportResources } from "../export-resources";
import { fountainSerializer } from "../serializer";
import type { FountainHttp } from "../op/activities/fountain-apply";

/** Every list endpoint `exportResources` reads, empty unless a test says otherwise. */
const EMPTY_ESTATE: Record<string, unknown> = {
  "/api/environments": { data: [] },
  "/api/vaults": { data: [] },
  "/api/agents": { data: [] },
};

/** An http seam that answers the routes a test cares about and empties the rest. */
function estate(routes: Record<string, unknown>): FountainHttp {
  return async (_method, path) => {
    const json = path in routes ? routes[path] : EMPTY_ESTATE[path];
    if (json === undefined) throw new Error(`unrouted ${path}`);
    return { status: 200, json };
  };
}

const MANIFESTS = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: concierge-env
spec:
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

  it("takes the name prop from metadata.name when spec carries none (#1606)", () => {
    const ir = new FountainParser().parse(MANIFESTS);
    expect(ir.resources.map((r) => r.properties.name)).toEqual(["concierge-env", "researcher"]);
  });

  it("lets metadata.name win over a stray spec.name", () => {
    const ir = new FountainParser().parse(
      "apiVersion: fountain.dev/v1\nkind: Vault\nmetadata:\n  name: real\nspec:\n  name: stale\n",
    );
    expect(ir.resources[0].properties.name).toBe("real");
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
    const http = estate({
      "/api/environments": {
        data: [{ id: "env-1", name: "e", inserted_at: "x", metadata: { "managed-by": "chant" } }],
      },
      "/api/environments/env-1/secrets": { data: [{ key: "K" }] },
      "/api/agents": {
        data: [{ id: "a-1", name: "r", environment_id: "env-1", model: "a/m", runtime: "claude" }],
      },
    });

    const ir = await exportResources({ environment: "local", http, warn: (m) => warnings.push(m) });
    const agent = ir.resources.find((r) => r.type === "Fountain::V1::Agent")!;
    expect(agent.properties.environment).toBe("e");
    expect(agent.properties.environment_id).toBeUndefined();
    expect(agent.properties.id).toBeUndefined();
    expect(warnings.some((w) => w.includes("1 secret"))).toBe(true);
  });

  it("owned filter drops unmarked resources", async () => {
    const http = estate({ "/api/agents": { data: [{ id: "a-1", name: "r", metadata: {} }] } });
    const ir = await exportResources({ environment: "local", owned: true, http });
    expect(ir.resources).toHaveLength(0);
  });
});

// ── A steward manifest from before Managoat removed the team (#2793) ──────

const STEWARD_CORE = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: steward-env
spec:
  networking_type: limited
---
apiVersion: fountain.dev/v1
kind: Vault
metadata:
  name: ops-vault
spec:
  description: Ops credentials
---
apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: steward
spec:
  runtime: acp
  runtime_command: chant acp
  environment: steward-env
`;

const STEWARD_MANIFEST = `${STEWARD_CORE}---
apiVersion: fountain.dev/v1
kind: Teammate
metadata:
  name: ops-steward
spec:
  agent: steward
  environment: steward-env
  vault: ops-vault
---
apiVersion: fountain.dev/v1
kind: Schedule
metadata:
  name: nightly-converge
spec:
  teammate: ops-steward
  cron: "0 3 * * *"
  prompt: chant lifecycle converge
  enabled: true
---
apiVersion: fountain.dev/v1
kind: Webhook
metadata:
  name: ops-hook
spec:
  url: "https://ops.example.com/hooks/fountain"
  event_types:
    - conversation.turn.done
`;

describe("an old steward manifest imports", () => {
  it("skips the Teammate, Schedule and Webhook documents", () => {
    const ir = new FountainParser().parse(STEWARD_MANIFEST);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fountain::V1::Environment",
      "Fountain::V1::Vault",
      "Fountain::V1::Agent",
    ]);
  });

  it("generates no retired declarations", () => {
    const ir = new FountainParser().parse(STEWARD_MANIFEST);
    const [file] = new FountainGenerator().generate(ir);
    expect(file.content).not.toMatch(/new (Teammate|Schedule|Webhook)\(/);
  });

  it("rebuilds to the manifest without them", () => {
    const ir = new FountainParser().parse(STEWARD_MANIFEST);
    // The IR is what the generated TypeScript constructs, so serializing it is
    // the same manifest `chant build` would emit from those declarations.
    const entities = new Map(
      ir.resources.map((r) => [r.logicalId, { entityType: r.type, ...r.properties } as unknown as Declarable]),
    );
    expect(fountainSerializer.serialize(entities)).toBe(STEWARD_CORE);
  });
});

describe("exporting a live steward", () => {
  const AGENT = {
    id: "agent-1",
    name: "steward",
    runtime: "acp",
    environment_id: "env-1",
    metadata: { "managed-by": "chant" },
  };

  const asked: string[] = [];
  const live: FountainHttp = async (_m, path) => {
    asked.push(path);
    switch (path) {
      case "/api/environments":
        return { status: 200, json: { data: [{ id: "env-1", name: "steward-env", networking_type: "limited" }] } };
      case "/api/environments/env-1/secrets":
        return { status: 200, json: { data: [] } };
      case "/api/vaults":
        return { status: 200, json: { data: [{ id: "vault-1", name: "ops-vault" }] } };
      case "/api/agents":
        return { status: 200, json: { data: [AGENT] } };
      default:
        throw new Error(`unrouted ${path}`);
    }
  };

  it("reads the three kinds and never asks for a team, schedule or webhook route", async () => {
    asked.length = 0;
    const ir = await exportResources({ environment: "local", http: live });
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fountain::V1::Environment",
      "Fountain::V1::Vault",
      "Fountain::V1::Agent",
    ]);
    expect(ir.resources[2].properties.environment).toBe("steward-env");
    expect(asked.filter((p) => /team|webhook/.test(p))).toEqual([]);
  });

  it("--type reads the endpoints a reference resolves through, and no others", async () => {
    asked.length = 0;
    await exportResources({ environment: "local", selector: { type: "Agent" }, http: live });
    expect(asked).toEqual(["/api/environments", "/api/agents"]);
  });
});
