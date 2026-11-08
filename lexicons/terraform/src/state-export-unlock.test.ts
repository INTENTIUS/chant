/**
 * #4762: a root's state export and lock release through chant core's gated
 * operations, with the binary faked (its `init` writes what init records
 * into the data dir it is given, its `force-unlock` removes the lock file),
 * S3 in memory behind the store's fetch, and the ledger in memory. No
 * binary, bucket or git is reached.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeLedger } from "@intentius/chant/__fixtures__/gated-ledger";
import type { BinaryExec } from "./state/exec";
import type { StoreFetch } from "./state/object-store";
import { terraformStateExport, terraformStateUnlock } from "./state-ops";

type Answer = Awaited<ReturnType<StoreFetch>>;
const answer = (status = 200, body = "", headers: Record<string, string> = {}): Answer => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 300, status, text: async () => body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null, forEach: (fn: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => fn(v, k)) } as Answer["headers"] };
};

/** A versioned S3 bucket in memory, path-style at http://s3.test/<bucket>/<key>. */
function fakeS3() {
  const versions = new Map<string, Array<{ id: string; body: string }>>();
  const seen: string[] = [];
  let n = 0;
  const put = (key: string, body: string) => versions.set(key, [...(versions.get(key) ?? []), { id: `v${++n}`, body }]);
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    const key = decodeURIComponent(u.pathname.slice(1));
    const vid = u.searchParams.get("versionId");
    seen.push(`${init.method} ${key}${vid ? `?${vid}` : ""}`);
    const all = versions.get(key) ?? [];
    if (init.method === "PUT") {
      if (init.headers["if-none-match"] === "*" && all.length) return answer(412);
      put(key, String(init.body));
      return answer(200);
    }
    if (init.method === "DELETE") {
      versions.delete(key);
      return answer(204);
    }
    const v = vid ? all.find((x) => x.id === vid) : all.at(-1);
    if (!v) return answer(404);
    return answer(200, init.method === "HEAD" ? "" : v.body, { "x-amz-version-id": v.id });
  };
  return { versions, seen, fetch, put };
}

/** GitLab's Terraform state API in memory, for project 7 at http://gitlab.test: versions by serial, the lock by LOCK and UNLOCK. */
function fakeGitLab() {
  const versions: Array<{ serial: number; body: string }> = [];
  let lock: Record<string, unknown> | undefined;
  const seen: string[] = [];
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    seen.push(`${init.method} ${u.pathname}`);
    const m = u.pathname.match(/^\/api\/v4\/projects\/7\/terraform\/state\/net(\/lock|\/versions\/(\d+))?$/);
    if (!m) return answer(404);
    if (m[1] === "/lock") {
      if (init.method === "LOCK") {
        if (lock) return answer(409, JSON.stringify(lock));
        lock = JSON.parse(String(init.body)) as Record<string, unknown>;
        return answer(200);
      }
      const id = (JSON.parse(String(init.body ?? "{}")) as { ID?: string }).ID;
      if (lock && lock.ID !== id) return answer(409, JSON.stringify(lock));
      lock = undefined;
      return answer(200);
    }
    const v = m[2] !== undefined ? versions.find((x) => String(x.serial) === m[2]) : versions.at(-1);
    if (!v) return answer(404);
    return answer(200, init.method === "HEAD" ? "" : v.body);
  };
  return { versions, seen, fetch, hold: (l: Record<string, unknown> | undefined) => void (lock = l), held: () => lock };
}

const GITLAB_ADDRESS = "http://gitlab.test/api/v4/projects/7/terraform/state/net";
const GITLAB_BACKEND = { address: GITLAB_ADDRESS, lock_address: `${GITLAB_ADDRESS}/lock`, unlock_address: `${GITLAB_ADDRESS}/lock`, username: "gitlab-ci-token", password: "glcbt" };

const S3_ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const S3_BACKEND = { bucket: "acme", key: "net.tfstate", use_lockfile: true, endpoints: { s3: "http://s3.test" } };

/** The binary: `init` records `backend` in the data dir TF_DATA_DIR names; `force-unlock` runs `onUnlock`. */
function fakeBinary(backend: { type: string; config: Record<string, unknown> }, onUnlock: (id: string) => void = () => {}) {
  const calls: Array<{ args: string[]; dataDir?: string }> = [];
  const exec: BinaryExec = async (_bin, args, _dir, env) => {
    calls.push({ args, ...(env.TF_DATA_DIR ? { dataDir: env.TF_DATA_DIR } : {}) });
    if (args[0] === "init") {
      mkdirSync(env.TF_DATA_DIR!, { recursive: true });
      writeFileSync(join(env.TF_DATA_DIR!, "terraform.tfstate"), JSON.stringify({ version: 3, backend }));
      return { code: 0, stdout: "", out: "" };
    }
    if (args[0] === "force-unlock") {
      onUnlock(args.at(-1)!);
      return { code: 0, stdout: "", out: "" };
    }
    return { code: 1, stdout: "", out: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), "chant-tf-export-"));

function rootDir(): string {
  const dir = join(tmp(), "net");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const common = (ledger: ReturnType<typeof fakeLedger>, dir: string, exec: BinaryExec, fetch: StoreFetch) => ({
  root: "net",
  dir,
  binary: "terraform",
  env: S3_ENV,
  exec,
  fetch,
  by: "ana",
  rules: { mode: "ledger" as const },
  ledger,
  now: "2026-11-08T09:00:00Z",
});

describe("terraformStateExport", () => {
  test("inits in a data dir of its own, asks for the version the bucket holds now, and writes it once approved", async () => {
    const s3 = fakeS3();
    s3.put("acme/net.tfstate", '{"serial":1}');
    s3.put("acme/net.tfstate", '{"serial":2}');
    const dir = rootDir();
    const bin = fakeBinary({ type: "s3", config: S3_BACKEND });
    const ledger = fakeLedger();
    const out = join(tmp(), "net.tfstate");
    const words = { op: "tf-state-export" };
    const first = await terraformStateExport({ ...common(ledger, dir, bin.exec, s3.fetch), out, words });
    expect(first).toMatchObject({ status: "waiting", version: "v2", location: "s3://acme/net.tfstate" });
    expect(bin.calls[0]!.args).toEqual(["init", "-input=false", "-no-color"]);
    expect(bin.calls[0]!.dataDir).toMatch(/chant-state-data-/);
    expect(existsSync(bin.calls[0]!.dataDir!)).toBe(false);
    expect(existsSync(join(dir, ".terraform"))).toBe(false);
    expect(s3.seen.filter((s) => s.startsWith("GET"))).toEqual([]);

    ledger.approve("bo");
    const second = await terraformStateExport({ ...common(ledger, dir, bin.exec, s3.fetch), out, words, version: "v2" });
    expect(second).toMatchObject({ status: "written", file: out });
    expect(readFileSync(out, "utf-8")).toBe('{"serial":2}');
    expect(s3.seen.filter((s) => s.startsWith("GET"))).toEqual(["GET acme/net.tfstate?v2"]);
  });

  test("an older version by its id, and an s3 backend that locks with DynamoDB is read all the same", async () => {
    const s3 = fakeS3();
    s3.put("acme/net.tfstate", '{"serial":1}');
    s3.put("acme/net.tfstate", '{"serial":2}');
    const bin = fakeBinary({ type: "s3", config: { ...S3_BACKEND, use_lockfile: false, dynamodb_table: "locks" } });
    const ledger = fakeLedger();
    ledger.approve("bo");
    const out = join(tmp(), "old.tfstate");
    const r = await terraformStateExport({ ...common(ledger, rootDir(), bin.exec, s3.fetch), out, words: { op: "tf-state-export" }, version: "v1" });
    expect(r).toMatchObject({ status: "written", version: "v1" });
    expect(readFileSync(out, "utf-8")).toBe('{"serial":1}');
  });

  test("a GitLab-managed state's version id is its serial", async () => {
    const gl = fakeGitLab();
    gl.versions.push({ serial: 3, body: '{"serial":3}' }, { serial: 4, body: '{"serial":4}' });
    const bin = fakeBinary({ type: "http", config: GITLAB_BACKEND });
    const ledger = fakeLedger();
    const out = join(tmp(), "gl.tfstate");
    const words = { op: "tf-state-export" };
    const first = await terraformStateExport({ ...common(ledger, rootDir(), bin.exec, gl.fetch), out, words });
    expect(first).toMatchObject({ status: "waiting", version: "4", location: GITLAB_ADDRESS });
    await expect(terraformStateExport({ ...common(ledger, rootDir(), bin.exec, gl.fetch), out, words, version: "v3" })).rejects.toThrow(/has no version v3/);
    ledger.approve("bo");
    const second = await terraformStateExport({ ...common(ledger, rootDir(), bin.exec, gl.fetch), out, words, version: "4" });
    expect(second).toMatchObject({ status: "written" });
    expect(readFileSync(out, "utf-8")).toBe('{"serial":4}');
  });

  test("a local state keeps no versions, and is refused before anything is asked", async () => {
    const ledger = fakeLedger();
    const bin = fakeBinary({ type: "local", config: {} });
    await expect(terraformStateExport({ ...common(ledger, rootDir(), bin.exec, fakeS3().fetch), words: { op: "tf-state-export" } })).rejects.toThrow(/^net: the state is a local file.*keeps no versions/);
    expect(ledger.writes).toEqual([]);
  });
});

describe("terraformStateUnlock", () => {
  test("reads the lock file, waits for an approval of its ID, and releases it with force-unlock in the same data dir", async () => {
    const s3 = fakeS3();
    s3.put("acme/net.tfstate.tflock", JSON.stringify({ ID: "a1b2", Operation: "OperationTypeApply", Who: "runner@ci", Created: "2026-11-08T08:00:00Z" }));
    const bin = fakeBinary({ type: "s3", config: S3_BACKEND }, (id) => {
      if (id === "a1b2") s3.versions.delete("acme/net.tfstate.tflock");
    });
    const ledger = fakeLedger();
    const words = { op: "tf-unlock" };
    const first = await terraformStateUnlock({ ...common(ledger, rootDir(), bin.exec, s3.fetch), words, liveRuns: async () => [] });
    expect(first).toMatchObject({ status: "waiting", location: "s3://acme/net.tfstate.tflock", lock: { ID: "a1b2", Who: "runner@ci" } });
    ledger.approve("bo");
    const second = await terraformStateUnlock({ ...common(ledger, rootDir(), bin.exec, s3.fetch), words, liveRuns: async () => [] });
    expect(second).toMatchObject({ status: "released", approvedBy: "bo" });
    const unlock = bin.calls.find((c) => c.args[0] === "force-unlock")!;
    expect(unlock.args).toEqual(["force-unlock", "-force", "-no-color", "a1b2"]);
    const init = bin.calls.filter((c) => c.args[0] === "init").at(-1)!;
    expect(unlock.dataDir).toBe(init.dataDir);
    expect(ledger.details[0]).toMatchObject({ lock_id: "a1b2", approved_by: "bo" });
  });

  test("a GitLab-managed state's lock is read by asking for it and released by its ID on the unlock address", async () => {
    const gl = fakeGitLab();
    gl.hold({ ID: "glock", Who: "runner", Created: "2026-11-08T08:00:00Z" });
    const bin = fakeBinary({ type: "http", config: GITLAB_BACKEND });
    const ledger = fakeLedger();
    const words = { op: "tf-unlock" };
    const first = await terraformStateUnlock({ ...common(ledger, rootDir(), bin.exec, gl.fetch), words, liveRuns: async () => [] });
    expect(first).toMatchObject({ status: "waiting", location: `${GITLAB_ADDRESS}/lock`, lock: { ID: "glock" } });
    ledger.approve("bo");
    const second = await terraformStateUnlock({ ...common(ledger, rootDir(), bin.exec, gl.fetch), words, liveRuns: async () => [] });
    expect(second).toMatchObject({ status: "released" });
    expect(gl.held()).toBeUndefined();
    expect(bin.calls.some((c) => c.args[0] === "force-unlock")).toBe(false);
  });

  test("refuses a local state and an s3 backend with no lock file", async () => {
    const ledger = fakeLedger();
    const opts = { words: { op: "tf-unlock" }, liveRuns: async () => [] };
    await expect(terraformStateUnlock({ ...common(ledger, rootDir(), fakeBinary({ type: "local", config: {} }).exec, fakeS3().fetch), ...opts })).rejects.toThrow(/lock goes with the process/);
    await expect(terraformStateUnlock({ ...common(ledger, rootDir(), fakeBinary({ type: "s3", config: { ...S3_BACKEND, use_lockfile: false } }).exec, fakeS3().fetch), ...opts })).rejects.toThrow(/use_lockfile/);
    expect(ledger.writes).toEqual([]);
  });
});
