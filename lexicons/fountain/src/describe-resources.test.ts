import { describe, expect, it } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { normalizeObservation } from "@intentius/chant/observation";
import { describeResources, type DescribeResourcesOptions } from "./describe-resources";
import type { FountainHttp } from "./op/activities/fountain-apply";

function entities(
  defs: Record<string, { entityType: string; props?: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> {
  return new Map(
    Object.entries(defs).map(([name, d]) => [name, { entityType: d.entityType, props: d.props ?? {} }]),
  );
}

function opts(
  ents: Map<string, { entityType: string; props: Record<string, unknown> }>,
  extra?: Partial<DescribeResourcesOptions>,
): DescribeResourcesOptions {
  return {
    environment: "local",
    buildOutput: "",
    entityNames: [...ents.keys()],
    entities: ents,
    ...extra,
  };
}

describe("list caching under the observer harness", () => {
  it("lists each kind once no matter how many entities of it are declared", async () => {
    const calls: string[] = [];
    const counting: FountainHttp = async (method, path) => {
      calls.push(`${method} ${path}`);
      return { status: 200, json: { data: [] } };
    };

    await describeResources(
      opts(
        entities({
          a: { entityType: "Fountain::V1::Environment" },
          b: { entityType: "Fountain::V1::Environment" },
          c: { entityType: "Fountain::V1::Environment" },
          d: { entityType: "Fountain::V1::Agent" },
        }),
      ),
      counting,
    );

    // The harness reads entities concurrently, so the cache must hold the
    // in-flight promise — caching the settled result would let three
    // simultaneous reads each fire their own list.
    expect(calls.filter((c) => c === "GET /api/environments")).toHaveLength(1);
    expect(calls.filter((c) => c === "GET /api/agents")).toHaveLength(1);
  });

  it("marks only the failed kind read-failed", async () => {
    const partial: FountainHttp = async (_method, path) =>
      path === "/api/agents" ? { status: 500, json: null } : { status: 200, json: { data: [] } };

    const result = await describeResources(
      opts(
        entities({
          env: { entityType: "Fountain::V1::Environment" },
          agent: { entityType: "Fountain::V1::Agent" },
        }),
      ),
      partial,
    );

    expect(result.unobserved?.agent?.reason).toBe("read-failed");
    // The environment was genuinely asked about and reported missing —
    // absent, not unobserved, so it stays eligible for `create`.
    expect(result.unobserved?.env).toBeUndefined();
    expect(result.resources?.env).toBeUndefined();
  });
});

function routedHttp(routes: Record<string, { status: number; json?: unknown }>): FountainHttp {
  return async (method, path) => {
    const hit = routes[`${method} ${path}`];
    if (!hit) throw new Error(`unrouted: ${method} ${path}`);
    return { status: hit.status, json: hit.json ?? null };
  };
}

const LIVE = routedHttp({
  "GET /api/environments": {
    status: 200,
    json: {
      data: [
        {
          id: "env-1",
          name: "concierge-env",
          metadata: { "managed-by": "chant" },
          updated_at: "2026-07-30T00:00:00Z",
        },
      ],
    },
  },
  "GET /api/vaults": { status: 200, json: { data: [] } },
  "GET /api/agents": {
    status: 200,
    json: {
      data: [
        { id: "agent-1", name: "researcher", metadata: {}, environment_id: "env-1" },
      ],
    },
  },
});

describe("fountain describeResources", () => {
  it("reports present resources with ownership and reference attributes", async () => {
    const ents = entities({
      conciergeEnv: { entityType: "Fountain::V1::Environment", props: { name: "concierge-env" } },
      researcher: { entityType: "Fountain::V1::Agent", props: { name: "researcher" } },
      gone: { entityType: "Fountain::V1::Vault", props: { name: "not-there" } },
    });

    const { resources, unobserved } = normalizeObservation(await describeResources(opts(ents), LIVE));

    expect(resources.conciergeEnv.ownership).toBe("owned");
    expect(resources.conciergeEnv.physicalId).toBe("env-1");
    expect(resources.researcher.ownership).toBe("foreign");
    expect(resources.researcher.attributes?.environment_id).toBe("env-1");
    // asked, absent → eligible for create, not unobserved
    expect(resources.gone).toBeUndefined();
    expect(unobserved.gone).toBeUndefined();
  });

  it("owned filter withholds foreign resources as filtered", async () => {
    const ents = entities({
      researcher: { entityType: "Fountain::V1::Agent", props: { name: "researcher" } },
    });
    const { resources, unobserved } = normalizeObservation(
      await describeResources(opts(ents, { owned: true }), LIVE),
    );
    expect(resources.researcher).toBeUndefined();
    expect(unobserved.researcher.reason).toBe("filtered");
  });

  it("a failed kind list marks only that kind read-failed", async () => {
    const ents = entities({
      e: { entityType: "Fountain::V1::Environment", props: { name: "concierge-env" } },
      a: { entityType: "Fountain::V1::Agent", props: { name: "researcher" } },
    });
    const http = routedHttp({
      "GET /api/environments": { status: 500 },
      "GET /api/agents": {
        status: 200,
        json: { data: [{ id: "agent-1", name: "researcher", metadata: {} }] },
      },
    });
    const { resources, unobserved } = normalizeObservation(await describeResources(opts(ents), http));
    expect(unobserved.e.reason).toBe("read-failed");
    expect(resources.a.status).toBe("PRESENT");
  });
});

describeObservationConformance({
  lexicon: "fountain",
  // No marker channel: every verdict must be `unknown` (#1348).
  ownershipChannel: undefined,
  scenarios: [
    {
      name: "mixed present/absent/foreign against a live listing",
      declared: ["conciergeEnv", "researcher", "gone"],
      expectPresent: ["conciergeEnv", "researcher"],
      expectAbsent: ["gone"],
      run: () =>
        describeResources(
          opts(
            entities({
              conciergeEnv: { entityType: "Fountain::V1::Environment", props: { name: "concierge-env" } },
              researcher: { entityType: "Fountain::V1::Agent", props: { name: "researcher" } },
              gone: { entityType: "Fountain::V1::Vault", props: { name: "not-there" } },
            }),
          ),
          LIVE,
        ),
    },
    {
      name: "no credentials — everything unobserved, nothing creates",
      declared: ["e"],
      expectUnobserved: ["e"],
      run: () => {
        const saved = process.env.FOUNTAIN_TOKEN;
        delete process.env.FOUNTAIN_TOKEN;
        const result = describeResources(
          opts(entities({ e: { entityType: "Fountain::V1::Environment" } })),
        );
        if (saved !== undefined) process.env.FOUNTAIN_TOKEN = saved;
        return result;
      },
    },
    {
      name: "unknown kind is unobserved, not absent",
      declared: ["weird"],
      expectUnobserved: ["weird"],
      run: () =>
        describeResources(
          opts(entities({ weird: { entityType: "Fountain::V1::Conversation" } })),
          LIVE,
        ),
    },
  ],
});

// ── The team-side kinds (#2128) ───────────────────────────────────────────
//
// A teammate keys on its roster name, a schedule on its teammate AND its name,
// a webhook on its url. None of the three carries chant's `managed-by` marker,
// so the first two inherit ownership from the agent behind them and the third
// has no verdict to give.

const OWNED_AGENT = { id: "agent-1", name: "steward", metadata: { "managed-by": "chant" } };
const FOREIGN_AGENT = { id: "agent-9", name: "someone-else", metadata: {} };

const TEAM = routedHttp({
  "GET /api/team": {
    status: 200,
    json: {
      data: [
        {
          agent_id: "agent-1",
          name: "ops-steward",
          agent: OWNED_AGENT,
          conversation: { id: "conv-1", environment_id: "env-1", vault_id: "vault-1" },
          presence: { state: "online", label: "Online" },
          unread: false,
        },
        {
          agent_id: "agent-9",
          name: "hand-built",
          agent: FOREIGN_AGENT,
          conversation: { id: "conv-9" },
          presence: { state: "asleep", label: "Asleep" },
          unread: false,
        },
      ],
    },
  },
  "GET /api/team/schedules": {
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
          updated_at: "2026-09-06T00:00:00Z",
        },
        {
          id: "sched-9",
          agent_id: "agent-9",
          name: "nightly-converge",
          cron: "0 4 * * *",
          prompt: "someone else's",
          one_off: false,
          enabled: true,
        },
      ],
    },
  },
  "GET /api/webhooks": {
    status: 200,
    json: {
      data: [
        {
          id: "wh-1",
          url: "https://ops.example.com/hooks/fountain",
          event_types: ["conversation.turn.done"],
          status: "active",
          consecutive_failures: 0,
          updated_at: "2026-09-06T00:00:00Z",
        },
      ],
    },
  },
});

describe("teammates, schedules and webhooks", () => {
  it("keys a teammate by its roster name and inherits the agent's ownership", async () => {
    const ents = entities({
      opsSteward: { entityType: "Fountain::V1::Teammate", props: { name: "ops-steward", agent: "steward" } },
      handBuilt: { entityType: "Fountain::V1::Teammate", props: { name: "hand-built", agent: "someone-else" } },
    });
    const { resources } = normalizeObservation(await describeResources(opts(ents), TEAM));

    expect(resources.opsSteward.ownership).toBe("owned");
    // A teammate has no id column — it IS an agent on the team channel.
    expect(resources.opsSteward.physicalId).toBe("agent-1");
    // The launch bindings live on the team conversation, and they are what
    // makes a rebound teammate classifiable as `replace`.
    expect(resources.opsSteward.attributes?.environment_id).toBe("env-1");
    expect(resources.opsSteward.attributes?.vault_id).toBe("vault-1");
    expect(resources.handBuilt.ownership).toBe("foreign");
  });

  it("keys a schedule by its teammate AND its name, so the same name under another teammate is absent", async () => {
    const ents = entities({
      nightly: {
        entityType: "Fountain::V1::Schedule",
        props: {
          name: "nightly-converge",
          teammate: "ops-steward",
          cron: "0 3 * * *",
          prompt: "chant lifecycle converge",
        },
      },
      elsewhere: {
        entityType: "Fountain::V1::Schedule",
        props: { name: "nightly-converge", teammate: "not-on-the-roster", cron: "0 3 * * *", prompt: "x" },
      },
    });
    const { resources, unobserved } = normalizeObservation(await describeResources(opts(ents), TEAM));

    expect(resources.nightly.physicalId).toBe("sched-1");
    expect(resources.nightly.attributes?.cron).toBe("0 3 * * *");
    // Inherited from agent-1, which carries the marker.
    expect(resources.nightly.ownership).toBe("owned");
    // Asked and answered no: the pair does not exist, even though a schedule of
    // that name does. Absent, not unobserved — it stays eligible for `create`.
    expect(resources.elsewhere).toBeUndefined();
    expect(unobserved.elsewhere).toBeUndefined();
  });

  it("reports a webhook unknown, because fountain stores no marker on one", async () => {
    const ents = entities({
      hook: { entityType: "Fountain::V1::Webhook", props: { url: "https://ops.example.com/hooks/fountain" } },
    });
    const { resources } = normalizeObservation(await describeResources(opts(ents), TEAM));

    expect(resources.hook.physicalId).toBe("wh-1");
    expect(resources.hook.attributes?.status).toBe("active");
    expect(resources.hook.ownership).toBe("unknown");
  });

  it("withholds a foreign webhook under --owned, naming the missing channel", async () => {
    const ents = entities({
      hook: { entityType: "Fountain::V1::Webhook", props: { url: "https://ops.example.com/hooks/fountain" } },
    });
    const { resources, unobserved } = normalizeObservation(
      await describeResources(opts(ents, { owned: true }), TEAM),
    );

    expect(resources.hook).toBeUndefined();
    expect(unobserved.hook.reason).toBe("filtered");
    expect(unobserved.hook.detail).toContain("no metadata on a webhook endpoint");
  });

  it("a declaration that resolves to no identity is read-failed, never absent", async () => {
    const ents = entities({
      orphan: { entityType: "Fountain::V1::Schedule", props: { name: "nightly", cron: "0 3 * * *", prompt: "x" } },
    });
    const { resources, unobserved } = normalizeObservation(await describeResources(opts(ents), TEAM));

    expect(resources.orphan).toBeUndefined();
    expect(unobserved.orphan.reason).toBe("read-failed");
  });

  it("lists the roster once even when teammates and schedules are both declared", async () => {
    const calls: string[] = [];
    const counting: FountainHttp = async (method, path) => {
      calls.push(`${method} ${path}`);
      return TEAM(method, path);
    };
    await describeResources(
      opts(
        entities({
          opsSteward: { entityType: "Fountain::V1::Teammate", props: { name: "ops-steward", agent: "steward" } },
          nightly: {
            entityType: "Fountain::V1::Schedule",
            props: { name: "nightly-converge", teammate: "ops-steward", cron: "0 3 * * *", prompt: "x" },
          },
        }),
      ),
      counting,
    );
    expect(calls.filter((c) => c === "GET /api/team")).toHaveLength(1);
  });
});
