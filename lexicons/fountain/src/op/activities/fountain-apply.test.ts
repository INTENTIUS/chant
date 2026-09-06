import { describe, expect, it } from "vitest";
import {
  fountainApply,
  parseManifest,
  toApplyPayload,
  isChantOwned,
  resolveEndpoint,
  resolveConnection,
  vaultNameRefs,
  type FountainHttp,
} from "./fountain-apply";
import { fountainRun } from "./fountain-run";
import type { ChantConfig } from "@intentius/chant/config";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface Reply {
  status: number;
  json?: unknown;
}

/**
 * Scripted fake http: records calls, answers from a route table.
 *
 * A route may hold several replies, which are handed out in order and the
 * last of them repeats — that is how the two `POST /api/apply` calls of a
 * vault-scoped agent (#2166) are scripted apart.
 */
function fakeHttp(routes: Record<string, Reply | Reply[]>): {
  http: FountainHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queues = new Map<string, Reply[]>();
  const http: FountainHttp = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const hit = routes[key];
    if (!hit) throw new Error(`unrouted: ${key}`);
    if (!Array.isArray(hit)) return { status: hit.status, json: hit.json ?? null };
    const queue = queues.get(key) ?? [...hit];
    queues.set(key, queue);
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    return { status: reply.status, json: reply.json ?? null };
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
    expect(resolveEndpoint({}, {})).toBe("https://fountain.inevitable.fyi");
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

  it("vaultNameRefs picks out the allowed_vault_ids entries that are names (#2166)", () => {
    const uuid = "0f1e2d3c-4b5a-4968-8776-655443332211";
    expect(vaultNameRefs({ allowed_vault_ids: ["prod-creds", uuid] })).toEqual(["prod-creds"]);
    expect(vaultNameRefs({ allowed_vault_ids: [] })).toEqual([]);
    expect(vaultNameRefs({})).toEqual([]);
  });

  it("isChantOwned keys on the metadata marker", () => {
    expect(isChantOwned({ metadata: { "managed-by": "chant" } })).toBe(true);
    expect(isChantOwned({ metadata: { "managed-by": "human" } })).toBe(false);
    expect(isChantOwned({})).toBe(false);
  });
});

describe("resolveConnection (#2124)", () => {
  const configWithProfiles: ChantConfig = {
    lexicons: ["fountain"],
    fountain: {
      profiles: {
        staging: { endpoint: "https://staging.example.com/", token: { env: "STAGING_TOKEN_2124" } },
      },
      defaultProfile: "staging",
    },
  } as unknown as ChantConfig;

  it("explicit endpoint and token skip config resolution entirely", async () => {
    const result = await resolveConnection(
      { endpoint: "http://explicit", token: "explicit-token", profile: "staging" },
      { config: {} as ChantConfig },
    );
    expect(result).toEqual({ endpoint: "http://explicit", token: "explicit-token" });
  });

  it("resolves endpoint and token from the named profile's env var", async () => {
    process.env.STAGING_TOKEN_2124 = "tok-from-env";
    try {
      const result = await resolveConnection(
        { profile: "staging" },
        { config: configWithProfiles },
      );
      expect(result).toEqual({ endpoint: "https://staging.example.com", token: "tok-from-env" });
    } finally {
      delete process.env.STAGING_TOKEN_2124;
    }
  });

  it("falls back to defaultProfile when no profile name is given", async () => {
    process.env.STAGING_TOKEN_2124 = "tok-from-env";
    try {
      const result = await resolveConnection({}, { config: configWithProfiles });
      expect(result.endpoint).toBe("https://staging.example.com");
    } finally {
      delete process.env.STAGING_TOKEN_2124;
    }
  });

  it("throws an actionable error naming the missing env var when the profile resolves but its env var is unset", async () => {
    delete process.env.STAGING_TOKEN_2124;
    await expect(
      resolveConnection({ profile: "staging" }, { config: configWithProfiles }),
    ).rejects.toThrow(/STAGING_TOKEN_2124/);
  });

  it("an explicit token wins over the profile's env var", async () => {
    process.env.STAGING_TOKEN_2124 = "tok-from-env";
    try {
      const result = await resolveConnection(
        { profile: "staging", token: "explicit-wins" },
        { config: configWithProfiles },
      );
      expect(result.token).toBe("explicit-wins");
    } finally {
      delete process.env.STAGING_TOKEN_2124;
    }
  });

  it("falls back to FOUNTAIN_ENDPOINT/FOUNTAIN_TOKEN when no profile resolves", async () => {
    const saved = { endpoint: process.env.FOUNTAIN_ENDPOINT, token: process.env.FOUNTAIN_TOKEN };
    process.env.FOUNTAIN_ENDPOINT = "http://env-endpoint";
    process.env.FOUNTAIN_TOKEN = "env-token";
    try {
      const result = await resolveConnection({}, { config: {} as ChantConfig });
      expect(result).toEqual({ endpoint: "http://env-endpoint", token: "env-token" });
    } finally {
      if (saved.endpoint === undefined) delete process.env.FOUNTAIN_ENDPOINT;
      else process.env.FOUNTAIN_ENDPOINT = saved.endpoint;
      if (saved.token === undefined) delete process.env.FOUNTAIN_TOKEN;
      else process.env.FOUNTAIN_TOKEN = saved.token;
    }
  });
});

describe("fountainApply", () => {
  it("with no http override, sends to the resolved profile's endpoint using its env-var token", async () => {
    const configWithProfiles: ChantConfig = {
      lexicons: ["fountain"],
      fountain: {
        profiles: {
          staging: { endpoint: "https://staging.example.com", token: { env: "STAGING_TOKEN_2124B" } },
        },
      },
    } as unknown as ChantConfig;
    process.env.STAGING_TOKEN_2124B = "tok-b";
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { results: [] } }), { status: 200 });
    }) as typeof fetch;
    try {
      await fountainApply({ manifestContent: MANIFEST, profile: "staging" }, undefined, {
        config: configWithProfiles,
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.STAGING_TOKEN_2124B;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://staging.example.com/api/apply");
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tok-b");
  });

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
    expect(summary).toEqual({
      created: [],
      updated: [],
      unchanged: [],
      pruned: [],
      secretsUpserted: 0,
    });
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
      "GET /api/team": { status: 200, json: { data: [] } },
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
      "GET /api/team": { status: 200, json: { data: [] } },
    });

    const summary = await fountainApply({ manifestContent: manifest, prune: true }, http);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(summary.pruned).toEqual([]);
  });
});

// ── The three v0.16.0 kinds, reconciled through their own routes ──────────

const STEWARD_MANIFEST = `apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: prod-steward
spec:
  runtime: acp
  runtime_command: chant acp
  environment: toolchain
---
apiVersion: fountain.dev/v1
kind: Teammate
metadata:
  name: prod-steward
spec:
  agent: prod-steward
  environment: toolchain
  vault: prod-creds
---
apiVersion: fountain.dev/v1
kind: Schedule
metadata:
  name: prod-steward-prod-watch
spec:
  teammate: prod-steward
  cron: "*/10 * * * *"
  prompt: chant run prod-watch
  one_off: false
  enabled: true
---
apiVersion: fountain.dev/v1
kind: Webhook
metadata:
  name: prodHook
spec:
  url: https://hooks.example.com/chant
  event_types:
    - conversation.turn.done
`;

/** The bulk call, answering "created" for whatever the manifest sent it. */
function bulkCreated(): { status: number; json: unknown } {
  return {
    status: 200,
    json: {
      data: {
        results: [{ kind: "Agent", name: "prod-steward", action: "created", errors: null, secrets: [] }],
      },
    },
  };
}

const LIVE_AGENTS = {
  status: 200,
  json: { data: [{ id: "a-1", name: "prod-steward", metadata: { "managed-by": "chant" } }] },
};
const LIVE_ENVIRONMENTS = {
  status: 200,
  json: { data: [{ id: "e-1", name: "toolchain", metadata: { "managed-by": "chant" } }] },
};
const LIVE_VAULTS = {
  status: 200,
  json: { data: [{ id: "v-1", name: "prod-creds", metadata: { "managed-by": "chant" } }] },
};

/** The roster once the steward is on the team. */
const ON_TEAM = {
  status: 200,
  json: {
    data: [
      {
        agent_id: "a-1",
        name: "prod-steward",
        agent: { id: "a-1", name: "prod-steward", metadata: { "managed-by": "chant" } },
      },
    ],
  },
};

const LIVE_SCHEDULE = {
  id: "s-1",
  name: "prod-steward-prod-watch",
  cron: "*/10 * * * *",
  prompt: "chant run prod-watch",
  one_off: false,
  enabled: true,
};

const LIVE_WEBHOOK = {
  id: "w-1",
  url: "https://hooks.example.com/chant",
  event_types: ["conversation.turn.done"],
  description: null,
};

// ── allowed_vault_ids (#2166) ─────────────────────────────────────────────
//
// The Steward composite scopes its agent to a Vault, and the manifest's
// reference form is the vault's name. Fountain types that column
// `{:array, :binary_id}` and passes it straight to the insert, so a name there
// crashes in Ecto behind a bare 500 that drops the connection. These cover the
// resolution that keeps the authored shape and sends fountain uuids.

const VAULT_UUID = "0f1e2d3c-4b5a-4968-8776-655443332211";

const STEWARD_WITH_VAULT = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: prod-toolchain
spec:
  networking_type: limited
---
apiVersion: fountain.dev/v1
kind: Vault
metadata:
  name: prod-creds
spec:
  secrets:
    - key: AWS_ACCESS_KEY_ID
      value: AKIA
---
apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: prod-steward
spec:
  runtime: acp
  environment: prod-toolchain
  allowed_vault_ids:
    - prod-creds
`;

function applyResults(...results: Array<{ kind: string; name: string }>): Reply {
  return {
    status: 200,
    json: {
      data: {
        results: results.map((r) => ({ ...r, action: "created", errors: null, secrets: [] })),
      },
    },
  };
}

/** Every bulk resource in one call's body, as `Kind/name`. */
function sentResources(call: Call | undefined): string[] {
  const body = call?.body as { resources?: Array<{ kind: string; name: string }> } | undefined;
  return (body?.resources ?? []).map((r) => `${r.kind}/${r.name}`);
}

describe("fountainApply — allowed_vault_ids (#2166)", () => {
  it("resolves the vault name to its id, after the call that creates the vault", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": [
        applyResults({ kind: "Environment", name: "prod-toolchain" }, { kind: "Vault", name: "prod-creds" }),
        applyResults({ kind: "Agent", name: "prod-steward" }),
      ],
      "GET /api/vaults": {
        status: 200,
        json: { data: [{ id: VAULT_UUID, name: "prod-creds", metadata: { "managed-by": "chant" } }] },
      },
    });

    const summary = await fountainApply({ manifestContent: STEWARD_WITH_VAULT }, http);

    // The vault the agent names is created first, then read back for its id.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/apply",
      "GET /api/vaults",
      "POST /api/apply",
    ]);
    expect(sentResources(calls[0])).toEqual(["Environment/prod-toolchain", "Vault/prod-creds"]);
    expect(sentResources(calls[2])).toEqual(["Agent/prod-steward"]);

    const agent = (calls[2].body as { resources: Array<{ spec: Record<string, unknown> }> }).resources[0];
    expect(agent.spec.allowed_vault_ids).toEqual([VAULT_UUID]);
    // The sibling environment reference is still a name — the server resolves it.
    expect(agent.spec.environment).toBe("prod-toolchain");

    expect(summary.created).toEqual([
      "Environment/prod-toolchain",
      "Vault/prod-creds",
      "Agent/prod-steward",
    ]);
  });

  it("fails by name, not in the database layer, when the vault does not exist", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": [
        applyResults({ kind: "Environment", name: "prod-toolchain" }, { kind: "Vault", name: "prod-creds" }),
        applyResults({ kind: "Agent", name: "prod-steward" }),
      ],
      "GET /api/vaults": { status: 200, json: { data: [] } },
    });

    await expect(fountainApply({ manifestContent: STEWARD_WITH_VAULT }, http)).rejects.toThrow(
      /Agent\/prod-steward: allowed_vault_ids names the vault "prod-creds"/,
    );
    // The agent was never sent, so fountain never saw the name.
    expect(calls.filter((c) => c.path === "/api/apply")).toHaveLength(1);
  });

  it("leaves a uuid alone and stays in one call", async () => {
    const manifest = STEWARD_WITH_VAULT.replace("- prod-creds", `- ${VAULT_UUID}`);
    const { http, calls } = fakeHttp({
      "POST /api/apply": applyResults(
        { kind: "Environment", name: "prod-toolchain" },
        { kind: "Vault", name: "prod-creds" },
        { kind: "Agent", name: "prod-steward" },
      ),
    });

    await fountainApply({ manifestContent: manifest }, http);

    expect(calls).toHaveLength(1);
    const agent = (calls[0].body as { resources: Array<{ spec: Record<string, unknown> }> }).resources[2];
    expect(agent.spec.allowed_vault_ids).toEqual([VAULT_UUID]);
  });

  it("sends an empty allowlist as it stands — a steward with no vault attaches none", async () => {
    const manifest = STEWARD_WITH_VAULT.replace("  allowed_vault_ids:\n    - prod-creds\n", "  allowed_vault_ids: []\n");
    const { http, calls } = fakeHttp({
      "POST /api/apply": applyResults(
        { kind: "Environment", name: "prod-toolchain" },
        { kind: "Vault", name: "prod-creds" },
        { kind: "Agent", name: "prod-steward" },
      ),
    });

    await fountainApply({ manifestContent: manifest }, http);

    expect(calls).toHaveLength(1);
    const agent = (calls[0].body as { resources: Array<{ spec: Record<string, unknown> }> }).resources[2];
    expect(agent.spec.allowed_vault_ids).toEqual([]);
  });
});

describe("fountainApply — Teammate, Schedule and Webhook", () => {
  it("creates all three on a first apply, after the bulk call", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": bulkCreated(),
      "GET /api/agents": LIVE_AGENTS,
      "GET /api/environments": LIVE_ENVIRONMENTS,
      "GET /api/vaults": LIVE_VAULTS,
      "GET /api/team": { status: 200, json: { data: [] } },
      "POST /api/team": { status: 201, json: { data: { agent_id: "a-1" } } },
      "GET /api/team/a-1/schedules": { status: 200, json: { data: [] } },
      "POST /api/team/a-1/schedules": { status: 201, json: { data: { id: "s-1" } } },
      "GET /api/webhooks": { status: 200, json: { data: [] } },
      "POST /api/webhooks": { status: 201, json: { data: { id: "w-1" } } },
    });

    const summary = await fountainApply({ manifestContent: STEWARD_MANIFEST }, http);

    expect(summary.created).toEqual([
      "Agent/prod-steward",
      "Teammate/prod-steward",
      "Schedule/prod-steward-prod-watch",
      "Webhook/prodHook",
    ]);
    expect(summary.unchanged).toEqual([]);

    // The bulk call carries only the kinds `/api/apply` knows.
    const bulk = calls.find((c) => c.path === "/api/apply")!;
    expect((bulk.body as { resources: Array<{ kind: string }> }).resources.map((r) => r.kind)).toEqual([
      "Agent",
    ]);

    // Name references became the ids the routes take.
    const addTeammate = calls.find((c) => c.method === "POST" && c.path === "/api/team")!;
    expect(addTeammate.body).toEqual({
      agent_id: "a-1",
      name: "prod-steward",
      environment_id: "e-1",
      vault_id: "v-1",
    });

    const addSchedule = calls.find((c) => c.path === "/api/team/a-1/schedules" && c.method === "POST")!;
    expect(addSchedule.body).toEqual({
      name: "prod-steward-prod-watch",
      cron: "*/10 * * * *",
      prompt: "chant run prod-watch",
      one_off: false,
      enabled: true,
    });
  });

  it("reports unchanged and writes nothing on a second apply", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Agent", name: "prod-steward", action: "unchanged", errors: null, secrets: [] },
            ],
          },
        },
      },
      "GET /api/agents": LIVE_AGENTS,
      "GET /api/team": ON_TEAM,
      "GET /api/team/a-1/schedules": { status: 200, json: { data: [LIVE_SCHEDULE] } },
      "GET /api/webhooks": { status: 200, json: { data: [LIVE_WEBHOOK] } },
    });

    const summary = await fountainApply({ manifestContent: STEWARD_MANIFEST }, http);

    expect(summary.unchanged).toEqual([
      "Agent/prod-steward",
      "Teammate/prod-steward",
      "Schedule/prod-steward-prod-watch",
      "Webhook/prodHook",
    ]);
    expect(summary.created).toEqual([]);
    expect(summary.updated).toEqual([]);
    expect(calls.filter((c) => c.method === "PATCH" || c.method === "DELETE")).toEqual([]);
  });

  it("PATCHes a schedule whose cron drifted, and nothing else", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Agent", name: "prod-steward", action: "unchanged", errors: null, secrets: [] },
            ],
          },
        },
      },
      "GET /api/agents": LIVE_AGENTS,
      "GET /api/team": ON_TEAM,
      "GET /api/team/a-1/schedules": {
        status: 200,
        json: { data: [{ ...LIVE_SCHEDULE, cron: "0 3 * * *" }] },
      },
      "PATCH /api/team/a-1/schedules/s-1": { status: 200, json: { data: LIVE_SCHEDULE } },
      "GET /api/webhooks": { status: 200, json: { data: [LIVE_WEBHOOK] } },
    });

    const summary = await fountainApply({ manifestContent: STEWARD_MANIFEST }, http);

    expect(summary.updated).toEqual(["Schedule/prod-steward-prod-watch"]);
    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect((patches[0].body as { cron: string }).cron).toBe("*/10 * * * *");
  });

  it("PATCHes a webhook whose event types drifted", async () => {
    const { http } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Agent", name: "prod-steward", action: "unchanged", errors: null, secrets: [] },
            ],
          },
        },
      },
      "GET /api/agents": LIVE_AGENTS,
      "GET /api/team": ON_TEAM,
      "GET /api/team/a-1/schedules": { status: 200, json: { data: [LIVE_SCHEDULE] } },
      "GET /api/webhooks": {
        status: 200,
        json: { data: [{ ...LIVE_WEBHOOK, event_types: ["conversation.turn.failed"] }] },
      },
      "PATCH /api/webhooks/w-1": { status: 200, json: { data: LIVE_WEBHOOK } },
    });

    const summary = await fountainApply({ manifestContent: STEWARD_MANIFEST }, http);
    expect(summary.updated).toEqual(["Webhook/prodHook"]);
  });

  it("renames a teammate whose display name drifted", async () => {
    const { http, calls } = fakeHttp({
      "POST /api/apply": {
        status: 200,
        json: {
          data: {
            results: [
              { kind: "Agent", name: "prod-steward", action: "unchanged", errors: null, secrets: [] },
            ],
          },
        },
      },
      "GET /api/agents": LIVE_AGENTS,
      "GET /api/team": {
        status: 200,
        json: {
          data: [
            {
              agent_id: "a-1",
              name: "renamed-in-the-ui",
              agent: { id: "a-1", name: "prod-steward", metadata: { "managed-by": "chant" } },
            },
          ],
        },
      },
      "PATCH /api/team/a-1": { status: 200, json: { data: {} } },
      "GET /api/team/a-1/schedules": { status: 200, json: { data: [LIVE_SCHEDULE] } },
      "GET /api/webhooks": { status: 200, json: { data: [LIVE_WEBHOOK] } },
    });

    const summary = await fountainApply({ manifestContent: STEWARD_MANIFEST }, http);
    expect(summary.updated).toEqual(["Teammate/prod-steward"]);
    expect(calls.find((c) => c.path === "/api/team/a-1")!.body).toEqual({ name: "prod-steward" });
  });

  it("prunes an unlisted schedule and teammate, and only the chant-owned ones", async () => {
    const { http, calls } = fakeHttp({
      "GET /api/team": {
        status: 200,
        json: {
          data: [
            {
              agent_id: "a-1",
              name: "retired-steward",
              agent: { id: "a-1", name: "retired-steward", metadata: { "managed-by": "chant" } },
            },
            {
              agent_id: "a-9",
              name: "a-person",
              agent: { id: "a-9", name: "a-person", metadata: {} },
            },
          ],
        },
      },
      "GET /api/team/a-1/schedules": {
        status: 200,
        json: { data: [{ ...LIVE_SCHEDULE, name: "retired-nightly" }] },
      },
      "DELETE /api/team/a-1/schedules/s-1": { status: 204 },
      "DELETE /api/team/a-1": { status: 204 },
      "GET /api/environments": { status: 200, json: { data: [] } },
      "GET /api/vaults": { status: 200, json: { data: [] } },
      "GET /api/agents": { status: 200, json: { data: [] } },
    });

    const summary = await fountainApply({ manifestContent: "", prune: true }, http);

    expect(summary.pruned).toEqual(["Schedule/retired-nightly", "Teammate/retired-steward"]);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/api/team/a-1/schedules/s-1",
      "/api/team/a-1",
    ]);
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
