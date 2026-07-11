import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flapsUp, flapsDown } from "./flaps";
import {
  flyApply,
  defaultFlyHttp,
  listMachines,
  acquireLease,
  releaseLease,
  isLeaseConflict,
  LEASE_NONCE_HEADER,
  type ApplyCtx,
} from "./fly-apply";

// End-to-end against a live mudflaps container (the #740 wrapper). Docker is
// required; when it is unavailable (CI) the whole suite skips cleanly rather
// than hard-failing. The tricky paths (lease-conflict retry, wait-on-new-
// version, owned-only prune) are proven here against real wire behavior.

const APP = "chant-it";
const CONTAINER = "chant-mudflaps-it";
const PORT = 4281;
const http = defaultFlyHttp();
const WAIT = { intervalMs: 50, timeoutSecs: 5, deadlineMs: 30_000 };

let endpoint = "";
let available = false;
let tmp = "";

/** Write a serializer-shaped plan file and return its path. */
function planFile(name: string, plan: Record<string, unknown>): string {
  const path = join(tmp, `${name}.json`);
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

const machineReq = (image: string) => ({
  endpoint: `/v1/apps/${APP}/machines`,
  method: "POST",
  body: {
    name: "web",
    region: "iad",
    config: { image, metadata: { "managed-by": "chant" } },
  },
});

const appReq = { endpoint: "/v1/apps", method: "POST", body: { app_name: APP, org_slug: "personal" } };

beforeAll(async () => {
  // Deterministically skip in CI. GitHub runners have docker, so relying on
  // docker-absence alone would pull mudflaps from ghcr on every CI run — a
  // network dependency that can flake. This is the only emulator-backed test in
  // the repo; it is a local-fidelity check, run explicitly (docker up) or in a
  // job that opts in with FLY_IT=1.
  if (process.env.CI && !process.env.FLY_IT) {
    available = false;
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "fly-it-"));
  try {
    const up = await flapsUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 });
    endpoint = up.endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) await flapsDown({ name: CONTAINER });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("flyApply against live mudflaps (#739)", () => {
  test("full acceptance loop: create → started → no-op → update → prune; unmarked survives", async (ctx) => {
    if (!available) ctx.skip();
    const cctx: ApplyCtx = { base: endpoint };

    // 1. Create App + Machine → machine reaches started (wait resolves).
    const created = await flyApply({ planPath: planFile("v1", { app: appReq, web: machineReq("nginx:1") }), endpoint, wait: WAIT });
    expect(created.apps).toEqual([{ app: APP, created: true }]);
    expect(created.machines).toEqual([{ app: APP, name: "web", action: "created" }]);

    const afterCreate = await listMachines(cctx, APP, http);
    expect(afterCreate.map((m) => m.name)).toContain("web");
    expect(afterCreate.find((m) => m.name === "web")?.state).toBe("started");

    // 2. Re-apply identical plan → no-op.
    const reapply = await flyApply({ planPath: planFile("v1b", { app: appReq, web: machineReq("nginx:1") }), endpoint, wait: WAIT });
    expect(reapply.machines).toEqual([{ app: APP, name: "web", action: "noop" }]);

    // 3. Image change → update to a new version.
    const before = await listMachines(cctx, APP, http);
    const oldInstance = before.find((m) => m.name === "web")?.instance_id;
    const updated = await flyApply({ planPath: planFile("v2", { app: appReq, web: machineReq("nginx:2") }), endpoint, wait: WAIT });
    expect(updated.machines).toEqual([{ app: APP, name: "web", action: "updated" }]);
    const after = await listMachines(cctx, APP, http);
    const newWeb = after.find((m) => m.name === "web");
    expect(newWeb?.config?.image).toBe("nginx:2");
    expect(newWeb?.instance_id).not.toBe(oldInstance); // new version minted

    // 4. Plant an UNMARKED machine directly (no managed-by: chant) — prune must spare it.
    const plant = await http("POST", `${endpoint}/v1/apps/${APP}/machines`, { name: "legacy", region: "iad", config: { image: "redis:1" } });
    expect(plant.status).toBe(200);

    // 5. Remove the owned machine from the plan and prune. Owned "web" is
    //    destroyed; unmarked "legacy" survives.
    const pruned = await flyApply({ planPath: planFile("v3", { app: appReq }), endpoint, prune: true, wait: WAIT });
    expect(pruned.pruned.map((p) => p.name)).toEqual(["web"]);

    const finalMachines = await listMachines(cctx, APP, http);
    const names = finalMachines.map((m) => m.name);
    expect(names).toContain("legacy"); // unmarked survived
    expect(names).not.toContain("web"); // owned + undeclared pruned
  }, 90_000);

  test("lease-conflict retry: gated update 409 → re-acquire → succeed", async (ctx) => {
    if (!available) ctx.skip();
    const cctx: ApplyCtx = { base: endpoint };

    // Fresh owned machine to mutate.
    await flyApply({ planPath: planFile("lc-setup", { app: appReq, lc: { ...machineReq("nginx:1"), body: { name: "leased", region: "iad", config: { image: "nginx:1", metadata: { "managed-by": "chant" } } } } }), endpoint, wait: WAIT });
    const target = (await listMachines(cctx, APP, http)).find((m) => m.name === "leased");
    expect(target).toBeDefined();
    const id = target!.id;

    // A foreign holder takes the lease out of band (nonce the applier never sees).
    const foreignNonce = await acquireLease(cctx, APP, id, http);

    // An http wrapper that, on the applier's FIRST lease acquire (which the real
    // server 409s because the foreign lease is held), releases the foreign lease
    // so the applier's retry acquire succeeds against a now-free machine. This
    // drives the real wire path: acquire 409 → re-acquire → mutate → wait.
    let sawConflict = false;
    let released = false;
    const wrapped: typeof http = async (method, url, body, headers, signal) => {
      const res = await http(method, url, body, headers, signal);
      if (!released && method === "POST" && url.endsWith("/lease") && isLeaseConflict(res.status, res.text)) {
        sawConflict = true;
        await releaseLease(cctx, APP, id, foreignNonce, http);
        released = true;
      }
      return res;
    };

    const gatedReq = { endpoint: `/v1/apps/${APP}/machines`, method: "POST", body: { name: "leased", region: "iad", config: { image: "nginx:2", metadata: { "managed-by": "chant" } } } };
    const out = await flyApply({ planPath: planFile("lc-update", { app: appReq, lc: gatedReq }), endpoint, wait: WAIT }, undefined, wrapped);
    expect(out.machines).toEqual([{ app: APP, name: "leased", action: "updated" }]);
    expect(sawConflict).toBe(true); // the applier really hit a 409 and recovered
    const settled = (await listMachines(cctx, APP, http)).find((m) => m.name === "leased");
    expect(settled?.config?.image).toBe("nginx:2");
  }, 90_000);
});
