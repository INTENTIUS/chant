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
import { Environment, Vault } from "./generated/index";
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

  it("an egress allowlist widened in the UI reports the added host as unclaimed", async () => {
    // fountain is the reference substrate for #2160: a REST payload carries no
    // field ownership, so the declaration is the only witness to who set what.
    // The added host sits at a path this declaration never claimed, so it is
    // reported with its value and it is not drift.
    const http = estate({
      "GET /api/environments": {
        status: 200,
        json: {
          data: [liveEnvironment({ networking_config: { allowed_hosts: ["api.github.com", "evil.example.com"] } })],
        },
      },
    });

    const { diff } = await drift(conciergeDeclaration(), http);
    const env = diff.unclaimed.find((d) => d.name === "conciergeEnv");
    expect(env?.fields).toContainEqual(
      expect.objectContaining({ live: "evil.example.com", source: "claimed-fields" }),
    );
    // Never drift, and never a manager name: nothing on this substrate can say
    // who wrote it, only that chant did not.
    expect(diff.drifted.find((d) => d.name === "conciergeEnv")?.changes ?? []).not.toContainEqual(
      expect.objectContaining({ live: "evil.example.com" }),
    );
    expect(env?.fields.every((f) => f.heldBy === undefined)).toBe(true);
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
  it("a secret added to an environment that declares none reports as unclaimed", async () => {
    const http = estate({
      "GET /api/environments/env-1/secrets": {
        status: 200,
        json: { data: [{ id: "s-1", key: "STRIPE_KEY", environment_id: "env-1", ...STAMPS }] },
      },
    });

    const { live, diff } = await drift(conciergeDeclaration(), http);
    const env = diff.unclaimed.find((d) => d.name === "conciergeEnv");
    expect(env?.fields).toContainEqual(
      expect.objectContaining({ path: "secrets", live: MASKED, source: "claimed-fields" }),
    );

    // Not the value, fountain never returns one, and not the key either:
    // core's key-name mask collapses the whole node on both trees.
    expect(JSON.stringify(live.resources.conciergeEnv.properties)).not.toContain("STRIPE_KEY");
    expect(JSON.stringify(diff.drifted)).not.toContain("STRIPE_KEY");
    expect(JSON.stringify(diff.unclaimed)).not.toContain("STRIPE_KEY");
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
    expect(diff.unclaimed[0]?.fields).toContainEqual(
      expect.objectContaining({ path: "environment", live: "concierge-env", source: "claimed-fields" }),
    );
  });
});

describe("the agent's vault allowlist (#2176)", () => {
  // What the applier sends after it resolves the name (#2166), and what
  // fountain hands back on the next read.
  const VAULT_ID = "8f3c1f2e-0b4a-4c5d-9e6f-1a2b3c4d5e6f";
  const OTHER_ID = "1d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";

  const opsVaultDeclaration = new Vault({ name: "ops-vault", metadata: { "managed-by": "chant" } });

  /** The estate, with the agent scoped to the one vault it was applied with. */
  function scopedEstate(allowed: unknown[] = [VAULT_ID], vaults = [liveVault({ id: VAULT_ID })]): FountainHttp {
    return routed({
      "GET /api/environments": { status: 200, json: { data: [liveEnvironment()] } },
      "GET /api/vaults": { status: 200, json: { data: vaults } },
      "GET /api/agents": { status: 200, json: { data: [liveAgent({ allowed_vault_ids: allowed })] } },
      "GET /api/environments/env-1/secrets": { status: 200, json: { data: [] } },
      [`GET /api/vaults/${VAULT_ID}/secrets`]: { status: 200, json: { data: [] } },
      [`GET /api/vaults/${OTHER_ID}/secrets`]: { status: 200, json: { data: [] } },
    });
  }

  /** The steward's declaration, with the allowlist entry written however. */
  function scopedDeclaration(entry: unknown): DeclaredEntities {
    const entities = conciergeDeclaration();
    const agent = entities.get("researcher")!;
    entities.set("researcher", { ...agent, props: { ...agent.props, allowed_vault_ids: [entry] } });
    return entities;
  }

  it("a name in the declaration is not drift against the uuid fountain returns", async () => {
    const { live, diff } = await drift(scopedDeclaration("ops-vault"), scopedEstate());

    expect(live.resources.researcher.properties.allowed_vault_ids).toEqual(["ops-vault"]);
    expect(diff.drifted).toEqual([]);
    expect(diff.heldElsewhere).toEqual([]);
    expect(diff.unchanged).toContain("researcher");
  });

  it("a Vault declaration in the allowlist is not drift either", async () => {
    // The shape `Steward` emits: the entry is the Vault declaration, because
    // the manifest's reference form is the resource's name. Core collapses a
    // resource reference to UNRESOLVED on the declared side, so the live entry
    // has to come back as that same reference or the two sides key the list
    // differently and a vault chant scoped reads as held by somebody else.
    const { diff } = await drift(scopedDeclaration(opsVaultDeclaration), scopedEstate());

    expect(diff.drifted).toEqual([]);
    expect(diff.heldElsewhere).toEqual([]);
    expect(diff.unchanged).toContain("researcher");
  });

  it("a vault swapped for another one is still reported", async () => {
    const http = scopedEstate(
      [OTHER_ID],
      [liveVault({ id: VAULT_ID }), liveVault({ id: OTHER_ID, name: "finance-vault" })],
    );
    const { live, diff } = await drift(scopedDeclaration("ops-vault"), http);

    expect(live.resources.researcher.properties.allowed_vault_ids).toEqual(["finance-vault"]);
    const agent = diff.drifted.find((d) => d.name === "researcher");
    expect(agent?.changes).toContainEqual(
      expect.objectContaining({ path: "allowed_vault_ids[#ops-vault]", kind: "absent", declared: "ops-vault" }),
    );
    // The vault somebody else put on the list is reported by name, not by uuid.
    expect(diff.heldElsewhere[0]?.fields).toContainEqual(
      expect.objectContaining({ path: "allowed_vault_ids[#finance-vault]", live: "finance-vault" }),
    );
  });

  it("a swap under a Vault declaration is still reported, and reported by name", async () => {
    // The steward shape, changed out from under it. Core collapses a resource
    // reference to UNRESOLVED on the declared side, so a swap here reaches the
    // report as a held field rather than as drift, and the entity still counts
    // as unchanged. That classification is core's, it is what this case did
    // before this fix too, and it is not what #2176 is about. What this fix
    // changes is that the finding is readable: it names "finance-vault"
    // instead of a uuid nobody can place.
    const http = scopedEstate(
      [OTHER_ID],
      [liveVault({ id: VAULT_ID }), liveVault({ id: OTHER_ID, name: "finance-vault" })],
    );
    const { diff } = await drift(scopedDeclaration(opsVaultDeclaration), http);

    expect(diff.heldElsewhere[0]?.fields).toContainEqual(
      expect.objectContaining({ path: "allowed_vault_ids[#finance-vault]", live: "finance-vault" }),
    );
  });

  it("a second vault added by hand is reported by name", async () => {
    const http = scopedEstate(
      [VAULT_ID, OTHER_ID],
      [liveVault({ id: VAULT_ID }), liveVault({ id: OTHER_ID, name: "finance-vault" })],
    );
    const { diff } = await drift(scopedDeclaration("ops-vault"), http);

    expect(diff.drifted).toEqual([]);
    expect(diff.heldElsewhere[0]?.fields).toEqual([
      expect.objectContaining({ path: "allowed_vault_ids[#finance-vault]", live: "finance-vault" }),
    ]);
  });

  it("passes an id through where source authored the id itself", async () => {
    const { live, diff } = await drift(scopedDeclaration(VAULT_ID), scopedEstate());

    expect(live.resources.researcher.properties.allowed_vault_ids).toEqual([VAULT_ID]);
    expect(diff.drifted).toEqual([]);
    expect(diff.heldElsewhere).toEqual([]);
  });

  it("an id no vault answers to survives as itself and reports as drift", async () => {
    // The vault was deleted out of band and the agent still lists it. Dropping
    // the entry would report a clean allowlist against a live one that is not.
    const { live, diff } = await drift(scopedDeclaration("ops-vault"), scopedEstate([OTHER_ID]));

    expect(live.resources.researcher.properties.allowed_vault_ids).toEqual([OTHER_ID]);
    const agent = diff.drifted.find((d) => d.name === "researcher");
    expect(agent?.changes).toContainEqual(
      expect.objectContaining({ path: "allowed_vault_ids[#ops-vault]", kind: "absent" }),
    );
    expect(diff.heldElsewhere[0]?.fields).toContainEqual(
      expect.objectContaining({ path: `allowed_vault_ids[#${OTHER_ID}]`, live: OTHER_ID }),
    );
  });

  it("leaves the empty and the absent state alone", async () => {
    // `[]` is a posture — no vault may attach — and `null` is fountain's
    // legacy-permissive state. Neither is a list of ids to translate.
    const empty = await drift(conciergeDeclaration(), estate());
    expect(empty.live.resources.researcher.properties.allowed_vault_ids).toEqual([]);
    expect(empty.diff.drifted).toEqual([]);

    const permissive = await drift(
      conciergeDeclaration(),
      estate({ "GET /api/agents": { status: 200, json: { data: [liveAgent({ allowed_vault_ids: null })] } } }),
    );
    expect(permissive.live.resources.researcher.properties.allowed_vault_ids).toBeNull();
  });

  it("resolves allowed_environment_ids the same way", async () => {
    // Nothing in chant authors this field today, so nothing in the fixtures
    // exercised it. It is the same uuid column with the same reference form,
    // and a hand-written manifest that names an environment there would have
    // read back as permanent drift for exactly the same reason.
    const entities = conciergeDeclaration();
    const agent = entities.get("researcher")!;
    entities.set("researcher", {
      ...agent,
      props: { ...agent.props, allowed_environment_ids: ["concierge-env"] },
    });

    const ENV_ID = "6c1b8a24-9d3e-4f05-b7a8-2e5c6d7f8091";
    const http = routed({
      "GET /api/environments": { status: 200, json: { data: [liveEnvironment({ id: ENV_ID })] } },
      "GET /api/vaults": { status: 200, json: { data: [liveVault()] } },
      "GET /api/agents": {
        status: 200,
        json: { data: [liveAgent({ environment_id: ENV_ID, allowed_environment_ids: [ENV_ID] })] },
      },
      [`GET /api/environments/${ENV_ID}/secrets`]: { status: 200, json: { data: [] } },
      "GET /api/vaults/vault-1/secrets": { status: 200, json: { data: [] } },
    });
    const { live, diff } = await drift(entities, http);

    expect(live.resources.researcher.properties.allowed_environment_ids).toEqual(["concierge-env"]);
    expect(diff.drifted).toEqual([]);
    expect(diff.heldElsewhere).toEqual([]);
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

// ── The team-side kinds (#2128) ───────────────────────────────────────────
//
// A roster row, a schedule row and a webhook endpoint, as fountain's own JSON
// views render them. The point of these tests is the translation: the wire
// carries `agent_id` and a nested conversation, chant declares `teammate`,
// `environment` and `vault`, and a clean apply has to report nothing.

const TEAMMATE = "Fountain::V1::Teammate";
const SCHEDULE = "Fountain::V1::Schedule";
const WEBHOOK = "Fountain::V1::Webhook";

function liveTeammate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "agent-1",
    name: "ops-steward",
    agent: liveAgent(),
    conversation: { id: "conv-1", environment_id: "env-1", vault_id: "vault-1" },
    presence: { state: "online", label: "Online" },
    preview: { kind: "them", text: "converged" },
    last_turn: null,
    unread: false,
    usage_total: { total_tokens: 812 },
    contact: null,
    ...overrides,
  };
}

function liveSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sched-1",
    agent_id: "agent-1",
    name: "nightly-converge",
    cron: "0 3 * * *",
    prompt: "chant lifecycle converge",
    one_off: false,
    enabled: true,
    next_run_at: "2026-09-07T03:00:00Z",
    last_run_at: "2026-09-06T03:00:00Z",
    last_conversation_id: "conv-7",
    last_error: null,
    ...STAMPS,
    ...overrides,
  };
}

function liveWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wh-1",
    url: "https://ops.example.com/hooks/fountain",
    description: null,
    event_types: ["conversation.turn.done"],
    status: "active",
    consecutive_failures: 0,
    disabled_at: null,
    disabled_reason: null,
    ...STAMPS,
    ...overrides,
  };
}

/** The steward estate: the three base kinds plus the three team-side ones. */
function teamEstate(overrides: Record<string, Route> = {}): FountainHttp {
  return routed({
    "GET /api/environments": { status: 200, json: { data: [liveEnvironment()] } },
    "GET /api/vaults": { status: 200, json: { data: [liveVault()] } },
    "GET /api/agents": { status: 200, json: { data: [liveAgent()] } },
    "GET /api/team": { status: 200, json: { data: [liveTeammate()] } },
    "GET /api/team/schedules": { status: 200, json: { data: [liveSchedule()] } },
    "GET /api/webhooks": { status: 200, json: { data: [liveWebhook()] } },
    ...overrides,
  });
}

function stewardDeclaration(): DeclaredEntities {
  return declared({
    opsSteward: {
      entityType: TEAMMATE,
      props: {
        name: "ops-steward",
        agent: "researcher",
        environment: "concierge-env",
        vault: "ops-vault",
      },
    },
    nightly: {
      entityType: SCHEDULE,
      props: {
        name: "nightly-converge",
        teammate: "ops-steward",
        cron: "0 3 * * *",
        prompt: "chant lifecycle converge",
        enabled: true,
      },
    },
    hook: {
      entityType: WEBHOOK,
      props: {
        url: "https://ops.example.com/hooks/fountain",
        event_types: ["conversation.turn.done"],
      },
    },
  });
}

describe("the team-side kinds read back in the declared vocabulary", () => {
  it("a clean apply of a steward reports nothing", async () => {
    const { diff } = await drift(stewardDeclaration(), teamEstate());

    expect(diff.drifted).toEqual([]);
    expect(diff.unobserved).toEqual([]);
    expect(diff.unchanged.sort()).toEqual(["hook", "nightly", "opsSteward"]);
  });

  it("the ids the wire carries are translated to the names an author writes", async () => {
    const { live } = await drift(stewardDeclaration(), teamEstate());

    expect(live.resources.opsSteward.properties).toEqual({
      name: "ops-steward",
      agent: "researcher",
      environment: "concierge-env",
      vault: "ops-vault",
    });
    expect(live.resources.opsSteward.physicalId).toBe("agent-1");
    expect(live.resources.nightly.properties.teammate).toBe("ops-steward");
    expect(live.resources.nightly.properties.agent_id).toBeUndefined();
  });

  it("the scheduler's own run history never reaches a diff", async () => {
    const { live } = await drift(stewardDeclaration(), teamEstate());

    for (const key of ["next_run_at", "last_run_at", "last_conversation_id", "last_error", "id"]) {
      expect(Object.keys(live.resources.nightly.properties)).not.toContain(key);
    }
  });

  it("a schedule paused in the UI reports enabled: false and nothing else", async () => {
    const http = teamEstate({
      "GET /api/team/schedules": { status: 200, json: { data: [liveSchedule({ enabled: false })] } },
    });

    const { diff } = await drift(stewardDeclaration(), http);
    const schedule = diff.drifted.find((d) => d.name === "nightly");
    expect(schedule?.changes).toEqual([
      expect.objectContaining({ path: "enabled", kind: "changed", declared: true, live: false }),
    ]);
    expect(diff.drifted.map((d) => d.name)).toEqual(["nightly"]);
  });

  it("a cron someone edited in the UI reports as a changed property", async () => {
    const http = teamEstate({
      "GET /api/team/schedules": { status: 200, json: { data: [liveSchedule({ cron: "0 5 * * *" })] } },
    });

    const { diff } = await drift(stewardDeclaration(), http);
    const schedule = diff.drifted.find((d) => d.name === "nightly");
    expect(schedule?.changes).toContainEqual(
      expect.objectContaining({ path: "cron", kind: "changed", declared: "0 3 * * *", live: "0 5 * * *" }),
    );
  });

  it("a teammate rebound to another vault reports the vault by name", async () => {
    const otherVault = liveVault({ id: "vault-2", name: "escalation-vault" });
    const http = teamEstate({
      "GET /api/vaults": { status: 200, json: { data: [liveVault(), otherVault] } },
      "GET /api/team": {
        status: 200,
        json: {
          data: [
            liveTeammate({ conversation: { id: "conv-1", environment_id: "env-1", vault_id: "vault-2" } }),
          ],
        },
      },
    });

    const { diff } = await drift(stewardDeclaration(), http);
    const teammate = diff.drifted.find((d) => d.name === "opsSteward");
    expect(teammate?.changes).toContainEqual(
      expect.objectContaining({
        path: "vault",
        kind: "changed",
        declared: "ops-vault",
        live: "escalation-vault",
      }),
    );
  });

  it("a webhook fountain switched off surfaces its status; a healthy one stays silent", async () => {
    const clean = await drift(stewardDeclaration(), teamEstate());
    expect(clean.diff.drifted.find((d) => d.name === "hook")).toBeUndefined();

    const http = teamEstate({
      "GET /api/webhooks": {
        status: 200,
        json: {
          data: [
            liveWebhook({
              status: "disabled",
              disabled_reason: "too many failures",
              consecutive_failures: 12,
            }),
          ],
        },
      },
    });
    const { diff } = await drift(stewardDeclaration(), http);
    // Delivery health is the endpoint's own business; the switch is not.
    // Source never sets `status`, so fountain holds it (#2160): surfaced with
    // its live value, and never a change chant proposes to make.
    expect(diff.drifted.find((d) => d.name === "hook")).toBeUndefined();
    const hook = diff.unclaimed.find((d) => d.name === "hook");
    expect(hook?.fields).toEqual([
      expect.objectContaining({ path: "status", live: "disabled", source: "claimed-fields" }),
    ]);
  });

  it("a webhook url moved in the UI is a create plus an orphan, not a property change", async () => {
    const http = teamEstate({
      "GET /api/webhooks": {
        status: 200,
        json: { data: [liveWebhook({ url: "https://elsewhere.example.com/hooks" })] },
      },
    });

    // The url IS the identity, so the declared endpoint reads as absent rather
    // than as a changed field — the thin path reports that, and the deep read
    // deliberately says nothing rather than doubling the finding.
    const { live, diff } = await drift(stewardDeclaration(), http);
    expect(live.resources.hook).toBeUndefined();
    expect(diff.drifted.find((d) => d.name === "hook")).toBeUndefined();
  });

  it("a failed roster list marks only the schedules read-failed", async () => {
    const http = teamEstate({ "GET /api/team": { status: 500 } });
    const live = normalizeDeepObservation(
      await observeResourcesDeepFountain(options(stewardDeclaration()), http),
    );

    expect(live.unobserved.nightly.reason).toBe("read-failed");
    expect(live.unobserved.opsSteward.reason).toBe("read-failed");
    expect(live.resources.hook).toBeDefined();
  });
});
