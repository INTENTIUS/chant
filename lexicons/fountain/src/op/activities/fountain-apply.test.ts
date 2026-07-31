import { describe, expect, it } from "vitest";
import {
  fountainApply,
  parseManifest,
  toApplyPayload,
  isChantOwned,
  resolveEndpoint,
  type FountainHttp,
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

const MANIFEST = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: concierge-env
spec:
  networking_type: limited
---
apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: researcher
spec:
  model: a/m
  runtime: claude
  environment: concierge-env
`;

describe("pure helpers", () => {
  it("resolveEndpoint precedence: arg > env > default", () => {
    expect(resolveEndpoint({ endpoint: "http://x/" }, {})).toBe("http://x");
    expect(resolveEndpoint({}, { FOUNTAIN_ENDPOINT: "http://env" })).toBe("http://env");
    expect(resolveEndpoint({}, {})).toBe("https://founta.inevitable.fyi");
  });

  it("parseManifest reads kind/name/spec from each YAML document", () => {
    const resources = parseManifest(MANIFEST);
    expect(resources).toEqual([
      { kind: "Environment", name: "concierge-env", spec: { networking_type: "limited" } },
      {
        kind: "Agent",
        name: "researcher",
        spec: { model: "a/m", runtime: "claude", environment: "concierge-env" },
      },
    ]);
  });

  it("parseManifest skips documents with an unknown or missing kind", () => {
    const resources = parseManifest(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: n\nspec: {}\n",
    );
    expect(resources).toEqual([]);
  });

  it("parseManifest ignores blank documents", () => {
    expect(parseManifest("")).toEqual([]);
    expect(parseManifest("\n---\n\n")).toEqual([]);
  });

  it("toApplyPayload converts the authored secrets array into a key/value map", () => {
    const payload = toApplyPayload({
      name: "e",
      secrets: [{ key: "K", value: "v" }, { bogus: true }],
    });
    expect(payload).toEqual({ name: "e", secrets: { K: "v" } });
  });

  it("toApplyPayload passes spec through unchanged when there is no secrets array", () => {
    const spec = { name: "e", networking_type: "limited" };
    expect(toApplyPayload(spec)).toEqual(spec);
  });

  it("isChantOwned keys on the metadata marker", () => {
    expect(isChantOwned({ metadata: { "managed-by": "chant" } })).toBe(true);
    expect(isChantOwned({ metadata: { "managed-by": "human" } })).toBe(false);
    expect(isChantOwned({})).toBe(false);
  });
});

describe("fountainApply", () => {
  it("sends the whole manifest in one POST /api/apply call", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Environment", name: "concierge-env", action: "created", errors: null, secrets: [] },
              { kind: "Agent", name: "researcher", action: "created", errors: null, secrets: [] },
            ],
          },
        },
      },
    });

    const summary = await fountainApply({ manifestContent: MANIFEST }, http);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/apply" });
    const body = calls[0].body as { resources: Array<{ kind: string; name: string; spec: unknown }> };
    expect(body.resources).toEqual([
      { kind: "Environment", name: "concierge-env", spec: { networking_type: "limited" } },
      { kind: "Agent", name: "researcher", spec: { model: "a/m", runtime: "claude", environment: "concierge-env" } },
    ]);
    expect(summary.created).toEqual(["Environment/concierge-env", "Agent/researcher"]);
  });

  it("does not resolve the agent's environment reference client-side — the server does that now", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: { data: { results: [{ kind: "Agent", name: "researcher", action: "created", errors: null, secrets: [] }] } },
      },
    });

    await fountainApply({ manifestContent: MANIFEST }, http);
    const body = calls[0].body as { resources: Array<{ spec: Record<string, unknown> }> };
    expect(body.resources[1].spec.environment).toBe("concierge-env");
    expect(body.resources[1].spec.environment_id).toBeUndefined();
  });

  it("reports updated actions and converts spec.secrets to a map on the wire", async () => {
    const manifest = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: e
spec:
  secrets:
    - key: OPENAI_API_KEY
      value: sk-abc
`;
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              {
                kind: "Environment",
                name: "e",
                action: "updated",
                errors: null,
                secrets: [{ key: "OPENAI_API_KEY", action: "upserted", errors: null }],
              },
            ],
          },
        },
      },
    });

    const summary = await fountainApply({ manifestContent: manifest }, http);
    expect(summary.updated).toEqual(["Environment/e"]);
    expect(summary.secretsUpserted).toBe(1);
    const body = calls[0].body as { resources: Array<{ spec: Record<string, unknown> }> };
    expect(body.resources[0].spec.secrets).toEqual({ OPENAI_API_KEY: "sk-abc" });
  });

  it("throws with every failure once all results are in, not just the first", async () => {
    const manifest = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: bad-env
spec: {}
---
apiVersion: fountain.dev/v1
kind: Vault
metadata:
  name: bad-vault
spec: {}
`;
    const { http } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              {
                kind: "Environment",
                name: "bad-env",
                action: "error",
                errors: { name: ["has already been taken"] },
                secrets: [],
              },
              {
                kind: "Vault",
                name: "bad-vault",
                action: "error",
                errors: { name: ["has already been taken"] },
                secrets: [],
              },
            ],
          },
        },
      },
    });

    await expect(fountainApply({ manifestContent: manifest }, http)).rejects.toThrow(/2 failure/);
  });

  it("throws on a failed secret upsert", async () => {
    const manifest = `apiVersion: fountain.dev/v1
kind: Vault
metadata:
  name: v
spec:
  secrets:
    - key: BAD
      value: x
`;
    const { http } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              {
                kind: "Vault",
                name: "v",
                action: "created",
                errors: null,
                secrets: [{ key: "BAD", action: "error", errors: { value: ["must be a string"] } }],
              },
            ],
          },
        },
      },
    });

    await expect(fountainApply({ manifestContent: manifest }, http)).rejects.toThrow(/BAD/);
  });

  it("throws when the server rejects the request outright", async () => {
    const { http } = fakeHttp({ "POST /api/apply": { status: 500 } });
    await expect(fountainApply({ manifestContent: MANIFEST }, http)).rejects.toThrow(/500/);
  });

  it("skips the POST entirely for an empty manifest", async () => {
    const { http, calls } = fakeHttp({});
    const summary = await fountainApply({ manifestContent: "" }, http);
    expect(calls).toHaveLength(0);
    expect(summary).toEqual({ created: [], updated: [], pruned: [], secretsUpserted: 0 });
  });

  it("prunes only chant-owned resources, in reverse kind order", async () => {
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

    const summary = await fountainApply({ manifestContent: "", prune: true }, http);
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toEqual(["/api/agents/a-1", "/api/environments/e-1"]);
    expect(summary.pruned).toEqual(["Agent/owned-agent", "Environment/owned-env"]);
  });

  it("does not prune a resource still present in the manifest", async () => {
    const manifest = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: kept-env
spec: {}
`;
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: { data: { results: [{ kind: "Environment", name: "kept-env", action: "updated", errors: null, secrets: [] }] } },
      },
      "GET /api/environments": {
        status: 200,
        json: { data: [{ id: "e-1", name: "kept-env", metadata: { "managed-by": "chant" } }] },
      },
      "GET /api/vaults": { status: 200, json: { data: [] } },
      "GET /api/agents": { status: 200, json: { data: [] } },
    });

    const summary = await fountainApply({ manifestContent: manifest, prune: true }, http);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(summary.pruned).toEqual([]);
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
