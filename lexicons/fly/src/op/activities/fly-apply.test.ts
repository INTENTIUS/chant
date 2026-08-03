import { describe, test, expect } from "vitest";
import { describeApplyConformance } from "@intentius/chant-test-utils";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEndpoint,
  parsePlan,
  isAppRequest,
  isMachineRequest,
  isVolumeRequest,
  isIpRequest,
  isCertRequest,
  isSecretRequest,
  resourceAppSegment,
  secretNameSegment,
  machineAppSegment,
  resolveApp,
  appNameFromRequest,
  isChantOwned,
  configEqual,
  isLeaseConflict,
  ipType,
  declaredIpType,
  applyApp,
  applyMachine,
  applyVolume,
  applyIp,
  applyCert,
  applySecret,
  destroyMachine,
  pruneMachines,
  pruneVolumes,
  pruneIps,
  pruneCerts,
  pruneSecrets,
  acquireLease,
  withLease,
  waitForMachine,
  flyApply,
  toApplyResult,
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

// ── #741 breadth: Volume + IPAddress + Certificate + Secret ───────────────────

describe("app-scoped resource classification + segments", () => {
  test("each kind is recognized by its endpoint", () => {
    const at = (endpoint: string): FlapsRequest => ({ endpoint, method: "POST", body: {} });
    expect(isVolumeRequest(at("/v1/apps/demo/volumes"))).toBe(true);
    expect(isIpRequest(at("/v1/apps/demo/ip_assignments"))).toBe(true);
    expect(isCertRequest(at("/v1/apps/demo/certificates"))).toBe(true);
    expect(isSecretRequest(at("/v1/apps/demo/secrets/db"))).toBe(true);
    // Cross-checks: a secret endpoint is not a machine/volume request.
    expect(isMachineRequest(at("/v1/apps/demo/secrets/db"))).toBe(false);
    expect(isVolumeRequest(at("/v1/apps/demo/machines"))).toBe(false);
  });

  test("resourceAppSegment / secretNameSegment", () => {
    expect(resourceAppSegment("/v1/apps/demo/volumes")).toBe("demo");
    expect(resourceAppSegment("/v1/apps/demo/secrets/db-password")).toBe("demo");
    expect(secretNameSegment("/v1/apps/demo/secrets/db-password")).toBe("db-password");
  });

  test("ipType / declaredIpType collapse to a stable family key", () => {
    expect(ipType(true, "66.241.125.1")).toBe("shared_v4");
    expect(ipType(false, "137.66.1.2")).toBe("v4");
    expect(ipType(false, "2604:1380:ab::1")).toBe("v6");
    expect(declaredIpType("shared_v4")).toBe("shared_v4");
    expect(declaredIpType("v6")).toBe("v6");
    expect(declaredIpType("private_v6")).toBe("v6");
    expect(declaredIpType("dedicated_v4")).toBe("v4");
  });
});

describe("applyVolume / applyIp / applyCert idempotency (drift handling)", () => {
  const volReq: FlapsRequest = { endpoint: "/v1/apps/demo/volumes", method: "POST", body: { name: "data", region: "iad", size_gb: 10 } };

  test("volume absent → create; present (by name) → no-op", async () => {
    let posted = 0;
    const empty: FlyHttp = async (method) => (method === "GET" ? { status: 200, text: "[]" } : ((posted++), { status: 200, text: "{}" }));
    expect(await applyVolume(CTX, "demo", "data", volReq, empty)).toEqual({ action: "created", name: "data" });
    expect(posted).toBe(1);

    const present: FlyHttp = async (method) =>
      method === "GET" ? { status: 200, text: JSON.stringify([{ id: "v1", name: "data" }]) } : { status: 500, text: "" };
    expect(await applyVolume(CTX, "demo", "data", volReq, present)).toEqual({ action: "noop", name: "data" });
  });

  test("ip absent type → assign; same declared family present → no-op", async () => {
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/ip_assignments", method: "POST", body: { type: "shared_v4", region: "iad", org_slug: "acme" } };
    let posted = 0;
    const empty: FlyHttp = async (method) => (method === "GET" ? { status: 200, text: JSON.stringify({ ips: [] }) } : ((posted++), { status: 200, text: "{}" }));
    expect(await applyIp(CTX, "demo", req, empty)).toEqual({ action: "created", type: "shared_v4" });
    expect(posted).toBe(1);

    const present: FlyHttp = async (method) =>
      method === "GET" ? { status: 200, text: JSON.stringify({ ips: [{ ip: "66.241.125.1", shared: true }] }) } : { status: 500, text: "" };
    expect(await applyIp(CTX, "demo", req, present)).toEqual({ action: "noop", type: "shared_v4" });
  });

  test("cert absent → create; present (by hostname) → no-op", async () => {
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/certificates", method: "POST", body: { hostname: "example.com" } };
    const present: FlyHttp = async (method) =>
      method === "GET" ? { status: 200, text: JSON.stringify({ certificates: [{ hostname: "example.com" }] }) } : { status: 500, text: "" };
    expect(await applyCert(CTX, "demo", req, present)).toEqual({ action: "noop", hostname: "example.com" });
  });
});

describe("secret is apply-only (D7): set, never read-diffed", () => {
  test("applySecret POSTs the value with no read-back GET", async () => {
    const calls: string[] = [];
    const http: FlyHttp = async (method, url) => {
      calls.push(`${method} ${url}`);
      return { status: 200, text: JSON.stringify({ name: "db", digest: "sha256:..." }) };
    };
    const req: FlapsRequest = { endpoint: "/v1/apps/demo/secrets/db", method: "POST", body: { value: "s3cret" }, applyOnly: true };
    expect(await applySecret(CTX, "demo", "db", req, http)).toEqual({ action: "set", name: "db" });
    // No GET — the digest-only read can't diff, so the secret never enters one.
    expect(calls).toEqual(["POST http://localhost:4280/v1/apps/demo/secrets/db"]);
  });
});

describe("app-scoped prune (D2) — metadata-less types prune wholesale", () => {
  test("pruneVolumes destroys an undeclared volume even with NO ownership marker", async () => {
    // Unlike a machine (which survives when unmarked), a metadata-less volume is
    // owned at the app boundary, so an undeclared one is pruned regardless.
    const deleted: string[] = [];
    const http: FlyHttp = async (method, url) => {
      if (method === "GET") return { status: 200, text: JSON.stringify([{ id: "v-data", name: "data" }, { id: "v-old", name: "old" }]) };
      if (method === "DELETE") { deleted.push(url.split("/").pop() ?? ""); return { status: 200, text: "{}" }; }
      return { status: 500, text: "" };
    };
    const pruned = await pruneVolumes(CTX, "demo", new Set(["data"]), http);
    expect(pruned).toEqual([{ app: "demo", name: "old", id: "v-old" }]);
    expect(deleted).toEqual(["v-old"]);
  });

  test("pruneIps releases IPs whose family is not declared", async () => {
    const deleted: string[] = [];
    const http: FlyHttp = async (method, url) => {
      if (method === "GET") return { status: 200, text: JSON.stringify({ ips: [{ ip: "66.241.125.1", shared: true }, { ip: "2604:1380:ab::1", shared: false }] }) };
      if (method === "DELETE") { deleted.push(url.split("/").pop() ?? ""); return { status: 200, text: "{}" }; }
      return { status: 500, text: "" };
    };
    const pruned = await pruneIps(CTX, "demo", new Set(["shared_v4"]), http);
    expect(pruned).toEqual([{ app: "demo", address: "2604:1380:ab::1" }]);
    expect(deleted).toEqual(["2604%3A1380%3Aab%3A%3A1"]); // v6 released, shared_v4 kept
  });

  test("pruneCerts and pruneSecrets drop undeclared entries by name", async () => {
    const certHttp: FlyHttp = async (method) =>
      method === "GET"
        ? { status: 200, text: JSON.stringify({ certificates: [{ hostname: "keep.com" }, { hostname: "drop.com" }] }) }
        : { status: 200, text: "{}" };
    expect(await pruneCerts(CTX, "demo", new Set(["keep.com"]), certHttp)).toEqual([{ app: "demo", hostname: "drop.com" }]);

    const secretHttp: FlyHttp = async (method) =>
      method === "GET"
        ? { status: 200, text: JSON.stringify({ secrets: [{ name: "keep" }, { name: "drop" }] }) }
        : { status: 200, text: "{}" };
    expect(await pruneSecrets(CTX, "demo", new Set(["keep"]), secretHttp)).toEqual([{ app: "demo", name: "drop" }]);
  });
});

describe("flyApply orders volumes before the machines that mount them", () => {
  test("a mounting machine finds its volume already created", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "fly-order-"));
    try {
      const plan = {
        app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "demo" } },
        web: {
          endpoint: "/v1/apps/demo/machines",
          method: "POST",
          body: { name: "web", config: { image: "img:1", mounts: [{ volume: "data", path: "/data" }], metadata: { "managed-by": "chant" } } },
        },
        data: { endpoint: "/v1/apps/demo/volumes", method: "POST", body: { name: "data", region: "iad", size_gb: 10 } },
      };
      const planPath = join(tmp, "plan.json");
      writeFileSync(planPath, JSON.stringify(plan));

      const order: string[] = [];
      const http: FlyHttp = async (method, url) => {
        if (method === "GET" && /\/apps\/demo$/.test(url)) return { status: 404, text: "" };
        if (method === "POST" && /\/apps$/.test(url)) { order.push("app"); return { status: 200, text: "{}" }; }
        if (method === "GET" && url.endsWith("/volumes")) return { status: 200, text: "[]" };
        if (method === "POST" && url.endsWith("/volumes")) { order.push("volume"); return { status: 200, text: JSON.stringify({ id: "v1", name: "data" }) }; }
        if (method === "GET" && url.endsWith("/machines")) return { status: 200, text: "[]" };
        if (method === "POST" && url.endsWith("/machines")) { order.push("machine"); return { status: 200, text: JSON.stringify({ id: "m1", name: "web", state: "created", instance_id: "I1", config: { image: "img:1" } }) }; }
        if (method === "GET" && url.includes("/wait")) return { status: 200, text: JSON.stringify({ ok: true }) };
        return { status: 500, text: url };
      };

      const out = await flyApply({ planPath, endpoint: "http://localhost:4280", wait: { intervalMs: 0, deadlineMs: 5_000 } }, undefined, http);
      expect(out.volumes).toEqual([{ app: "demo", name: "data", action: "created" }]);
      expect(out.machines).toEqual([{ app: "demo", name: "web", action: "created" }]);
      // The volume was created before the machine that mounts it.
      expect(order).toEqual(["app", "volume", "machine"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

/**
 * #1457 — a plan entry matching none of the six request predicates used to fall
 * off the end of the classification chain. No log, no bucket, absent from all
 * eleven arrays `flyApply` returns, and the result read as a full apply. Worse
 * than the gcp version, which at least printed `skip:`.
 *
 * The trigger is serializer/applier version skew: the serializer emits a request
 * shape the applier's predicates do not recognise, which is exactly what happens
 * when a new Fly resource type lands on the serializer side alone.
 *
 * It fails rather than reporting not-attempted. The serializer produced the
 * entry, so the applier not recognising it is a bug in one half or the other —
 * not a resource the user chose to skip.
 */
describe("flyApply refuses a plan entry it cannot classify (#1457)", () => {
  const planWith = (entry: Record<string, unknown>): string => {
    const dir = mkdtempSync(join(tmpdir(), "fly-1457-"));
    const planPath = join(dir, "plan.json");
    writeFileSync(planPath, JSON.stringify(entry));
    return planPath;
  };

  test("an unrecognised endpoint fails, naming the entity and the request", async () => {
    const planPath = planWith({
      widget: { endpoint: "/v1/apps/foo/widgets", method: "POST", body: {} },
    });
    await expect(
      flyApply({ planPath, endpoint: "http://localhost:4280" }, undefined, async () => ({
        status: 200,
        text: "{}",
      })),
    ).rejects.toThrow(/widget.*POST \/v1\/apps\/foo\/widgets.*out of sync/s);
  });

  test("it fails before issuing any request, so nothing is half-applied", async () => {
    const planPath = planWith({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "a" } },
      widget: { endpoint: "/v1/apps/a/widgets", method: "POST", body: {} },
    });
    const calls: string[] = [];
    await expect(
      flyApply({ planPath, endpoint: "http://localhost:4280" }, undefined, async (method, url) => {
        calls.push(`${method} ${url}`);
        return { status: 200, text: "{}" };
      }),
    ).rejects.toThrow(/out of sync/);
    // Classification happens up front, so the app was never created either.
    expect(calls).toEqual([]);
  });

  test("a plan of only recognised shapes is unaffected", async () => {
    const planPath = planWith({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "solo" } },
    });
    const out = await flyApply({ planPath, endpoint: "http://localhost:4280" }, undefined, async () => ({
      status: 200,
      text: "{}",
    }));
    expect(out.apps.map((a) => a.app)).toEqual(["solo"]);
  });
});

/**
 * The shared apply-contract suite (#1446) against fly's own mocked transport.
 *
 * fly's plan axis is entity names, not kind/name pairs, so the plan is expressed
 * in the envelope's vocabulary — which is the projection working, not a
 * workaround: `toApplyResult` is what maps fly's six entity classes onto it.
 */
describeApplyConformance({
  lexicon: "fly",
  scenarios: [
    {
      name: "an app and a machine",
      plan: [
        { kind: "app", name: "solo" },
        { kind: "machine", name: "web" },
      ],
      run: async () => {
        const dir = mkdtempSync(join(tmpdir(), "fly-1446-"));
        const planPath = join(dir, "plan.json");
        writeFileSync(
          planPath,
          JSON.stringify({
            app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "solo" } },
            web: {
              endpoint: "/v1/apps/{app}/machines",
              method: "POST",
              body: { name: "web", config: { image: "nginx" } },
            },
          }),
        );
        try {
          // The same mock shape the ordering test above uses — flaps responses
          // the applier actually parses, not a bare {}.
          const http: FlyHttp = async (method, url) => {
            if (method === "GET" && /\/apps\/solo$/.test(url)) return { status: 404, text: "" };
            if (method === "POST" && /\/apps$/.test(url)) return { status: 200, text: "{}" };
            if (method === "GET" && url.endsWith("/machines")) return { status: 200, text: "[]" };
            if (method === "POST" && url.endsWith("/machines")) {
              return {
                status: 200,
                text: JSON.stringify({ id: "m1", name: "web", state: "created", instance_id: "I1", config: { image: "nginx" } }),
              };
            }
            if (method === "GET" && url.includes("/wait")) return { status: 200, text: JSON.stringify({ ok: true }) };
            return { status: 200, text: "[]" };
          };
          return toApplyResult(
            await flyApply(
              { planPath, endpoint: "http://localhost:4280", wait: { intervalMs: 0, deadlineMs: 5_000 } },
              undefined,
              http,
            ),
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      expectApplied: ["app/solo", "machine/web"],
    },
  ],
});
