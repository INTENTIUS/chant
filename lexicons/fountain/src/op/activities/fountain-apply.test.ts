import { describe, expect, it } from "vitest";
import {
  fountainApply,
  splitSecrets,
  isChantOwned,
  resolveEndpoint,
  parsePlan,
  type FountainHttp,
  type FountainPlan,
} from "./fountain-apply";
import { fountainRun } from "./fountain-run";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Scripted fake http: records calls, answers from a route table. */
function fakeHttp(routes: Record<string, { status: number; json?: unknown }>): {
  http: FountainHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: FountainHttp = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const hit = routes[key];
    if (!hit) throw new Error(`unrouted: ${key}`);
    return { status: hit.status, json: hit.json ?? null };
  };
  return { http, calls };
}

const EMPTY_LISTS = {
  "GET /api/environments": { status: 200, json: { data: [] } },
  "GET /api/vaults": { status: 200, json: { data: [] } },
  "GET /api/agents": { status: 200, json: { data: [] } },
};

describe("pure helpers", () => {
  it("resolveEndpoint precedence: arg > env > default", () => {
    expect(resolveEndpoint({ endpoint: "http://x/" }, {})).toBe("http://x");
    expect(resolveEndpoint({}, { FOUNTAIN_ENDPOINT: "http://env" })).toBe("http://env");
    expect(resolveEndpoint({}, {})).toBe("https://fountain.inevitable.fyi");
  });

  it("splitSecrets extracts valid entries and leaves the body clean", () => {
    const { body, secrets } = splitSecrets({
      name: "e",
      secrets: [{ key: "K", value: "v" }, { bogus: true }],
    });
    expect(body).toEqual({ name: "e" });
    expect(secrets).toEqual([{ key: "K", value: "v" }]);
  });

  it("isChantOwned keys on the metadata marker", () => {
    expect(isChantOwned({ metadata: { "managed-by": "chant" } })).toBe(true);
    expect(isChantOwned({ metadata: { "managed-by": "human" } })).toBe(false);
    expect(isChantOwned({})).toBe(false);
  });
});

describe("fountainApply", () => {
  it("creates in Environment -> Vault -> Agent order and resolves the environment ref", async () => {
    const plan: FountainPlan = {
      researcher: {
        kind: "Agent",
        spec: { name: "researcher", model: "a/m", runtime: "claude", environment: "conciergeEnv" },
      },
      conciergeEnv: { kind: "Environment", spec: { name: "concierge-env", networking_type: "limited" } },
    };

    const { http, calls } = fakeHttp({
      ...EMPTY_LISTS,
      "POST /api/environments": { status: 201, json: { data: { id: "env-1" } } },
      "POST /api/agents": { status: 201, json: { data: { id: "agent-1" } } },
    });

    const summary = await fountainApply({ planContent: JSON.stringify(plan) }, http);

    const mutations = calls.filter((c) => c.method === "POST");
    expect(mutations.map((c) => c.path)).toEqual(["/api/environments", "/api/agents"]);
    const agentBody = mutations[1].body as Record<string, unknown>;
    expect(agentBody.environment_id).toBe("env-1");
    expect(agentBody.environment).toBeUndefined();
    expect(summary.created).toEqual(["Environment/concierge-env", "Agent/researcher"]);
  });

  it("updates by name when the resource already exists", async () => {
    const plan: FountainPlan = {
      v: { kind: "Vault", spec: { name: "staging-creds", description: "d" } },
    };
    const { http, calls } = fakeHttp({
      ...EMPTY_LISTS,
      "GET /api/vaults": { status: 200, json: { data: [{ id: "v-9", name: "staging-creds" }] } },
      "PUT /api/vaults/v-9": { status: 200, json: { data: { id: "v-9" } } },
    });

    const summary = await fountainApply({ planContent: JSON.stringify(plan) }, http);
    expect(summary.updated).toEqual(["Vault/staging-creds"]);
    expect(calls.some((c) => c.method === "PUT" && c.path === "/api/vaults/v-9")).toBe(true);
  });

  it("upserts secrets through the sub-resource", async () => {
    const plan: FountainPlan = {
      e: {
        kind: "Environment",
        spec: { name: "e", secrets: [{ key: "OPENAI_API_KEY", value: "${FROM_PROVIDER}" }] },
      },
    };
    const { http, calls } = fakeHttp({
      ...EMPTY_LISTS,
      "POST /api/environments": { status: 201, json: { data: { id: "env-1" } } },
      "POST /api/environments/env-1/secrets": { status: 201 },
    });

    const summary = await fountainApply({ planContent: JSON.stringify(plan) }, http);
    expect(summary.secretsUpserted).toBe(1);
    const create = calls.find((c) => c.method === "POST" && c.path === "/api/environments")!;
    expect((create.body as Record<string, unknown>).secrets).toBeUndefined();
  });

  it("prunes only chant-owned resources, in reverse kind order", async () => {
    const plan: FountainPlan = {};
    const { http, calls } = fakeHttp({
      "GET /api/environments": {
        status: 200,
        json: { data: [{ id: "e-1", name: "owned-env", metadata: { "managed-by": "chant" } }] },
      },
      "GET /api/vaults": { status: 200, json: { data: [] } },
      "GET /api/agents": {
        status: 200,
        json: {
          data: [
            { id: "a-1", name: "owned-agent", metadata: { "managed-by": "chant" } },
            { id: "a-2", name: "human-agent", metadata: {} },
          ],
        },
      },
      "DELETE /api/agents/a-1": { status: 204 },
      "DELETE /api/environments/e-1": { status: 204 },
    });

    const summary = await fountainApply({ planContent: "{}", prune: true }, http);
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual(["/api/agents/a-1", "/api/environments/e-1"]);
    expect(summary.pruned).toEqual(["Agent/owned-agent", "Environment/owned-env"]);
  });

  it("parsePlan round-trips", () => {
    const plan = parsePlan('{"e":{"kind":"Environment","spec":{"name":"e"}}}');
    expect(plan.e.kind).toBe("Environment");
  });
});

describe("fountainRun", () => {
  it("resolves the agent by name, starts, and polls to a terminal status", async () => {
    let polls = 0;
    const http: FountainHttp = async (method, path, body) => {
      if (path.startsWith("/api/agents?search=")) {
        return { status: 200, json: { data: [{ id: "agent-1", name: "researcher" }] } };
      }
      if (method === "POST" && path === "/api/conversations") {
        expect((body as Record<string, unknown>).agent_id).toBe("agent-1");
        return { status: 201, json: { data: { id: "conv-1" } } };
      }
      if (method === "GET" && path === "/api/conversations/conv-1") {
        polls += 1;
        return {
          status: 200,
          json: { data: { status: polls < 3 ? "running" : "completed" } },
        };
      }
      throw new Error(`unrouted: ${method} ${path}`);
    };

    const result = await fountainRun(
      { agent: "researcher", prompt: "hi", pollMs: 1, sleep: async () => {} },
      http,
    );
    expect(result).toEqual({ conversationId: "conv-1", status: "completed", terminatedByDeadline: false });
  });

  it("terminates the conversation when the deadline passes", async () => {
    const calls: string[] = [];
    const http: FountainHttp = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === "/api/conversations" && method === "POST") {
        return { status: 201, json: { data: { id: "conv-2" } } };
      }
      if (method === "GET") return { status: 200, json: { data: { status: "running" } } };
      return { status: 200, json: null };
    };

    const result = await fountainRun(
      {
        agent: "123e4567-e89b-42d3-a456-426614174000",
        timeoutMs: 1,
        pollMs: 1,
        sleep: async () => {},
      },
      http,
    );
    expect(result.terminatedByDeadline).toBe(true);
    expect(calls).toContain("POST /api/conversations/conv-2/terminate");
  });
});
