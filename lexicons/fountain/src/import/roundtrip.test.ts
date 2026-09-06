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
  "/api/team": { data: [] },
  "/api/team/schedules": { data: [] },
  "/api/webhooks": { data: [] },
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

// ── Adopting a steward (#2128) ────────────────────────────────────────────

const STEWARD_MANIFEST = `apiVersion: fountain.dev/v1
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
---
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

describe("a steward round-trips", () => {
  it("parses all six kinds into IR", () => {
    const ir = new FountainParser().parse(STEWARD_MANIFEST);
    expect(ir.resources.map((r) => r.type)).toEqual([
      "Fountain::V1::Environment",
      "Fountain::V1::Vault",
      "Fountain::V1::Agent",
      "Fountain::V1::Teammate",
      "Fountain::V1::Schedule",
      "Fountain::V1::Webhook",
    ]);
    const schedule = ir.resources.find((r) => r.type === "Fountain::V1::Schedule")!;
    expect(schedule.properties.teammate).toBe("ops-steward");
    expect(schedule.properties.cron).toBe("0 3 * * *");
  });

  it("emits typed Teammate, Schedule and Webhook declarations", () => {
    const ir = new FountainParser().parse(STEWARD_MANIFEST);
    const [file] = new FountainGenerator().generate(ir);

    expect(file.content).toContain("Agent, Environment, Schedule, Teammate, Vault, Webhook");
    expect(file.content).toContain("export const opsSteward = new Teammate({");
    expect(file.content).toContain("export const nightlyConverge = new Schedule({");
    expect(file.content).toContain("export const opsHook = new Webhook({");
    expect(file.content).toContain('teammate: "ops-steward"');
  });

  it("rebuilds to the same manifest", () => {
    const ir = new FountainParser().parse(STEWARD_MANIFEST);
    // The IR is what the generated TypeScript constructs, so serializing it is
    // the same manifest `chant build` would emit from those declarations.
    const entities = new Map(
      ir.resources.map((r) => [r.logicalId, { entityType: r.type, ...r.properties } as unknown as Declarable]),
    );
    expect(fountainSerializer.serialize(entities)).toBe(STEWARD_MANIFEST);
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

  const live: FountainHttp = async (_m, path) => {
    switch (path) {
      case "/api/environments":
        return { status: 200, json: { data: [{ id: "env-1", name: "steward-env", networking_type: "limited" }] } };
      case "/api/environments/env-1/secrets":
        return { status: 200, json: { data: [] } };
      case "/api/vaults":
        return { status: 200, json: { data: [{ id: "vault-1", name: "ops-vault" }] } };
      case "/api/agents":
        return { status: 200, json: { data: [AGENT] } };
      case "/api/team":
        return {
          status: 200,
          json: {
            data: [
              {
                agent_id: "agent-1",
                name: "ops-steward",
                agent: AGENT,
                conversation: { id: "conv-1", environment_id: "env-1", vault_id: "vault-1" },
                presence: { state: "online", label: "Online" },
                unread: false,
              },
            ],
          },
        };
      case "/api/team/schedules":
        return {
          status: 200,
          json: {
            data: [
              {
                id: "sched-1",
                agent_id: "agent-1",
                name: "nightly-converge",
                cron: "0 3 * * *",
                prompt: "chant lifecycle converge",
                one_off: false,
                enabled: true,
                next_run_at: "2026-09-07T03:00:00Z",
                last_error: null,
              },
            ],
          },
        };
      case "/api/webhooks":
        return {
          status: 200,
          json: {
            data: [
              {
                id: "wh-1",
                url: "https://ops.example.com/hooks/fountain",
                event_types: ["conversation.turn.done"],
                status: "active",
                consecutive_failures: 0,
              },
            ],
          },
        };
      default:
        throw new Error(`unrouted ${path}`);
    }
  };

  it("reads the team-side kinds back in the authored vocabulary", async () => {
    const ir = await exportResources({ environment: "local", http: live });
    const byType = (type: string) => ir.resources.find((r) => r.type === type)!;

    const teammate = byType("Fountain::V1::Teammate");
    expect(teammate.logicalId).toBe("ops-steward");
    expect(teammate.properties).toEqual({
      name: "ops-steward",
      agent: "steward",
      environment: "steward-env",
      vault: "ops-vault",
    });

    const schedule = byType("Fountain::V1::Schedule");
    // A schedule's name is unique only within its teammate, so the logical id
    // carries both — the same pair the readers key on.
    expect(schedule.logicalId).toBe("ops-steward-nightly-converge");
    expect(schedule.properties.teammate).toBe("ops-steward");
    expect(schedule.properties.agent_id).toBeUndefined();
    expect(schedule.properties.next_run_at).toBeUndefined();

    const webhook = byType("Fountain::V1::Webhook");
    expect(webhook.logicalId).toBe("webhook-ops-example-com-hooks-fountain");
    expect(webhook.properties).toEqual({
      url: "https://ops.example.com/hooks/fountain",
      event_types: ["conversation.turn.done"],
    });
  });

  it("generates TypeScript that declares the whole steward", async () => {
    const ir = await exportResources({ environment: "local", http: live });
    const [file] = new FountainGenerator().generate(ir);

    expect(file.content).toContain("export const opsSteward = new Teammate({");
    expect(file.content).toContain("export const opsStewardNightlyConverge = new Schedule({");
    expect(file.content).toContain("export const webhookOpsExampleComHooksFountain = new Webhook({");
  });

  it("--owned inherits the agent's marker and never claims a webhook", async () => {
    const ir = await exportResources({ environment: "local", owned: true, http: live });
    const types = ir.resources.map((r) => r.type);
    expect(types).toContain("Fountain::V1::Teammate");
    expect(types).toContain("Fountain::V1::Schedule");
    // No marker channel on a webhook, so `--owned` cannot honestly keep it.
    expect(types).not.toContain("Fountain::V1::Webhook");
  });

  it("--type reads the endpoints a reference resolves through, and no others", async () => {
    const asked: string[] = [];
    const counting: FountainHttp = async (method, path) => {
      asked.push(path);
      return live(method, path);
    };
    await exportResources({ environment: "local", selector: { type: "Schedule" }, http: counting });

    expect(asked).toContain("/api/team");
    expect(asked).toContain("/api/team/schedules");
    expect(asked).not.toContain("/api/webhooks");
  });
});
