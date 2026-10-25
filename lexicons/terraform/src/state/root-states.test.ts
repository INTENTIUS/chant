/**
 * Locks, pulls, writes and the unwritten keep (#4437), with a fake exec and
 * in-memory object stores that answer the real stores' requests.
 *
 * Carried over from terragucci at c493e0e: test/migrate.test.ts "the S3 lock
 * a migration holds", test/state-stores.test.ts "a gcs or azurerm state's
 * lock" (with its fakeGcs and fakeAzure), and "refuses when the gcs state's
 * lock is held, and writes nothing" rewritten as a take that names the
 * holder. The keep and its later write are compose.ts's, which terragucci
 * tested only through a whole composed run; they are tested here on their own.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateObject, type LockableState } from "./backend";
import { pullState, type BinaryExec, type StateFile } from "./exec";
import { lockInfo, StateLockedError } from "./locks";
import type { StoreFetch } from "./object-store";
import { COMPOSE_LOCK, DEFAULT_RETRY_DELAYS, LEGACY_UNWRITTEN_SUFFIX, RootStates, StateRefusedError, UNWRITTEN_SUFFIX, type RootState } from "./root-states";
import { S3Client } from "./s3";
import { stateStore } from "./store";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 25, 12, m)).toISOString();
const tmp = (): string => mkdtempSync(join(tmpdir(), "chant-states-"));
const state = (lineage: string, serial: number): StateFile => ({ version: 4, terraform_version: "1.10.0", serial, lineage, outputs: {}, resources: [], check_results: null });
const lockText = (who: string, op = "OperationTypeApply", info = "") => JSON.stringify({ ID: `id-${who}`, Operation: op, Info: info, Who: who, Version: "1.10.0", Created: T(1), Path: "x" });

type Answer = Awaited<ReturnType<StoreFetch>>;
const answer = (status = 200, body = "", headers: Record<string, string> = {}): Answer => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 300, status, text: async () => body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null, forEach: (fn: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => fn(v, k)) } as Answer["headers"] };
};

/** S3 in memory, path-style at http://s3.test/<bucket>/<key>: a PUT with If-None-Match only when absent, and every request seen. `fail` refuses a PUT whose key it matches. */
function fakeS3() {
  const objects = new Map<string, string>();
  const seen: string[] = [];
  let fail: RegExp | undefined;
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.slice(1));
    seen.push(`${init.method} ${key}`);
    if (init.method === "PUT") {
      if (fail?.test(key)) return answer(503, "SlowDown");
      if (init.headers["if-none-match"] === "*" && objects.has(key)) return answer(412);
      objects.set(key, String(init.body));
      return answer(200);
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return answer(204);
    }
    const body = objects.get(key);
    if (body === undefined) return answer(404);
    return answer(200, init.method === "HEAD" ? "" : body);
  };
  return { objects, seen, fetch, failPuts: (re?: RegExp) => void (fail = re) };
}

/** GCS's JSON API in memory, at http://gcs.test: objects by generation, a write conditional on ifGenerationMatch. */
function fakeGcs() {
  const objects = new Map<string, { generation: string; body: string }>();
  let n = 1000;
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    let m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (m && init.method === "POST") {
      const key = `${m[1]}/${u.searchParams.get("name")}`;
      const cond = u.searchParams.get("ifGenerationMatch");
      if (cond !== null && (objects.get(key)?.generation ?? "0") !== cond) return answer(412);
      const generation = String(++n);
      objects.set(key, { generation, body: String(init.body) });
      return answer(200, JSON.stringify({ generation }));
    }
    m = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(u.pathname);
    if (!m) return answer(404);
    const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
    if (init.method === "DELETE") return answer(objects.delete(key) ? 204 : 404);
    const found = objects.get(key);
    if (!found) return answer(404);
    if (u.searchParams.get("alt") === "media") return answer(200, found.body, { "x-goog-generation": found.generation });
    return answer(200, JSON.stringify({ name: m[2], generation: found.generation }));
  };
  return { objects, fetch };
}

/** Azure Blob Storage in memory, at https://acme.blob.core.windows.net: blobs with snapshots, leases and metadata, a write refused without the lease that holds the blob. */
function fakeAzure() {
  type Blob = { body: string; meta: Record<string, string>; lease?: string; snapshots: string[] };
  const blobs = new Map<string, Blob>();
  let n = 0;
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.slice(1));
    const h = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const comp = u.searchParams.get("comp");
    const b = blobs.get(key);
    const meta = (): Record<string, string> => Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith("x-ms-meta-")).map(([k, v]) => [k.slice(10), v]));
    if (init.method === "PUT" && comp === "lease") {
      if (!b) return answer(404);
      if (h["x-ms-lease-action"] === "acquire") {
        if (b.lease) return answer(409);
        b.lease = h["x-ms-proposed-lease-id"];
        return answer(201);
      }
      if (b.lease !== h["x-ms-lease-id"]) return answer(409);
      delete b.lease;
      return answer(200);
    }
    if (init.method === "PUT" && comp === "snapshot") {
      if (!b) return answer(404);
      b.snapshots.push(b.body);
      return answer(201, "", { "x-ms-snapshot": `snap-${++n}` });
    }
    if (init.method === "PUT" && comp === "metadata") {
      if (!b) return answer(404);
      if (b.lease && b.lease !== h["x-ms-lease-id"]) return answer(412);
      b.meta = meta();
      return answer(200);
    }
    if (init.method === "PUT") {
      if (h["if-none-match"] === "*" && b) return answer(409);
      if (b?.lease && b.lease !== h["x-ms-lease-id"]) return answer(412);
      blobs.set(key, { body: String(init.body), meta: meta(), ...(b?.lease ? { lease: b.lease } : {}), snapshots: b?.snapshots ?? [] });
      return answer(201);
    }
    if (init.method === "DELETE") return answer(blobs.delete(key) ? 202 : 404);
    if (!b) return answer(404);
    const headers = { etag: `"${b.body.length}"`, "x-ms-lease-state": b.lease ? "leased" : "available", ...Object.fromEntries(Object.entries(b.meta).map(([k, v]) => [`x-ms-meta-${k}`, v])) };
    return answer(200, init.method === "HEAD" ? "" : b.body, headers);
  };
  return { blobs, fetch };
}

/**
 * The binary, faked: `state pull` prints the state `held` has for the
 * root's directory, `state push -lock=false <file>` stores the file's state
 * there. `pushFails` fails that many pushes first (Infinity: every one), and
 * `onPush` sees each push before it is answered.
 */
function fakeBinary(o: { pushFails?: number; onPush?: (dir: string) => void } = {}) {
  const held = new Map<string, StateFile>();
  const calls: string[] = [];
  const pushed: { dir: string; state: StateFile }[] = [];
  let fails = o.pushFails ?? 0;
  const exec: BinaryExec = async (_bin, args, dir) => {
    calls.push(args.join(" "));
    if (args[0] === "state" && args[1] === "pull") {
      const s = held.get(dir);
      return { code: 0, stdout: s ? JSON.stringify(s) : "", out: "" };
    }
    if (args[0] === "state" && args[1] === "push") {
      expect(args).toContain("-lock=false");
      o.onPush?.(dir);
      if (fails > 0) {
        fails--;
        return { code: 1, stdout: "", out: "Error: Failed to persist state: RequestTimeout" };
      }
      const s = JSON.parse(readFileSync(args.at(-1)!, "utf-8")) as StateFile;
      held.set(dir, s);
      pushed.push({ dir, state: s });
      return { code: 0, stdout: "", out: "" };
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, held, calls, pushed };
}

/** A root directory initialised with `type` and `config`, as init leaves it. */
function root(name: string, type: string | undefined, config: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}): RootState {
  const dir = join(tmp(), name);
  mkdirSync(join(dir, ".terraform"), { recursive: true });
  if (type) writeFileSync(join(dir, ".terraform/terraform.tfstate"), JSON.stringify({ version: 3, backend: { type, config } }));
  return { root: name, dir, env };
}

const S3_ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const s3Root = (name: string, extra: Record<string, unknown> = {}) => root(name, "s3", { bucket: "acme", key: `${name}.tfstate`, use_lockfile: true, endpoints: { s3: "http://s3.test" }, ...extra }, S3_ENV);
const GCS_CONFIG = { bucket: "acme", prefix: "app", storage_custom_endpoint: "http://gcs.test/storage/v1/", access_token: "t" };
const AZ_CONFIG = { storage_account_name: "acme", container_name: "tfstate", key: "app.tfstate", access_key: Buffer.from("key").toString("base64") };

const noSleep = { sleep: async () => {} };
const runOpts = (fetch: StoreFetch | undefined, exec: BinaryExec, roots: RootState[], extra: Partial<ConstructorParameters<typeof RootStates>[0]> = {}) => ({
  roots,
  binary: "tofu",
  exec,
  ...(fetch ? { fetch } : {}),
  work: tmp(),
  reportDir: tmp(),
  runId: "run-7",
  now: () => T(2),
  who: "chant@ci",
  ...noSleep,
  ...extra,
});

describe("a lock is taken and released", () => {
  it("on s3: the lock file use_lockfile takes, written only when absent and naming the operation and the run", async () => {
    const s3 = fakeS3();
    const bin = fakeBinary({ onPush: () => expect(s3.objects.has("acme/app.tfstate.tflock")).toBe(true) });
    const states = new RootStates(runOpts(s3.fetch, bin.exec, [s3Root("app")]));
    await states.take();
    const info = JSON.parse(s3.objects.get("acme/app.tfstate.tflock")!) as Record<string, string>;
    expect(info).toMatchObject({ Operation: COMPOSE_LOCK.operation, Info: expect.stringContaining("(run run-7)"), Who: "chant@ci", Created: T(2), Path: "acme/app.tfstate" });
    expect(await states.write("app", state("L", 2))).toEqual({ written: true, attempts: 1 });
    await states.release();
    expect(s3.objects.has("acme/app.tfstate.tflock")).toBe(false);
    expect(states.held()).toEqual([]);
  });

  it("on gcs: the lock object beside the state, taken only when there is none, and its generation the lock's ID", async () => {
    const g = fakeGcs();
    const bin = fakeBinary({ onPush: () => expect(g.objects.has("acme/app/default.tflock")).toBe(true) });
    const r = root("app", "gcs", GCS_CONFIG);
    const states = new RootStates(runOpts(g.fetch, bin.exec, [r]));
    await states.take();
    const store = stateStore(stateObject(r.dir, {}) as LockableState, r.dir, g.fetch);
    expect(store.lockLocation).toBe("gs://acme/app/default.tflock");
    expect(await store.heldLock()).toMatchObject({ id: g.objects.get("acme/app/default.tflock")!.generation });
    await states.write("app", state("L", 2));
    await states.release();
    expect(g.objects.has("acme/app/default.tflock")).toBe(false);
  });

  it("on azurerm: a lease on the state blob with the lock info in its metadata, the state written by the store under the lease", async () => {
    const a = fakeAzure();
    const bin = fakeBinary();
    const states = new RootStates(runOpts(a.fetch, bin.exec, [root("app", "azurerm", { ...AZ_CONFIG, snapshot: true })]));
    await states.take();
    const blob = a.blobs.get("tfstate/app.tfstate")!;
    expect(blob.lease).toBeTruthy();
    expect(JSON.parse(Buffer.from(blob.meta.terraformlockid!, "base64").toString())).toMatchObject({ Operation: COMPOSE_LOCK.operation, ID: blob.lease });
    expect(await states.write("app", state("L", 2))).toMatchObject({ written: true });
    // The binary cannot write a leased blob: the store wrote it, snapshotting first as the backend does.
    expect(bin.calls.filter((c) => c.startsWith("state push"))).toEqual([]);
    expect(JSON.parse(a.blobs.get("tfstate/app.tfstate")!.body)).toMatchObject({ lineage: "L", serial: 2 });
    expect(a.blobs.get("tfstate/app.tfstate")!.snapshots).toHaveLength(1);
    await states.release();
    expect(a.blobs.get("tfstate/app.tfstate")!.lease).toBeUndefined();
  });

  it("on local: <path>.tflock beside the state file, created only when absent", async () => {
    const r = root("app", "local", { path: "state/app.tfstate" });
    const lockFile = join(r.dir, "state/app.tfstate.tflock");
    const bin = fakeBinary({ onPush: () => expect(existsSync(lockFile)).toBe(true) });
    const states = new RootStates(runOpts(undefined, bin.exec, [r]));
    await states.take();
    expect(JSON.parse(readFileSync(lockFile, "utf-8"))).toMatchObject({ Operation: COMPOSE_LOCK.operation });
    // A second run finds it held.
    await expect(new RootStates(runOpts(undefined, bin.exec, [r])).take()).rejects.toBeInstanceOf(StateLockedError);
    await states.write("app", state("L", 2));
    await states.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("in the order given, and a pull reads each state through the binary", async () => {
    const s3 = fakeS3();
    const bin = fakeBinary();
    const [a, b] = [s3Root("a"), s3Root("b")];
    bin.held.set(a.dir, state("LA", 3));
    const states = new RootStates(runOpts(s3.fetch, bin.exec, [b, a]));
    await states.take();
    expect(s3.seen.filter((s) => s.startsWith("PUT"))).toEqual(["PUT acme/b.tfstate.tflock", "PUT acme/a.tfstate.tflock"]);
    expect(states.held()).toEqual(["b", "a"]);
    expect(await states.pull("a")).toMatchObject({ lineage: "LA", serial: 3 });
    expect(await states.pull("b")).toBeNull();
    await states.release();
  });
});

describe("a lock another run holds", () => {
  it("stops the take before anything is pulled, releases what was taken, and names the holder", async () => {
    const s3 = fakeS3();
    s3.objects.set("acme/b.tfstate.tflock", lockText("alice@laptop", "OperationTypeApply", "manual apply"));
    const bin = fakeBinary();
    const states = new RootStates(runOpts(s3.fetch, bin.exec, [s3Root("a"), s3Root("b")]));
    const err = await states.take().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateLockedError);
    expect((err as StateLockedError).holder).toMatchObject({ who: "alice@laptop", operation: "OperationTypeApply", info: "manual apply", created: T(1) });
    expect((err as Error).message).toBe(`b: its state is locked at s3://acme/b.tfstate.tflock by alice@laptop OperationTypeApply (manual apply) since ${T(1)}, so nothing was pulled`);
    expect(s3.objects.has("acme/a.tfstate.tflock")).toBe(false);
    expect(s3.objects.get("acme/b.tfstate.tflock")).toContain("alice@laptop");
    expect(bin.calls).toEqual([]);
  });

  it("on gcs stops the take the same way", async () => {
    const g = fakeGcs();
    g.objects.set("acme/app/default.tflock", { generation: "7", body: lockText("bob@ci") });
    const err = await new RootStates(runOpts(g.fetch, fakeBinary().exec, [root("app", "gcs", GCS_CONFIG)])).take().catch((e: unknown) => e);
    expect(err).toMatchObject({ root: "app", lockLocation: "gs://acme/app/default.tflock", holder: { id: "7", who: "bob@ci" } });
  });

  it("is not taken over when it is a composed run's lock with no kept state", async () => {
    const s3 = fakeS3();
    s3.objects.set("acme/app.tfstate.tflock", lockText("chant@other", COMPOSE_LOCK.operation));
    await expect(new RootStates(runOpts(s3.fetch, fakeBinary().exec, [s3Root("app")])).take()).rejects.toBeInstanceOf(StateLockedError);
  });
});

describe("a write with retries", () => {
  it("that fails four times then succeeds is written once, the lock held throughout, after 5s, 15s, 30s and 60s", async () => {
    const s3 = fakeS3();
    const lockSeen: boolean[] = [];
    const bin = fakeBinary({ pushFails: 4, onPush: () => lockSeen.push(s3.objects.has("acme/app.tfstate.tflock")) });
    const slept: number[] = [];
    const r = s3Root("app");
    const states = new RootStates(runOpts(s3.fetch, bin.exec, [r], { sleep: async (ms: number) => void slept.push(ms) }));
    await states.take();
    expect(await states.write("app", state("L", 9))).toEqual({ written: true, attempts: 5 });
    expect(lockSeen).toEqual([true, true, true, true, true]);
    expect(slept).toEqual([5_000, 15_000, 30_000, 60_000]);
    expect(bin.pushed).toEqual([{ dir: r.dir, state: state("L", 9) }]);
    expect(s3.objects.has("acme/app.tfstate.chant-unwritten")).toBe(false);
    await states.release();
    expect(s3.objects.has("acme/app.tfstate.tflock")).toBe(false);
  });

  it("waits 5s, 15s, 30s, 60s and 120s by default: inside the 5-minute lock timeout", () => {
    expect(DEFAULT_RETRY_DELAYS).toEqual([5_000, 15_000, 30_000, 60_000, 120_000]);
    expect(DEFAULT_RETRY_DELAYS.reduce((a, b) => a + b, 0)).toBeLessThan(300_000);
  });
});

describe("the unwritten keep", () => {
  it("leaves <key>.chant-unwritten beside the state and the lock held when every retry fails; a later take writes it first and only then returns", async () => {
    const s3 = fakeS3();
    const r = s3Root("app");
    const failing = fakeBinary({ pushFails: Infinity });
    const first = new RootStates(runOpts(s3.fetch, failing.exec, [r]));
    await first.take();
    const out = await first.write("app", state("L", 4));
    expect(out).toEqual({ written: false, attempts: 6, error: expect.stringContaining("state push failed"), kept: `s3://acme/app.tfstate${UNWRITTEN_SUFFIX}`, lockHeld: true });
    expect(JSON.parse(s3.objects.get("acme/app.tfstate.chant-unwritten")!)).toEqual(state("L", 4));
    await first.release();
    expect(s3.objects.get("acme/app.tfstate.tflock")).toContain("(run run-7)");

    const ok = fakeBinary();
    const later = new RootStates(runOpts(s3.fetch, ok.exec, [r], { runId: "run-8" }));
    await later.take();
    // By the time take returns, the kept state is written and gone, and the lock is this run's.
    expect(ok.pushed).toEqual([{ dir: r.dir, state: state("L", 4) }]);
    expect(s3.objects.has("acme/app.tfstate.chant-unwritten")).toBe(false);
    expect(later.held()).toEqual(["app"]);
    await later.release();
    expect(s3.objects.has("acme/app.tfstate.tflock")).toBe(false);
  });

  it("on azurerm takes the lease over by its ID and writes the kept state under it", async () => {
    const a = fakeAzure();
    const r = root("app", "azurerm", AZ_CONFIG);
    const failing = new RootStates(runOpts(a.fetch, fakeBinary().exec, [r]));
    await failing.take();
    a.blobs.set("tfstate/app.tfstate", { ...a.blobs.get("tfstate/app.tfstate")!, lease: "someone-else" });
    // The blob's lease moved under the run: every write fails, and the state is kept beside it.
    const out = await failing.write("app", state("L", 5));
    expect(out).toMatchObject({ written: false, kept: `az://acme/tfstate/app.tfstate${UNWRITTEN_SUFFIX}` });
    const lease = a.blobs.get("tfstate/app.tfstate")!;
    lease.lease = "kept-lease";
    lease.meta = { terraformlockid: Buffer.from(JSON.stringify({ ID: "kept-lease", Operation: COMPOSE_LOCK.operation })).toString("base64") };
    const later = new RootStates(runOpts(a.fetch, fakeBinary().exec, [r]));
    await later.take();
    expect(JSON.parse(a.blobs.get("tfstate/app.tfstate")!.body)).toMatchObject({ lineage: "L", serial: 5 });
    expect(a.blobs.has(`tfstate/app.tfstate${UNWRITTEN_SUFFIX}`)).toBe(false);
    await later.release();
    expect(a.blobs.get("tfstate/app.tfstate")!.lease).toBeUndefined();
  });

  it("goes under the job's report directory when the backend cannot take it either", async () => {
    const s3 = fakeS3();
    s3.failPuts(/chant-unwritten$/);
    const states = new RootStates(runOpts(s3.fetch, fakeBinary({ pushFails: Infinity }).exec, [s3Root("envs/app")]));
    await states.take();
    const out = await states.write("envs/app", state("L", 4));
    expect(out).toMatchObject({ written: false, lockHeld: true });
    const kept = (out as { kept: string }).kept;
    expect(kept.endsWith(join("unwritten", "envs_app.tfstate"))).toBe(true);
    expect(JSON.parse(readFileSync(kept, "utf-8"))).toEqual(state("L", 4));
    await states.release();
    expect(s3.objects.has("acme/envs/app.tfstate.tflock")).toBe(true);
  });

  it("reads a state terragucci kept as .terragucci-unwritten under its lock, writes it, removes it, and never writes that name", async () => {
    const s3 = fakeS3();
    s3.objects.set("acme/app.tfstate.tflock", lockText("terragucci@ci", "terragucci compose"));
    s3.objects.set(`acme/app.tfstate${LEGACY_UNWRITTEN_SUFFIX}`, JSON.stringify(state("L", 6)));
    const bin = fakeBinary();
    const r = s3Root("app");
    const states = new RootStates(runOpts(s3.fetch, bin.exec, [r]));
    await states.take();
    expect(bin.pushed).toEqual([{ dir: r.dir, state: state("L", 6) }]);
    expect(s3.objects.has(`acme/app.tfstate${LEGACY_UNWRITTEN_SUFFIX}`)).toBe(false);
    expect(s3.seen.filter((s) => s.startsWith("PUT") && s.includes("terragucci"))).toEqual([]);
    await states.release();
  });

  it("keeps the lock held when the kept state still cannot be written, and releases the others", async () => {
    const s3 = fakeS3();
    s3.objects.set("acme/b.tfstate.tflock", lockText("chant@ci", COMPOSE_LOCK.operation));
    s3.objects.set("acme/b.tfstate.chant-unwritten", JSON.stringify(state("L", 2)));
    const states = new RootStates(runOpts(s3.fetch, fakeBinary({ pushFails: Infinity }).exec, [s3Root("a"), s3Root("b")]));
    await expect(states.take()).rejects.toThrow("b: the state an earlier run kept for it could not be written");
    expect(s3.objects.has("acme/a.tfstate.tflock")).toBe(false);
    expect(s3.objects.has("acme/b.tfstate.tflock")).toBe(true);
    expect(s3.objects.has("acme/b.tfstate.chant-unwritten")).toBe(true);
  });
});

describe("a root chant does not lock", () => {
  it("is named with its reason, and the take takes no lock at all", async () => {
    const s3 = fakeS3();
    const roots = [
      s3Root("locked"),
      s3Root("nolockfile", { use_lockfile: false }),
      root("hcp", "cloud", { organization: "acme" }),
      root("pg", "pg", { conn_str: "postgres://db/states" }),
    ];
    const bin = fakeBinary();
    const states = new RootStates(runOpts(s3.fetch, bin.exec, roots));
    expect(states.refusals().map((r) => [r.root, r.refused])).toEqual([
      ["nolockfile", "no-lockfile"],
      ["hcp", "cloud"],
      ["pg", "backend"],
    ]);
    const err = await states.take().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateRefusedError);
    expect((err as Error).message).toContain("nolockfile: the s3 backend takes no lock file");
    expect(s3.seen).toEqual([]);
    expect(bin.calls).toEqual([]);
  });
});

describe("the S3 lock request", () => {
  it("is the state's lock file, taken only when absent and never without the condition", async () => {
    expect(JSON.parse(lockInfo("b/k", T(1), COMPOSE_LOCK, "me"))).toMatchObject({ Operation: COMPOSE_LOCK.operation, Who: "me", Created: T(1), Path: "b/k" });
    const reply = (status: number): StoreFetch => async (_u, init) => {
      expect(init.headers["if-none-match"]).toBe("*");
      return { ok: status < 300, status, text: async () => "" };
    };
    const client = (f: StoreFetch) => new S3Client({ bucket: "b", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, f);
    expect(await client(reply(200)).putIfAbsent("k.tflock", "{}", "application/json")).toBe(true);
    expect(await client(reply(412)).putIfAbsent("k.tflock", "{}", "application/json")).toBe(false);
    await expect(client(reply(501)).putIfAbsent("k.tflock", "{}", "application/json")).rejects.toThrow("does not take a conditional write");
    const seen: string[] = [];
    await client(async (u, init) => {
      seen.push(`${init.method} ${u}`);
      return { ok: false, status: 404, text: async () => "" };
    }).remove("k.tflock");
    expect(seen).toEqual(["DELETE http://minio:9000/b/k.tflock"]);
  });
});

describe("a pull", () => {
  it("is the state the binary prints, null for none or an empty state with no lineage, and an error naming the root when it fails", async () => {
    const run = (code: number, stdout: string, out = ""): BinaryExec => async () => ({ code, stdout, out });
    expect(await pullState(run(0, JSON.stringify(state("L", 1))), "tofu", "app", "/r", {})).toMatchObject({ lineage: "L", resources: [] });
    expect(await pullState(run(0, ""), "tofu", "app", "/r", {})).toBeNull();
    expect(await pullState(run(0, JSON.stringify({ version: 4, serial: 0, lineage: "" })), "tofu", "app", "/r", {})).toBeNull();
    await expect(pullState(run(1, "", "Error: AccessDenied"), "tofu", "app", "/r", {})).rejects.toThrow("state pull in app failed: Error: AccessDenied");
    await expect(pullState(run(0, "not json"), "tofu", "app", "/r", {})).rejects.toThrow("not a state");
  });
});
