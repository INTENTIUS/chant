import { describe, test, expect } from "vitest";
import {
  resolveEndpoint,
  parsePlan,
  isAppRequest,
  isMachineRequest,
  machineAppSegment,
  resolveApp,
  appNameFromRequest,
  isChantOwned,
  configEqual,
  isLeaseConflict,
  applyApp,
  applyMachine,
  destroyMachine,
  pruneMachines,
  acquireLease,
  withLease,
  waitForMachine,
  DEFAULT_FLAPS_BASE_URL,
  LEASE_NONCE_HEADER,
  type FlyHttp,
  type FlapsRequest,
  type ApplyCtx,
} from "./fly-apply";

const CTX: ApplyCtx = { base: "http://localhost:4280" };
const NO_WAIT = { intervalMs: 0, deadlineMs: 5_000 };

const OWNED_META = { "managed-by": "chant" };

function machineConfig(image: string): Record<string, unknown> {
  return { image, metadata: { ...OWNED_META } };
}

/** A scripted flaps machine as flaps would return it from list/get/create. */
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

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("resolveEndpoint (D3)", () => {
  test("explicit arg wins", () => {
    expect(resolveEndpoint({ endpoint: "http://localhost:4280/" }, {} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:4280",
    );
  });

  test("FLY_FLAPS_BASE_URL env when no arg", () => {
    expect(resolveEndpoint({}, { FLY_FLAPS_BASE_URL: "http://mf:4280" } as NodeJS.ProcessEnv)).toBe(
      "http://mf:4280",
    );
  });

  test("arg beats env", () => {
    expect(
      resolveEndpoint({ endpoint: "http://arg:1" }, { FLY_FLAPS_BASE_URL: "http://env:2" } as NodeJS.ProcessEnv),
    ).toBe("http://arg:1");
  });

  test("default is real Fly", () => {
    expect(resolveEndpoint({}, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_FLAPS_BASE_URL);
  });
});

describe("plan classification + app resolution", () => {
  test("isAppRequest / isMachineRequest", () => {
    expect(isAppRequest({ endpoint: "/v1/apps", method: "POST", body: {} })).toBe(true);
    expect(isMachineRequest({ endpoint: "/v1/apps", method: "POST", body: {} })).toBe(false);
    expect(isMachineRequest({ endpoint: "/v1/apps/foo/machines", method: "POST", body: {} })).toBe(true);
    expect(isAppRequest({ endpoint: "/v1/apps/foo/machines", method: "POST", body: {} })).toBe(false);
  });

  test("machineAppSegment + resolveApp with placeholder", () => {
    expect(machineAppSegment("/v1/apps/foo/machines")).toBe("foo");
    expect(machineAppSegment("/v1/apps/{app}/machines")).toBe("{app}");
    expect(resolveApp("foo", undefined)).toBe("foo");
    expect(resolveApp("{app}", "sole")).toBe("sole");
    expect(() => resolveApp("{app}", undefined)).toThrow(/placeholder/);
  });

  test("appNameFromRequest / parsePlan", () => {
    expect(appNameFromRequest({ endpoint: "/v1/apps", method: "POST", body: { app_name: "a" } })).toBe("a");
    expect(parsePlan('{"a":{"endpoint":"/v1/apps","method":"POST","body":{}}}')).toHaveProperty("a");
  });

  test("isChantOwned only for the exact marker", () => {
    expect(isChantOwned({ "managed-by": "chant" })).toBe(true);
    expect(isChantOwned({ "managed-by": "other" })).toBe(false);
    expect(isChantOwned(undefined)).toBe(false);
  });

  test("configEqual is order-insensitive, catches image drift", () => {
    expect(configEqual({ image: "a", metadata: { x: "1", y: "2" } }, { metadata: { y: "2", x: "1" }, image: "a" })).toBe(
      true,
    );
    expect(configEqual({ image: "a" }, { image: "b" })).toBe(false);
  });

  test("isLeaseConflict: 409 lease bodies only", () => {
    expect(isLeaseConflict(409, '{"code":"lease_currently_held"}')).toBe(true);
    expect(isLeaseConflict(409, '{"error":"machine is leased; supply the header"}')).toBe(true);
    expect(isLeaseConflict(409, '{"error":"app already exists"}')).toBe(false);
    expect(isLeaseConflict(200, "lease")).toBe(false);
  });
});

// ── applyApp ────────────────────────────────────────────────────────────────

describe("applyApp", () => {
  const req: FlapsRequest = { endpoint: "/v1/apps", method: "POST", body: { app_name: "demo", org_slug: "personal" } };

  test("absent (GET 404) → create (POST /v1/apps)", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const http: FlyHttp = async (method, url) => {
      calls.push({ method, url });
      return method === "GET" ? { status: 404, text: "" } : { status: 201, text: "{}" };
    };
    expect(await applyApp(CTX, req, http)).toEqual({ app: "demo", created: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  test("present (GET 200) → no create", async () => {
    const http: FlyHttp = async (method) => (method === "GET" ? { status: 200, text: "{}" } : { status: 500, text: "" });
    expect(await applyApp(CTX, req, http)).toEqual({ app: "demo", created: false });
  });
});

// ── applyMachine ─────────────────────────────────────────────────────────────

describe("applyMachine create → wait", () => {
  test("create posts, then waits on the new instance_id", async () => {
    const waits: string[] = [];
    const http: FlyHttp = async (method, url) => {
      if (method === "GET" && url.endsWith("/machines")) return { status: 200, text: "[]" }; // list: none
      if (method === "POST" && url.endsWith("/machines")) {
        return { status: 200, text: JSON.stringify({ id: "m1", name: "web", state: "creating", instance_id: "NEW1", config: machineConfig("img:1") }) };
      }
      if (method === "GET" && url.includes("/wait")) {
        waits.push(url);
        return { status: 200, text: JSON.stringify({ ok: true }) };
      }
      return { status: 500, text: url };
    };
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/machines", method: "POST", body: { name: "web", config: machineConfig("img:1") } };
    const res = await applyMachine(CTX, "demo", "web-entity", req, http, undefined, NO_WAIT);
    expect(res).toEqual({ action: "created", id: "m1", name: "web" });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain("state=started");
    expect(waits[0]).toContain("version=NEW1");
  });

  test("re-apply with an unchanged config is a no-op (no POST, no wait)", async () => {
    const methods: string[] = [];
    const http: FlyHttp = async (method, url) => {
      methods.push(`${method} ${url.includes("/wait") ? "wait" : url.endsWith("/machines") ? "machines" : "other"}`);
      if (method === "GET" && url.endsWith("/machines")) {
        return { status: 200, text: JSON.stringify([liveMachine("web", "img:1")]) };
      }
      return { status: 500, text: "" };
    };
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/machines", method: "POST", body: { name: "web", config: machineConfig("img:1") } };
    const res = await applyMachine(CTX, "demo", "web", req, http, undefined, NO_WAIT);
    expect(res).toEqual({ action: "noop", id: "m-web", name: "web" });
    expect(methods).toEqual(["GET machines"]); // list only
  });

  test("image change → lease → update → wait on the NEW version", async () => {
    const seen: string[] = [];
    const nonces: string[] = [];
    const http: FlyHttp = async (method, url, _body, headers) => {
      if (method === "GET" && url.endsWith("/machines")) {
        return { status: 200, text: JSON.stringify([liveMachine("web", "img:1", { instance_id: "OLD" })]) };
      }
      if (method === "POST" && url.endsWith("/lease")) {
        return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: "N1" } }) };
      }
      if (method === "POST" && /\/machines\/m-web$/.test(url)) {
        seen.push("update");
        nonces.push(headers?.[LEASE_NONCE_HEADER] ?? "");
        return { status: 200, text: JSON.stringify({ id: "m-web", name: "web", state: "replacing", instance_id: "NEW2", config: machineConfig("img:2") }) };
      }
      if (method === "DELETE" && url.endsWith("/lease")) return { status: 200, text: "{}" };
      if (method === "GET" && url.includes("/wait")) {
        seen.push(url.includes("version=NEW2") ? "wait-new" : "wait-old");
        return { status: 200, text: JSON.stringify({ ok: true }) };
      }
      return { status: 500, text: url };
    };
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/machines", method: "POST", body: { name: "web", config: machineConfig("img:2") } };
    const res = await applyMachine(CTX, "demo", "web", req, http, undefined, NO_WAIT);
    expect(res).toEqual({ action: "updated", id: "m-web", name: "web" });
    expect(seen).toEqual(["update", "wait-new"]);
    expect(nonces).toEqual(["N1"]);
  });
});

// ── lease-conflict retry (the crown-jewel path) ──────────────────────────────

describe("lease-conflict retry", () => {
  test("mutation 409 (stale nonce) → re-acquire fresh nonce → retry succeeds", async () => {
    // Scripted flaps: acquire yields N1 then N2; the first update (nonce N1)
    // 409s as leased, the second (nonce N2) succeeds.
    const acquired = ["N1", "N2"];
    let acquireIdx = 0;
    const updateNonces: string[] = [];
    const http: FlyHttp = async (method, url, _body, headers) => {
      if (method === "GET" && url.endsWith("/machines")) {
        return { status: 200, text: JSON.stringify([liveMachine("web", "img:1")]) };
      }
      if (method === "POST" && url.endsWith("/lease")) {
        return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: acquired[acquireIdx++] } }) };
      }
      if (method === "POST" && /\/machines\/m-web$/.test(url)) {
        const nonce = headers?.[LEASE_NONCE_HEADER] ?? "";
        updateNonces.push(nonce);
        if (nonce === "N1") {
          return { status: 409, text: JSON.stringify({ error: "machine is leased; supply the fly-machine-lease-nonce header", status: 409 }) };
        }
        return { status: 200, text: JSON.stringify({ id: "m-web", name: "web", state: "replacing", instance_id: "NEW9", config: machineConfig("img:2") }) };
      }
      if (method === "DELETE" && url.endsWith("/lease")) return { status: 200, text: "{}" };
      if (method === "GET" && url.includes("/wait")) return { status: 200, text: JSON.stringify({ ok: true }) };
      return { status: 500, text: url };
    };
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/machines", method: "POST", body: { name: "web", config: machineConfig("img:2") } };
    const res = await applyMachine(CTX, "demo", "web", req, http, undefined, NO_WAIT);
    expect(res.action).toBe("updated");
    // Each attempt carried the nonce it acquired: stale N1 first, fresh N2 on retry.
    expect(updateNonces).toEqual(["N1", "N2"]);
    expect(acquireIdx).toBe(2); // acquired twice
  });

  test("acquireLease retries once past a lease_currently_held 409", async () => {
    let n = 0;
    const http: FlyHttp = async () => {
      n++;
      if (n === 1) {
        return { status: 409, text: JSON.stringify({ status: "error", code: "lease_currently_held", message: "machine lease currently held" }) };
      }
      return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: "FRESH" } }) };
    };
    expect(await acquireLease(CTX, "demo", "m1", http)).toBe("FRESH");
    expect(n).toBe(2);
  });

  test("withLease releases the last-acquired nonce", async () => {
    let released = "";
    const http: FlyHttp = async (method, url, _body, headers) => {
      if (method === "POST" && url.endsWith("/lease")) return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: "NON" } }) };
      if (method === "DELETE" && url.endsWith("/lease")) {
        released = headers?.[LEASE_NONCE_HEADER] ?? "";
        return { status: 200, text: "{}" };
      }
      return { status: 200, text: "{}" };
    };
    await withLease(CTX, "demo", "m1", http, undefined, async (nonce) => {
      expect(nonce).toBe("NON");
      return { status: 200, text: "{}" };
    });
    expect(released).toBe("NON");
  });
});

// ── owned-only prune (D2) ─────────────────────────────────────────────────────

describe("owned-only prune", () => {
  test("unmarked machine survives; owned-but-undeclared is destroyed", async () => {
    const destroyed: string[] = [];
    const http: FlyHttp = async (method, url) => {
      if (method === "GET" && url.endsWith("/machines")) {
        return {
          status: 200,
          text: JSON.stringify([
            liveMachine("web", "img:1", { id: "m-web" }), // owned + declared → keep
            liveMachine("orphan", "img:1", { id: "m-orphan" }), // owned + not declared → destroy
            liveMachine("legacy", "img:1", { id: "m-legacy", owned: false }), // unmarked → never touch
          ]),
        };
      }
      if (method === "POST" && url.endsWith("/lease")) return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: "N" } }) };
      if (method === "DELETE" && /\/machines\/[^/]+$/.test(url)) {
        destroyed.push(url.split("/").pop() ?? "");
        return { status: 200, text: "{}" };
      }
      if (method === "DELETE" && url.endsWith("/lease")) return { status: 200, text: "{}" };
      if (method === "GET" && url.includes("/wait")) return { status: 200, text: JSON.stringify({ ok: true }) };
      return { status: 500, text: url };
    };
    const pruned = await pruneMachines(CTX, "demo", new Set(["web"]), http, undefined, NO_WAIT);
    expect(pruned).toEqual([{ app: "demo", name: "orphan", id: "m-orphan" }]);
    expect(destroyed).toEqual(["m-orphan"]); // legacy (unmarked) never destroyed
  });
});

// ── destroyMachine + waitForMachine ──────────────────────────────────────────

describe("destroy + wait", () => {
  test("destroy leases, deletes, then waits for destroyed", async () => {
    const order: string[] = [];
    const http: FlyHttp = async (method, url) => {
      if (method === "POST" && url.endsWith("/lease")) { order.push("lease"); return { status: 200, text: JSON.stringify({ status: "success", data: { nonce: "N" } }) }; }
      if (method === "DELETE" && /\/machines\/m1$/.test(url)) { order.push("destroy"); return { status: 200, text: "{}" }; }
      if (method === "DELETE" && url.endsWith("/lease")) { order.push("release"); return { status: 200, text: "{}" }; }
      if (method === "GET" && url.includes("/wait")) { order.push("wait"); expect(url).toContain("state=destroyed"); return { status: 200, text: JSON.stringify({ ok: true }) }; }
      return { status: 500, text: url };
    };
    await destroyMachine(CTX, "demo", "m1", http, undefined, NO_WAIT);
    expect(order).toEqual(["lease", "destroy", "release", "wait"]);
  });

  test("waitForMachine re-polls past a 408 timeout", async () => {
    let n = 0;
    const http: FlyHttp = async () => {
      n++;
      return n < 2 ? { status: 408, text: "timeout" } : { status: 200, text: JSON.stringify({ ok: true }) };
    };
    await waitForMachine(CTX, "demo", "m1", "INST", http, undefined, { intervalMs: 0, deadlineMs: 5_000 });
    expect(n).toBe(2);
  });
});
