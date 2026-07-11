import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flapsUp, flapsDown } from "./flaps";
import {
  flyApply,
  defaultFlyHttp,
  listMachines,
  listVolumes,
  listIps,
  listCerts,
  listSecrets,
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

const volumeReq = { endpoint: `/v1/apps/${APP}/volumes`, method: "POST", body: { name: "data", region: "iad", size_gb: 1 } };
const mountingMachineReq = {
  endpoint: `/v1/apps/${APP}/machines`,
  method: "POST",
  body: { name: "web", region: "iad", config: { image: "nginx:1", mounts: [{ volume: "data", path: "/data" }], metadata: { "managed-by": "chant" } } },
};
const ipReq = { endpoint: `/v1/apps/${APP}/ip_assignments`, method: "POST", body: { type: "shared_v4", region: "global", org_slug: "personal" } };
const certReq = { endpoint: `/v1/apps/${APP}/certificates`, method: "POST", body: { hostname: "example.com" } };
const secretReq = { endpoint: `/v1/apps/${APP}/secrets/db-password`, method: "POST", body: { value: "s3cret" }, applyOnly: true };

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

  // ── #741 breadth: Volume + IPAddress + Certificate + Secret ─────────────────

  test("volume applies before a mounting machine; ip + cert prune app-scoped; secret set never diffs", async (ctx) => {
    if (!available) ctx.skip();
    const cctx: ApplyCtx = { base: endpoint };

    // 1. Apply app + volume + a machine that mounts it, plus an ip, a cert, and
    //    an apply-only secret. The volume must be created before the machine.
    //    An http wrapper records the real POST order against live mudflaps.
    const createOrder: string[] = [];
    const recording: typeof http = async (method, url, body, headers, signal) => {
      if (method === "POST" && url.endsWith("/volumes")) createOrder.push("volume");
      if (method === "POST" && url.endsWith("/machines")) createOrder.push("machine");
      return http(method, url, body, headers, signal);
    };
    const applied = await flyApply({
      planPath: planFile("b1", { app: appReq, web: mountingMachineReq, data: volumeReq, ip: ipReq, cert: certReq, "db-password": secretReq }),
      endpoint,
      wait: WAIT,
    }, undefined, recording);

    // Volume provisioned; machine that mounts it reached started.
    expect(applied.volumes).toEqual([{ app: APP, name: "data", action: "created" }]);
    expect(applied.machines).toEqual([{ app: APP, name: "web", action: "created" }]);
    // Dependency order proven on the wire: the volume was POSTed first.
    expect(createOrder).toEqual(["volume", "machine"]);
    const vols = await listVolumes(cctx, APP, http);
    expect(vols.map((v) => v.name)).toContain("data");
    const web = (await listMachines(cctx, APP, http)).find((m) => m.name === "web");
    expect(web?.state).toBe("started");

    // IP + certificate applied.
    expect(applied.ips).toEqual([{ app: APP, type: "shared_v4", action: "created" }]);
    expect(applied.certs).toEqual([{ app: APP, hostname: "example.com", action: "created" }]);
    expect((await listIps(cctx, APP, http)).length).toBeGreaterThan(0);
    expect((await listCerts(cctx, APP, http)).map((c) => c.hostname)).toContain("example.com");

    // Secret set. flaps returns only a digest, never the value → apply-only (D7).
    expect(applied.secrets).toEqual([{ app: APP, name: "db-password" }]);
    const liveSecret = (await listSecrets(cctx, APP, http)).find((s) => s.name === "db-password");
    expect(liveSecret).toBeDefined();
    expect((liveSecret as { value?: unknown } | undefined)?.value ?? null).toBeNull(); // never read back

    // 2. Re-apply the identical plan. The secret is always re-set (apply-only,
    //    never a diff-driven no-op); the ip/cert/volume are idempotent no-ops.
    const reapply = await flyApply({
      planPath: planFile("b1b", { app: appReq, web: mountingMachineReq, data: volumeReq, ip: ipReq, cert: certReq, "db-password": secretReq }),
      endpoint,
      wait: WAIT,
    });
    expect(reapply.volumes).toEqual([{ app: APP, name: "data", action: "noop" }]);
    expect(reapply.ips).toEqual([{ app: APP, type: "shared_v4", action: "noop" }]);
    expect(reapply.certs).toEqual([{ app: APP, hostname: "example.com", action: "noop" }]);
    expect(reapply.secrets).toEqual([{ app: APP, name: "db-password" }]); // set again, no diff

    // 3. Drop the ip + cert + secret from the plan and prune. App-scoped (D2):
    //    the metadata-less types are owned wholesale, so undeclared ones go.
    const pruned = await flyApply({
      planPath: planFile("b2", { app: appReq, web: mountingMachineReq, data: volumeReq }),
      endpoint,
      prune: true,
      wait: WAIT,
    });
    expect(pruned.prunedIps.length).toBeGreaterThan(0);
    expect(pruned.prunedCerts.map((c) => c.hostname)).toContain("example.com");
    expect(pruned.prunedSecrets.map((s) => s.name)).toContain("db-password");
    // The still-declared volume + machine survive the app-scoped prune.
    expect(pruned.prunedVolumes).toEqual([]);
    expect(pruned.pruned.map((p) => p.name)).not.toContain("web");

    expect((await listCerts(cctx, APP, http)).map((c) => c.hostname)).not.toContain("example.com");
    expect((await listSecrets(cctx, APP, http)).map((s) => s.name)).not.toContain("db-password");
    expect((await listVolumes(cctx, APP, http)).map((v) => v.name)).toContain("data");
    expect((await listMachines(cctx, APP, http)).map((m) => m.name)).toContain("web");
  }, 120_000);
});
