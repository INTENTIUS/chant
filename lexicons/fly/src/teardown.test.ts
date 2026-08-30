/**
 * Env teardown over a scripted flaps (chant #1222) — the fly halves of the
 * teardownOwned / executeTeardown capability pair, mirroring the injected-HTTP
 * style of fly-apply.test.ts and describe-resources.test.ts: a stateful fake
 * answers app/machine reads and records mutations, so the lease → destroy →
 * wait path and the app-boundary rules run for real.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { teardownOwned, executeTeardown } from "./teardown";
import type { FlyHttp } from "./op/activities/fly-apply";

const ENDPOINT = "http://localhost:4280";
const MARKER = { stack: "shop", env: "dev" };
const NO_WAIT = { intervalMs: 0, deadlineMs: 5_000 };

const savedOrg = { FLY_ORG: process.env.FLY_ORG, FLY_ORG_SLUG: process.env.FLY_ORG_SLUG };
beforeEach(() => {
  delete process.env.FLY_ORG;
  delete process.env.FLY_ORG_SLUG;
});
afterEach(() => {
  if (savedOrg.FLY_ORG === undefined) delete process.env.FLY_ORG; else process.env.FLY_ORG = savedOrg.FLY_ORG;
  if (savedOrg.FLY_ORG_SLUG === undefined) delete process.env.FLY_ORG_SLUG; else process.env.FLY_ORG_SLUG = savedOrg.FLY_ORG_SLUG;
});

type FakeMachine = { id: string; name: string; state: string; instance_id: string; config?: { metadata?: Record<string, string> } };

function machine(
  name: string,
  metadata: Record<string, string> | undefined,
  extra: Partial<FakeMachine> = {},
): FakeMachine {
  return {
    id: extra.id ?? `m-${name}`,
    name,
    state: extra.state ?? "started",
    instance_id: "INST0",
    config: { ...(metadata !== undefined ? { metadata } : {}) },
  };
}

const MINE = { "managed-by": "chant", "chant-stack": "shop", "chant-env": "dev" };
const OTHER_ENV = { "managed-by": "chant", "chant-stack": "shop", "chant-env": "prod" };
const OTHER_STACK = { "managed-by": "chant", "chant-stack": "blog", "chant-env": "dev" };

/**
 * A stateful scripted flaps: `apps` maps app name to its machines; deletes
 * mutate the state, so the app-boundary re-check after a destroy sees what a
 * real flaps would. An app mapped to the string "boom" fails its machine list.
 */
function scriptedFlaps(apps: Record<string, FakeMachine[] | "boom">): { http: FlyHttp; log: string[] } {
  const log: string[] = [];
  const http: FlyHttp = async (method, url) => {
    log.push(`${method} ${url}`);
    if (method === "GET" && /\/v1\/apps(\?[^/]*)?$/.test(url)) {
      return { status: 200, text: JSON.stringify({ apps: Object.keys(apps).map((name) => ({ name })) }) };
    }
    if (/\/machines\/[^/]+\/lease$/.test(url)) {
      return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: "N" } }) };
    }
    if (method === "GET" && /\/machines\/[^/]+\/wait\?/.test(url)) {
      return { status: 200, text: JSON.stringify({ ok: true }) };
    }
    let m = url.match(/\/v1\/apps\/([^/?]+)\/machines\/([^/?]+)$/);
    if (m && method === "DELETE") {
      const held = apps[m[1]];
      if (Array.isArray(held)) apps[m[1]] = held.filter((mm) => mm.id !== m![2]);
      return { status: 200, text: "{}" };
    }
    m = url.match(/\/v1\/apps\/([^/?]+)\/machines$/);
    if (m && method === "GET") {
      const held = apps[m[1]];
      if (held === "boom") return { status: 500, text: "machine list exploded" };
      if (held === undefined) return { status: 404, text: "no such app" };
      return { status: 200, text: JSON.stringify(held) };
    }
    m = url.match(/\/v1\/apps\/([^/?]+)$/);
    if (m && method === "DELETE") {
      if (apps[m[1]] === undefined) return { status: 404, text: "gone" };
      delete apps[m[1]];
      return { status: 200, text: "{}" };
    }
    return { status: 500, text: `unscripted: ${method} ${url}` };
  };
  return { http, log };
}

describe("teardownOwned — marker machines + the app boundary (#743)", () => {
  test("machines carrying this stack+env are candidates; an all-matching app is one too", async () => {
    const { http } = scriptedFlaps({
      mine: [machine("web", MINE), machine("worker", MINE)],
      mixed: [machine("ok", MINE), machine("foreign", { role: "db" })],
    });
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, { http, endpoint: ENDPOINT });

    expect(enumeration.candidates.map((c) => `${c.type === "Fly::Machines::App" ? "app" : "machine"}:${c.name}`).sort()).toEqual([
      "app:mine",
      "machine:mine/web",
      "machine:mine/worker",
      "machine:mixed/ok",
    ]);
    for (const candidate of enumeration.candidates) {
      expect(candidate.marker).toEqual(MARKER);
    }
    const web = enumeration.candidates.find((c) => c.name === "mine/web")!;
    expect(web.physicalId).toBe("m-web");
    expect(enumeration.holes ?? []).toEqual([]);
  });

  test("another env's and another stack's machines are never candidates", async () => {
    const { http } = scriptedFlaps({
      mine: [machine("web", MINE), machine("prod-twin", OTHER_ENV), machine("their", OTHER_STACK)],
    });
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, { http, endpoint: ENDPOINT });
    // Only the matching machine — and no whole-app candidate, because the app
    // hosts machines outside the requested identity.
    expect(enumeration.candidates.map((c) => c.name)).toEqual(["mine/web"]);
  });

  test("terminal machines are ignored, and do not block the app boundary", async () => {
    const { http } = scriptedFlaps({
      mine: [machine("web", MINE), machine("old", { role: "db" }, { state: "destroyed" })],
    });
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, { http, endpoint: ENDPOINT });
    expect(enumeration.candidates.map((c) => c.name).sort()).toEqual(["mine", "mine/web"]);
  });

  test("an app whose machine list fails is a hole, and the others still enumerate (#1089)", async () => {
    const { http } = scriptedFlaps({
      broken: "boom",
      mine: [machine("web", MINE)],
    });
    const enumeration = await teardownOwned({ environment: "dev", marker: MARKER }, { http, endpoint: ENDPOINT });
    expect(enumeration.candidates.map((c) => c.name).sort()).toEqual(["mine", "mine/web"]);
    expect(enumeration.holes).toHaveLength(1);
    expect(enumeration.holes![0].name).toBe("broken");
    expect(enumeration.holes![0].reason).toBe("read-failed");
  });

  test("FLY_ORG is passed as org_slug on the app list (real flaps requires it)", async () => {
    process.env.FLY_ORG = "acme";
    const { http, log } = scriptedFlaps({});
    await teardownOwned({ environment: "dev", marker: MARKER }, { http, endpoint: ENDPOINT });
    expect(log[0]).toBe(`GET ${ENDPOINT}/v1/apps?org_slug=acme`);
  });
});

describe("executeTeardown — machines first, apps last", () => {
  test("destroys the machines (lease → destroy → wait), then deletes the app", async () => {
    const state: Record<string, FakeMachine[] | "boom"> = {
      mine: [machine("web", MINE), machine("worker", MINE)],
    };
    const { http, log } = scriptedFlaps(state);
    const execution = await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [
          { name: "mine", type: "Fly::Machines::App", marker: MARKER },
          { name: "mine/web", type: "Fly::Machines::Machine", physicalId: "m-web", marker: MARKER },
          { name: "mine/worker", type: "Fly::Machines::Machine", physicalId: "m-worker", marker: MARKER },
        ],
      },
      { http, endpoint: ENDPOINT, wait: NO_WAIT },
    );

    expect(execution.outcomes.map((o) => ({ name: o.name, outcome: o.outcome }))).toEqual([
      { name: "mine/web", outcome: "deleted" },
      { name: "mine/worker", outcome: "deleted" },
      { name: "mine", outcome: "deleted" },
    ]);
    const deletes = log.filter((l) => l.startsWith("DELETE") && !l.endsWith("/lease"));
    expect(deletes).toEqual([
      `DELETE ${ENDPOINT}/v1/apps/mine/machines/m-web`,
      `DELETE ${ENDPOINT}/v1/apps/mine/machines/m-worker`,
      `DELETE ${ENDPOINT}/v1/apps/mine`,
    ]);
    expect(state.mine).toBeUndefined();
  });

  test("an app hosting a machine outside the requested identity is never deleted whole", async () => {
    const { http, log } = scriptedFlaps({
      mine: [machine("foreign", { role: "db" })],
    });
    const execution = await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [{ name: "mine", type: "Fly::Machines::App", marker: MARKER }],
      },
      { http, endpoint: ENDPOINT, wait: NO_WAIT },
    );
    expect(execution.outcomes[0].outcome).toBe("not-prunable");
    expect(execution.outcomes[0].detail).toContain("outside the requested identity");
    expect(log.filter((l) => l.startsWith("DELETE"))).toEqual([]);
  });

  test("an already-absent machine and an already-absent app are deleted (idempotent)", async () => {
    const { http } = scriptedFlaps({ mine: [] });
    const execution = await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [
          { name: "mine/web", type: "Fly::Machines::Machine", physicalId: "m-web", marker: MARKER },
          { name: "gone-app", type: "Fly::Machines::App", marker: MARKER },
        ],
      },
      { http, endpoint: ENDPOINT, wait: NO_WAIT },
    );
    expect(execution.outcomes.map((o) => ({ name: o.name, outcome: o.outcome, detail: o.detail }))).toEqual([
      { name: "mine/web", outcome: "deleted", detail: "already absent" },
      { name: "gone-app", outcome: "deleted", detail: "already absent" },
    ]);
  });

  test("a machine re-stamped since planning is not-prunable, never destroyed", async () => {
    const { http, log } = scriptedFlaps({
      mine: [machine("web", OTHER_STACK)],
    });
    const execution = await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [{ name: "mine/web", type: "Fly::Machines::Machine", physicalId: "m-web", marker: MARKER }],
      },
      { http, endpoint: ENDPOINT, wait: NO_WAIT },
    );
    expect(execution.outcomes[0].outcome).toBe("not-prunable");
    expect(log.filter((l) => l.startsWith("DELETE"))).toEqual([]);
  });

  test("a refused delete is a failed outcome carrying the server's message", async () => {
    const inner = scriptedFlaps({ mine: [machine("web", MINE)] });
    const http: FlyHttp = async (method, url, body, headers, signal) => {
      if (method === "DELETE" && /\/machines\/m-web$/.test(url)) {
        return { status: 500, text: "flaps had a bad day" };
      }
      return inner.http(method, url, body, headers, signal);
    };
    const execution = await executeTeardown(
      {
        environment: "dev",
        marker: MARKER,
        candidates: [{ name: "mine/web", type: "Fly::Machines::Machine", physicalId: "m-web", marker: MARKER }],
      },
      { http, endpoint: ENDPOINT, wait: NO_WAIT },
    );
    expect(execution.outcomes[0].outcome).toBe("failed");
    expect(execution.outcomes[0].detail).toContain("flaps had a bad day");
  });
});
