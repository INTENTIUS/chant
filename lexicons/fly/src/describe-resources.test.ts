import { describe, test, expect } from "vitest";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { describeResources, flyPlan } from "./describe-resources";
import type { FlyHttp } from "./op/activities/fly-apply";
import { FLY_METADATA_OWNERSHIP_KEYS } from "./ownership";

// Injected-HTTP unit tests, mirroring fly-apply.test.ts: a scripted flaps answers
// list/get reads, and describeResources maps them to ResourceMetadata with the
// right ownership verdict.

const ENDPOINT = "http://localhost:4280";
const APP = "demo";
const OWNED_META = { "managed-by": "chant" };

/** A scripted flaps machine as list/get would return it. */
function liveMachine(
  name: string,
  image: string,
  extra: Partial<{ id: string; state: string; instance_id: string; owned: boolean }> = {},
): Record<string, unknown> {
  const metadata = extra.owned === false ? { role: "db" } : { ...OWNED_META };
  return {
    id: extra.id ?? `m-${name}`,
    name,
    state: extra.state ?? "started",
    instance_id: extra.instance_id ?? "INST0",
    config: { image, metadata },
  };
}

/** entities map keyed by declared entity name → its entityType (props unused here). */
function entities(pairs: Array<[string, string]>): Map<string, { entityType: string; props: Record<string, unknown> }> {
  return new Map(pairs.map(([name, entityType]) => [name, { entityType, props: {} }]));
}

/**
 * A fake flaps that serves an app GET, a machine list, and empty breadth lists.
 * `machines` is the live machine array returned for the app.
 */
function fakeHttp(machines: Array<Record<string, unknown>>): FlyHttp {
  return async (method, url) => {
    if (method === "GET" && /\/v1\/apps\/[^/]+$/.test(url)) return { status: 200, text: "{}" }; // app exists
    if (method === "GET" && url.endsWith("/machines")) return { status: 200, text: JSON.stringify(machines) };
    if (method === "GET" && url.endsWith("/volumes")) return { status: 200, text: "[]" };
    if (method === "GET" && url.endsWith("/ip_assignments")) return { status: 200, text: JSON.stringify({ ips: [] }) };
    if (method === "GET" && url.endsWith("/certificates")) return { status: 200, text: JSON.stringify({ certificates: [] }) };
    return { status: 404, text: "" };
  };
}

const PLAN = JSON.stringify({
  app: { endpoint: "/v1/apps", method: "POST", body: { app_name: APP, org_slug: "personal" } },
  web: {
    endpoint: `/v1/apps/${APP}/machines`,
    method: "POST",
    body: { name: "web", config: { image: "nginx:1", metadata: { ...OWNED_META } } },
  },
});

const ENTS = entities([
  ["app", "Fly::Machines::App"],
  ["web", "Fly::Machines::Machine"],
]);

describe("describeResources: live machines → ResourceMetadata verdicts", () => {
  test("a managed-by:chant machine is owned; an unmarked one is foreign", async () => {
    const http = fakeHttp([
      liveMachine("web", "nginx:1", { id: "m-web" }), // declared + owned
      liveMachine("legacy", "redis:1", { id: "m-legacy", owned: false }), // orphan + unmarked
    ]);
    const res = await describeResources(
      { environment: "prod", buildOutput: PLAN, entityNames: ["app", "web"], entities: ENTS, endpoint: ENDPOINT },
      http,
    );

    // Declared machine keyed by its entity name; orphan keyed by its live name.
    expect(res.resources.web.type).toBe("Fly::Machines::Machine");
    expect(res.resources.web.ownership).toBe("owned");
    expect(res.resources.web.physicalId).toBe("m-web");
    expect(res.resources.web.status).toBe("started");
    expect((res.resources.web.attributes as { config?: unknown }).config).toEqual({
      image: "nginx:1",
      metadata: { "managed-by": "chant" },
    });

    expect(res.resources.legacy.ownership).toBe("foreign");
    expect(res.resources.legacy.type).toBe("Fly::Machines::Machine");

    // App surfaced as owned (app-boundary: it carries an owned machine).
    expect(res.resources.app.type).toBe("Fly::Machines::App");
    expect(res.resources.app.ownership).toBe("owned");
  });

  test("the owned filter drops foreign entries", async () => {
    const http = fakeHttp([
      liveMachine("web", "nginx:1", { id: "m-web" }),
      liveMachine("legacy", "redis:1", { id: "m-legacy", owned: false }),
    ]);
    const res = await describeResources(
      { environment: "prod", buildOutput: PLAN, entityNames: ["app", "web"], entities: ENTS, owned: true, endpoint: ENDPOINT },
      http,
    );
    expect(res.resources.web?.ownership).toBe("owned");
    expect(res.resources.legacy).toBeUndefined(); // foreign machine filtered out
  });

  test("terminal machines (destroyed/destroying) are not reported live", async () => {
    const http = fakeHttp([
      liveMachine("web", "nginx:1"),
      liveMachine("gone", "nginx:1", { state: "destroyed" }),
    ]);
    const res = await describeResources(
      { environment: "prod", buildOutput: PLAN, entityNames: ["app", "web"], entities: ENTS, endpoint: ENDPOINT },
      http,
    );
    expect(res.resources.web).toBeDefined();
    expect(res.resources.gone).toBeUndefined();
  });

  test("empty build output returns nothing", async () => {
    const res = await describeResources(
      { environment: "prod", buildOutput: "", entityNames: [], entities: new Map(), endpoint: ENDPOINT },
      fakeHttp([]),
    );
    expect(res.resources).toEqual({});
  });

  test("with no readable plan, declared entities are unobserved rather than absent (#1089)", async () => {
    const res = await describeResources(
      { environment: "prod", buildOutput: "", entityNames: ["web"], entities: ENTS, endpoint: ENDPOINT },
      fakeHttp([]),
    );
    expect(res.resources).toEqual({});
    expect(res.unobserved?.web?.reason).toBe("read-failed");
    expect(res.unobserved?.app?.reason).toBe("read-failed");
  });

  test("the owned filter records a withheld declared machine as `filtered`, not absent (#1089)", async () => {
    const http = fakeHttp([liveMachine("web", "nginx:1", { id: "m-web", owned: false })]);
    const res = await describeResources(
      { environment: "prod", buildOutput: PLAN, entityNames: ["app", "web"], entities: ENTS, owned: true, endpoint: ENDPOINT },
      http,
    );
    expect(res.resources.web).toBeUndefined();
    expect(res.unobserved?.web?.reason).toBe("filtered");
  });
});

describe("flyPlan: declared-vs-live change set (create/noop/delete/adopt)", () => {
  test("classifies each action; an unmarked machine is never a delete", async () => {
    // Declared: app, web (live+equal → noop), web2 (not live → create).
    const plan = JSON.stringify({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: APP, org_slug: "personal" } },
      web: {
        endpoint: `/v1/apps/${APP}/machines`,
        method: "POST",
        body: { name: "web", config: { image: "nginx:1", metadata: { ...OWNED_META } } },
      },
      web2: {
        endpoint: `/v1/apps/${APP}/machines`,
        method: "POST",
        body: { name: "web2", config: { image: "nginx:1", metadata: { ...OWNED_META } } },
      },
    });
    const ents = entities([
      ["app", "Fly::Machines::App"],
      ["web", "Fly::Machines::Machine"],
      ["web2", "Fly::Machines::Machine"],
    ]);
    const http = fakeHttp([
      liveMachine("web", "nginx:1"), // declared + owned + config equal → noop
      liveMachine("orphan", "nginx:1"), // owned + undeclared → delete
      liveMachine("legacy", "redis:1", { owned: false }), // unmarked + undeclared → adopt
    ]);

    const { changeSet } = await flyPlan(
      { environment: "prod", buildOutput: plan, entityNames: [...ents.keys()], entities: ents, endpoint: ENDPOINT },
      http,
    );
    const action = (name: string) => changeSet.entries.find((e) => e.name === name)?.action;

    expect(action("web")).toBe("noop");
    expect(action("web2")).toBe("create");
    expect(action("orphan")).toBe("delete");
    expect(action("legacy")).toBe("adopt"); // unmarked → adopt, never delete
    // No entry, anywhere, deletes an unmarked machine.
    expect(changeSet.entries.filter((e) => e.action === "delete").map((e) => e.name)).toEqual(["orphan"]);
  });

  test("config drift on a declared machine → update (configEqual, matching apply)", async () => {
    const plan = JSON.stringify({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: APP } },
      web: {
        endpoint: `/v1/apps/${APP}/machines`,
        method: "POST",
        body: { name: "web", config: { image: "nginx:2", metadata: { ...OWNED_META } } },
      },
    });
    const ents = entities([
      ["app", "Fly::Machines::App"],
      ["web", "Fly::Machines::Machine"],
    ]);
    const http = fakeHttp([liveMachine("web", "nginx:1")]); // live image nginx:1 ≠ declared nginx:2
    const { changeSet } = await flyPlan(
      { environment: "prod", buildOutput: plan, entityNames: [...ents.keys()], entities: ents, endpoint: ENDPOINT },
      http,
    );
    expect(changeSet.entries.find((e) => e.name === "web")?.action).toBe("update");
  });

  test("an unreadable plan makes every declared entity unobserved, not a create (#1089)", async () => {
    const { changeSet } = await flyPlan(
      { environment: "prod", buildOutput: "not json", entityNames: [...ENTS.keys()], entities: ENTS, endpoint: ENDPOINT },
      fakeHttp([]),
    );
    expect(changeSet.entries.map((e) => e.action)).toEqual(["unobserved", "unobserved"]);
  });
});

// The shared conformance suite (#1089).
describeObservationConformance({
  lexicon: "fly",
  ownershipChannel: { keys: FLY_METADATA_OWNERSHIP_KEYS, reads: ["describeResources"] },
  scenarios: [
    {
      name: "a build output that is not a readable fly plan",
      declared: ["app", "web"],
      expectUnobserved: ["app", "web"],
      run: () =>
        describeResources(
          { environment: "prod", buildOutput: "{{ not json", entityNames: ["app", "web"], entities: ENTS, endpoint: ENDPOINT },
          fakeHttp([]),
        ),
    },
    {
      name: "the owned filter withholding a declared machine",
      declared: ["app", "web"],
      expectUnobserved: ["web"],
      run: () =>
        describeResources(
          {
            environment: "prod",
            buildOutput: PLAN,
            entityNames: ["app", "web"],
            entities: ENTS,
            owned: true,
            endpoint: ENDPOINT,
          },
          fakeHttp([liveMachine("web", "nginx:1", { owned: false })]),
        ),
    },
    {
      name: "a healthy read",
      declared: ["app", "web"],
      expectPresent: ["app", "web"],
      run: () =>
        describeResources(
          { environment: "prod", buildOutput: PLAN, entityNames: ["app", "web"], entities: ENTS, endpoint: ENDPOINT },
          fakeHttp([liveMachine("web", "nginx:1")]),
        ),
    },
  ],
});
