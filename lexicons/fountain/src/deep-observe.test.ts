/**
 * fountain deep observation (#1217).
 *
 * The transport is the only thing mocked — a `FountainHttp` routed by
 * `METHOD /path`, the same seam `describe-resources.test.ts` drives — so
 * nothing here opens a socket. The drift assertions run through core's own
 * `diffDeepObservation`, with the lexicon's real hooks on both trees, because
 * the question a noise table has to answer is not "what did the reader return"
 * but "what does a clean apply report".
 */

import { describe, expect, it } from "vitest";
import { diffDeepObservation, type DeclaredEntities } from "@intentius/chant/lifecycle/deep-observe";
import { normalizeDeepObservation, MASKED } from "@intentius/chant/deep-observation";
import { Environment } from "./generated/index";
import { observeResourcesDeepFountain, type FountainDeepObserveOptions } from "./deep-observe";
import { fountainDeepNormalizationHooks } from "./deep-observe-hooks";
import { fountainPlugin } from "./plugin";
import type { FountainHttp } from "./op/activities/fountain-apply";

const ENV = "Fountain::V1::Environment";
const VAULT = "Fountain::V1::Vault";
const AGENT = "Fountain::V1::Agent";

const STAMPS = { inserted_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z" };

/** A live Environment record as fountain's own JSON view renders it. */
function liveEnvironment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "env-1",
    name: "concierge-env",
    packages: {},
    env_vars: {},
    setup_script: "",
    networking_type: "limited",
    networking_config: { allowed_hosts: ["api.github.com"] },
    repositories: [],
    metadata: { "managed-by": "chant" },
    secret_count: 0,
    agent_count: 1,
    ...STAMPS,
    ...overrides,
  };
}

function liveVault(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "vault-1",
    name: "ops-vault",
    description: "",
    metadata: { "managed-by": "chant" },
    secret_count: 0,
    ...STAMPS,
    ...overrides,
  };
}

function liveAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent-1",
    name: "researcher",
    description: "",
    system: "You research things.",
    model: "anthropic/claude-sonnet-4-6",
    runtime: "claude",
    acp: true,
    sandbox_provider: null,
    sandbox_mode: "ephemeral",
    environment_id: "env-1",
    skills: [{ source: "acme/skills", ref: "v1.2.0" }],
    mcp_servers: {},
    metadata: { "managed-by": "chant" },
    allowed_vault_ids: [],
    allowed_environment_ids: null,
    permission_policy: {},
    conversation_count: 3,
    avatar_media_type: null,
    ...STAMPS,
    ...overrides,
  };
}

interface Route {
  status: number;
  json?: unknown;
}

function routed(routes: Record<string, Route>): FountainHttp {
  return async (method, path) => {
    const hit = routes[`${method} ${path}`];
    if (!hit) throw new Error(`unrouted: ${method} ${path}`);
    return { status: hit.status, json: hit.json ?? null };
  };
}

/** The default estate: one environment, one vault, one agent, no secrets. */
function estate(overrides: Record<string, Route> = {}): FountainHttp {
  return routed({
    "GET /api/environments": { status: 200, json: { data: [liveEnvironment()] } },
    "GET /api/vaults": { status: 200, json: { data: [liveVault()] } },
    "GET /api/agents": { status: 200, json: { data: [liveAgent()] } },
    "GET /api/environments/env-1/secrets": { status: 200, json: { data: [] } },
    "GET /api/vaults/vault-1/secrets": { status: 200, json: { data: [] } },
    ...overrides,
  });
}

function declared(defs: Record<string, { entityType: string; props: Record<string, unknown> }>): DeclaredEntities {
  return new Map(Object.entries(defs));
}

function options(entities: DeclaredEntities, extra?: Partial<FountainDeepObserveOptions>): FountainDeepObserveOptions {
  return {
    environment: "local",
    buildOutput: "",
    entityNames: [...entities.keys()],
    entities,
    ...extra,
  };
}

/** Read live, then diff against the declaration with the lexicon's own hooks. */
async function drift(entities: DeclaredEntities, http: FountainHttp, extra?: Partial<FountainDeepObserveOptions>) {
  const live = normalizeDeepObservation(await observeResourcesDeepFountain(options(entities, extra), http));
  return { live, diff: diffDeepObservation(entities, live, fountainDeepNormalizationHooks) };
}

// The declaration the estate above was applied from. `environment` is the
// typed reference a chant project writes, not the id fountain resolved it to.
const conciergeEnvironment = new Environment({
  name: "concierge-env",
  networking_type: "limited",
  networking_config: { allowed_hosts: ["api.github.com"] },
  metadata: { "managed-by": "chant" },
});

function conciergeDeclaration(): DeclaredEntities {
  return declared({
    conciergeEnv: {
      entityType: ENV,
      props: {
        name: "concierge-env",
        networking_type: "limited",
        networking_config: { allowed_hosts: ["api.github.com"] },
        metadata: { "managed-by": "chant" },
      },
    },
    opsVault: {
      entityType: VAULT,
      props: { name: "ops-vault", metadata: { "managed-by": "chant" } },
    },
    researcher: {
      entityType: AGENT,
      props: {
        name: "researcher",
        model: "anthropic/claude-sonnet-4-6",
        runtime: "claude",
        system: "You research things.",
        environment: conciergeEnvironment,
        skills: [{ source: "acme/skills", ref: "v1.2.0" }],
        allowed_vault_ids: [],
        metadata: { "managed-by": "chant" },
      },
    },
  });
}

describe("a clean apply reports nothing", () => {
  it("every server-populated field and every untouched default is subtracted", async () => {
    const { diff } = await drift(conciergeDeclaration(), estate());

    expect(diff.drifted).toEqual([]);
    expect(diff.unobserved).toEqual([]);
    expect(diff.unchanged.sort()).toEqual(["conciergeEnv", "opsVault", "researcher"]);
  });

  it("the returned tree carries no ids or timestamps", async () => {
    const { live } = await drift(conciergeDeclaration(), estate());

    for (const observed of Object.values(live.resources)) {
      for (const key of ["id", "inserted_at", "updated_at", "secret_count", "agent_count", "acp", "conversation_count"]) {
        expect(Object.keys(observed.properties)).not.toContain(key);
      }
    }
    // The physical id is reported on the envelope, where it belongs.
    expect(live.resources.conciergeEnv.physicalId).toBe("env-1");
    expect(live.resources.researcher.physicalId).toBe("agent-1");
  });

  it("a reordered repository list is not drift", async () => {
    const entities = declared({
      env: {
        entityType: ENV,
        props: {
          name: "concierge-env",
          networking_type: "limited",
          metadata: { "managed-by": "chant" },
          repositories: [
            { url: "https://example.com/a.git", mount_path: "/a" },
            { url: "https://example.com/b.git", mount_path: "/b" },
          ],
        },
      },
    });
    const http = estate({
      "GET /api/environments": {
        status: 200,
        json: {
          data: [
            liveEnvironment({
              networking_config: {},
              repositories: [
                { url: "https://example.com/b.git", mount_path: "/b" },
                { url: "https://example.com/a.git", mount_path: "/a" },
              ],
            }),
          ],
        },
      },
    });

    const { diff } = await drift(entities, http);
    expect(diff.drifted).toEqual([]);
  });
});

describe("the drift the design was written for", () => {
  it("a UI flip from limited to unrestricted reports as a changed property", async () => {
    const http = estate({
      "GET /api/environments": {
        status: 200,
        json: { data: [liveEnvironment({ networking_type: "unrestricted", networking_config: {} })] },
      },
    });

    const { diff } = await drift(conciergeDeclaration(), http);
    const env = diff.drifted.find((d) => d.name === "conciergeEnv");
    expect(env?.changes).toContainEqual(
      expect.objectContaining({ path: "networking_type", kind: "changed", declared: "limited", live: "unrestricted" }),
    );
  });

  it("an egress allowlist widened in the UI reports the added host", async () => {
    const http = estate({
      "GET /api/environments": {
        status: 200,
        json: {
          data: [liveEnvironment({ networking_config: { allowed_hosts: ["api.github.com", "evil.example.com"] } })],
        },
      },
    });

    const { diff } = await drift(conciergeDeclaration(), http);
    const env = diff.drifted.find((d) => d.name === "conciergeEnv");
    expect(env?.changes.some((c) => c.kind === "undeclared" && c.live === "evil.example.com")).toBe(true);
  });

  it("a vault allowlist widened from none to any reports as drift", async () => {
    const http = estate({
      "GET /api/agents": { status: 200, json: { data: [liveAgent({ allowed_vault_ids: null })] } },
    });

    const { diff } = await drift(conciergeDeclaration(), http);
    const agent = diff.drifted.find((d) => d.name === "researcher");
    // The declared `[]` (no vault may attach) is gone live. `null` is
    // fountain's legacy-permissive state, and it must not be pruned as an
    // unset column when source declared the field.
    expect(agent?.changes).toContainEqual(
      expect.objectContaining({ path: "allowed_vault_ids", kind: "changed", live: null }),
    );
  });

  it("a skill unpinned from its ref reports the lost pin", async () => {
    const http = estate({
      "GET /api/agents": { status: 200, json: { data: [liveAgent({ skills: [{ source: "acme/skills" }] })] } },
    });

    const { diff } = await drift(conciergeDeclaration(), http);
    const agent = diff.drifted.find((d) => d.name === "researcher");
    expect(agent?.changes).toContainEqual(
      expect.objectContaining({ kind: "absent", declared: "v1.2.0" }),
    );
  });
});

describe("secrets: presence classifies, values and keys never leave fountain", () => {
  it("a secret added to an environment that declares none reports as undeclared", async () => {
    const http = estate({
      "GET /api/environments/env-1/secrets": {
        status: 200,
        json: { data: [{ id: "s-1", key: "STRIPE_KEY", environment_id: "env-1", ...STAMPS }] },
      },
    });

    const { live, diff } = await drift(conciergeDeclaration(), http);
    const env = diff.drifted.find((d) => d.name === "conciergeEnv");
    expect(env?.changes).toContainEqual(
      expect.objectContaining({ path: "secrets", kind: "undeclared", live: MASKED }),
    );

    // Not the value — fountain never returns one — and not the key either:
    // core's key-name mask collapses the whole node on both trees.
    expect(JSON.stringify(live.resources.conciergeEnv.properties)).not.toContain("STRIPE_KEY");
    expect(JSON.stringify(diff.drifted)).not.toContain("STRIPE_KEY");
  });

  it("declared secrets against live secrets is unchanged, and no value is compared", async () => {
    const entities = declared({
      env: {
        entityType: ENV,
        props: {
          name: "concierge-env",
          networking_type: "limited",
          networking_config: { allowed_hosts: ["api.github.com"] },
          metadata: { "managed-by": "chant" },
          secrets: [{ key: "STRIPE_KEY", value: "${STRIPE_KEY}" }],
        },
      },
    });
    const http = estate({
      "GET /api/environments/env-1/secrets": {
        status: 200,
        json: { data: [{ id: "s-1", key: "STRIPE_KEY", environment_id: "env-1", ...STAMPS }] },
      },
    });

    const { diff } = await drift(entities, http);
    expect(diff.drifted).toEqual([]);
    expect(diff.unchanged).toEqual(["env"]);
  });

  it("an authored-but-empty secrets list is not reported absent", async () => {
    const entities = declared({
      env: {
        entityType: ENV,
        props: {
          name: "concierge-env",
          networking_type: "limited",
          networking_config: { allowed_hosts: ["api.github.com"] },
          metadata: { "managed-by": "chant" },
          secrets: [],
        },
      },
    });

    const { diff } = await drift(entities, estate());
    expect(diff.drifted).toEqual([]);
  });

  it("a credential-shaped value is masked on both sides", async () => {
    const entities = declared({
      env: {
        entityType: ENV,
        props: {
          name: "concierge-env",
          networking_type: "limited",
          networking_config: { allowed_hosts: ["api.github.com"] },
          metadata: { "managed-by": "chant" },
          env_vars: { DEPLOY_KEY: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
        },
      },
    });
    const http = estate({
      "GET /api/environments": {
        status: 200,
        json: { data: [liveEnvironment({ env_vars: { DEPLOY_KEY: "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" } })] },
      },
    });

    const { live, diff } = await drift(entities, http);
    expect((live.resources.env.properties.env_vars as Record<string, unknown>).DEPLOY_KEY).toBe(MASKED);
    // Both sides collapse, so a rotated credential reads as unchanged rather
    // than printing either value.
    expect(diff.drifted).toEqual([]);
    expect(JSON.stringify(diff)).not.toContain("ghp_");
  });
});

describe("the agent's environment reference", () => {
  it("resolves the server-assigned id back to the environment name", async () => {
    const { live } = await drift(conciergeDeclaration(), estate());
    expect(live.resources.researcher.properties.environment).toBe("concierge-env");
    expect(live.resources.researcher.properties.environment_id).toBeUndefined();
  });

  it("passes the id through where source authored the id itself", async () => {
    const entities = declared({
      researcher: {
        entityType: AGENT,
        props: {
          name: "researcher",
          model: "anthropic/claude-sonnet-4-6",
          runtime: "claude",
          system: "You research things.",
          environment_id: "env-1",
          skills: [{ source: "acme/skills", ref: "v1.2.0" }],
          allowed_vault_ids: [],
          metadata: { "managed-by": "chant" },
        },
      },
    });

    const { live, diff } = await drift(entities, estate());
    expect(live.resources.researcher.properties.environment_id).toBe("env-1");
    expect(live.resources.researcher.properties.environment).toBeUndefined();
    expect(diff.drifted).toEqual([]);
  });

  it("an environment attached to an agent that declares none reports as undeclared", async () => {
    const entities = declared({
      researcher: {
        entityType: AGENT,
        props: {
          name: "researcher",
          model: "anthropic/claude-sonnet-4-6",
          runtime: "claude",
          system: "You research things.",
          skills: [{ source: "acme/skills", ref: "v1.2.0" }],
          allowed_vault_ids: [],
          metadata: { "managed-by": "chant" },
        },
      },
    });

    const { diff } = await drift(entities, estate());
    expect(diff.drifted[0]?.changes).toContainEqual(
      expect.objectContaining({ path: "environment", kind: "undeclared", live: "concierge-env" }),
    );
  });
});

describe("holes are holes, not clean trees", () => {
  it("a missing token reports no-credentials for every entity and observes nothing", async () => {
    const saved = process.env.FOUNTAIN_TOKEN;
    delete process.env.FOUNTAIN_TOKEN;
    try {
      const result = normalizeDeepObservation(
        await observeResourcesDeepFountain(options(conciergeDeclaration())),
      );
      expect(result.resources).toEqual({});
      expect(Object.values(result.unobserved).map((u) => u.reason)).toEqual([
        "no-credentials",
        "no-credentials",
        "no-credentials",
      ]);
    } finally {
      if (saved !== undefined) process.env.FOUNTAIN_TOKEN = saved;
    }
  });

  it("a failed kind list marks only that kind read-failed", async () => {
    const http = estate({ "GET /api/vaults": { status: 500 } });
    const { live } = await drift(conciergeDeclaration(), http);

    expect(live.unobserved.opsVault.reason).toBe("read-failed");
    expect(live.resources.opsVault).toBeUndefined();
    expect(live.resources.conciergeEnv).toBeDefined();
    expect(live.resources.researcher).toBeDefined();
  });

  it("a failed secrets listing makes the whole entity a hole", async () => {
    const http = estate({ "GET /api/environments/env-1/secrets": { status: 503 } });
    const { live } = await drift(conciergeDeclaration(), http);

    // Reporting the rest of the environment's properties as clean would be a
    // claim that its secrets did not drift, which this read cannot make.
    expect(live.unobserved.conciergeEnv.reason).toBe("read-failed");
    expect(live.resources.conciergeEnv).toBeUndefined();
  });

  it("an entity absent from the estate is left to the thin read, not double-reported", async () => {
    const entities = declared({ gone: { entityType: VAULT, props: { name: "not-there" } } });
    const { live } = await drift(entities, estate());

    expect(live.resources.gone).toBeUndefined();
    expect(live.unobserved.gone).toBeUndefined();
  });

  it("a kind with no reader is unsupported-kind, never an absence", async () => {
    const entities = declared({ chat: { entityType: "Fountain::V1::Conversation", props: {} } });
    const { live } = await drift(entities, estate());

    expect(live.unobserved.chat.reason).toBe("unsupported-kind");
  });

  it("owned:true withholds an unmarked resource as filtered", async () => {
    const http = estate({
      "GET /api/environments": { status: 200, json: { data: [liveEnvironment({ metadata: {} })] } },
    });
    const entities = declared({ conciergeEnv: { entityType: ENV, props: { name: "concierge-env" } } });
    const { live } = await drift(entities, http, { owned: true });

    expect(live.resources.conciergeEnv).toBeUndefined();
    expect(live.unobserved.conciergeEnv.reason).toBe("filtered");
  });
});

describe("plugin wiring", () => {
  it("exposes the reader and the hooks core needs for the declared tree", () => {
    expect(typeof fountainPlugin.observeResourcesDeep).toBe("function");
    expect(fountainPlugin.deepNormalizationHooks).toBe(fountainDeepNormalizationHooks);
  });
});
