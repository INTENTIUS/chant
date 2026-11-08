// The GitLab-managed state store (#4773), against a GitLab state API fake listening on 127.0.0.1: serial, versions,
// the lock probe and release, the lock a run takes, a write under it, and the states kept beside it. No real GitLab.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitlabBesideAddress, gitlabState, gitlabStore, isGitLabAddress, shownUrl, suffixedGitLabAddress, type GitLabState } from "./gitlab";
import { stateStore } from "./store";

const USER = "gitlab-ci-token";
const TOKEN = "glcbt-secret";
const BASIC = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;

interface Fake {
  url: string;
  /** Each state by name: its versions by serial, the latest last. */
  states: Map<string, Array<{ serial: number; text: string }>>;
  /** Each held lock by state name: its info as taken. */
  locks: Map<string, Record<string, unknown>>;
  requests: Array<{ method: string; path: string; query: string; authorization?: string }>;
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => res(Buffer.concat(parts).toString("utf-8")));
  });

/** GitLab's Terraform state API as the http backend calls it, for project 7. */
async function startFakeGitLab(): Promise<Fake> {
  const states: Fake["states"] = new Map();
  const locks: Fake["locks"] = new Map();
  const requests: Fake["requests"] = [];
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const text = await body(req);
    requests.push({ method: req.method ?? "", path: u.pathname, query: u.search, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
    const send = (status: number, out = "") => {
      res.writeHead(status, out ? { "content-type": "application/json" } : {});
      res.end(req.method === "HEAD" ? undefined : out);
    };
    if (req.headers.authorization !== BASIC) return send(401, JSON.stringify({ message: "401 Unauthorized" }));
    const m = u.pathname.match(/^\/api\/v4\/projects\/7\/terraform\/state\/([^/]+)(\/lock|\/versions\/([^/]+))?$/);
    if (!m) return send(404);
    const name = decodeURIComponent(m[1]!);
    const versions = states.get(name) ?? [];
    if (m[2] === "/lock") {
      const held = locks.get(name);
      if (req.method === "LOCK" || req.method === "POST") {
        if (held) return send(409, JSON.stringify(held));
        locks.set(name, JSON.parse(text) as Record<string, unknown>);
        return send(200);
      }
      if (req.method === "UNLOCK" || req.method === "DELETE") {
        const id = (JSON.parse(text || "{}") as { ID?: string }).ID ?? u.searchParams.get("ID");
        if (held && held.ID !== id) return send(409, JSON.stringify(held));
        locks.delete(name);
        return send(200);
      }
      return send(405);
    }
    if (m[3] !== undefined) {
      const v = versions.find((x) => String(x.serial) === decodeURIComponent(m[3]!));
      return v ? send(200, v.text) : send(404);
    }
    if (req.method === "GET") {
      const latest = versions.at(-1);
      return latest ? send(200, latest.text) : send(404);
    }
    if (req.method === "POST") {
      const held = locks.get(name);
      if (held && held.ID !== (u.searchParams.get("ID") ?? undefined)) return send(409, JSON.stringify(held));
      const serial = (JSON.parse(text) as { serial?: number }).serial ?? versions.length;
      states.set(name, [...versions, { serial, text }]);
      return send(200, "{}");
    }
    if (req.method === "DELETE") {
      if (!states.has(name)) return send(404);
      states.delete(name);
      return send(204);
    }
    return send(405);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, states, locks, requests, close: () => new Promise((r) => server.close(() => r())) };
}

let gl: Fake;
let s: GitLabState;

const config = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const address = `${gl.url}/api/v4/projects/7/terraform/state/${name}`;
  return { address, lock_address: `${address}/lock`, unlock_address: `${address}/lock`, username: USER, password: TOKEN, ...extra };
};

const state = (serial: number, extra: Record<string, unknown> = {}) => JSON.stringify({ version: 4, serial, lineage: "l-1", resources: [], ...extra });

beforeEach(async () => {
  gl = await startFakeGitLab();
  s = gitlabState(config("prod"), {})!;
});

afterEach(async () => {
  await gl.close();
});

describe("gitlabState", () => {
  it("reads the backend's configuration, else the job's TF_HTTP_* variables", () => {
    expect(s).toMatchObject({ backend: "http", name: "prod", lockMethod: "LOCK", unlockMethod: "UNLOCK", auth: BASIC });
    const address = `${gl.url}/api/v4/projects/7/terraform/state/stage%20one`;
    const fromEnv = gitlabState({}, { TF_HTTP_ADDRESS: address, TF_HTTP_LOCK_ADDRESS: `${address}/lock`, TF_HTTP_UNLOCK_ADDRESS: `${address}/lock`, TF_HTTP_LOCK_METHOD: "POST", TF_HTTP_UNLOCK_METHOD: "DELETE", TF_HTTP_USERNAME: USER, TF_HTTP_PASSWORD: TOKEN })!;
    expect(fromEnv).toMatchObject({ name: "stage one", lockMethod: "POST", unlockMethod: "DELETE", auth: BASIC, lockAddress: `${address}/lock` });
    expect(gitlabState({ address: "https://state.example.com/tf/prod" }, {})).toBeUndefined();
    expect(isGitLabAddress("https://gitlab.example.com/api/v4/projects/group%2Fapp/terraform/state/prod")).toBe(true);
    expect(isGitLabAddress("not a url")).toBe(false);
  });

  it("names a suffixed copy of the state and its lock, and shows a URL without its credentials", () => {
    const a = "https://gitlab.example.com/api/v4/projects/7/terraform/state/prod";
    expect(suffixedGitLabAddress(a, "pr-12")).toBe(`${a}-pr-12`);
    expect(suffixedGitLabAddress(`${a}/lock`, "pr-12")).toBe(`${a}-pr-12/lock`);
    expect(suffixedGitLabAddress("https://example.com/other", "x")).toBeUndefined();
    expect(shownUrl("https://u:p@gitlab.example.com/api/v4/x?ID=1")).toBe("https://gitlab.example.com/api/v4/x");
  });
});

describe("gitlabStore reads", () => {
  it("answers the serial and lineage of the state GitLab holds, and undefined when it holds none", async () => {
    const store = gitlabStore(s);
    expect(await store.serial()).toBeUndefined();
    gl.states.set("prod", [{ serial: 3, text: state(3) }, { serial: 4, text: state(4) }]);
    expect(await store.serial()).toEqual({ serial: 4, lineage: "l-1" });
    expect(gl.requests.every((r) => r.authorization === BASIC)).toBe(true);
  });

  it("checks a version with a HEAD and reads it by its serial", async () => {
    gl.states.set("prod", [{ serial: 3, text: state(3) }, { serial: 4, text: state(4) }]);
    const store = gitlabStore(s);
    expect(await store.hasVersion(3)).toBe(true);
    expect(await store.hasVersion("9")).toBe(false);
    expect(gl.requests.filter((r) => r.path.endsWith("/versions/3")).map((r) => r.method)).toEqual(["HEAD"]);
    expect(JSON.parse((await store.readVersion("3"))!)).toMatchObject({ serial: 3 });
    expect(await store.readVersion(9)).toBeUndefined();
  });

  it("names the credentials, never their values, when GitLab refuses them", async () => {
    const store = gitlabStore(gitlabState(config("prod", { password: "wrong" }), {})!);
    const err = await store.serial().catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^GitLab answered 401 to a read of http:\/\/127\.0\.0\.1:\d+\/api\/v4\/projects\/7\/terraform\/state\/prod: the backend's username and password/);
    expect((err as Error).message).not.toContain("wrong");
  });
});

describe("gitlabStore locks", () => {
  it("probes a free lock by taking and releasing it, and reads a held one's holder", async () => {
    const store = gitlabStore(s, undefined, "terragucci");
    expect(await store.probeLock()).toBeUndefined();
    const probe = gl.requests.filter((r) => r.path.endsWith("/lock")).map((r) => r.method);
    expect(probe).toEqual(["LOCK", "UNLOCK"]);
    expect(gl.locks.size).toBe(0);
    gl.locks.set("prod", { ID: "abc", Operation: "OperationTypeApply", Who: "runner@ci", Created: "2026-11-08T10:00:00Z", Info: "" });
    expect(JSON.parse((await store.probeLock())!)).toEqual({ ID: "abc", Who: "runner@ci", Created: "2026-11-08T10:00:00Z" });
    expect(await store.heldLock()).toEqual({ id: "abc", info: JSON.stringify({ ID: "abc", Who: "runner@ci", Created: "2026-11-08T10:00:00Z" }) });
  });

  it("releases a lock by its ID, and throws when another ID holds it", async () => {
    const store = gitlabStore(s);
    gl.locks.set("prod", { ID: "abc" });
    await expect(store.releaseLock("other")).rejects.toThrow(/did not release lock other .*another lock holds the state now/);
    await store.releaseLock("abc");
    expect(gl.locks.size).toBe(0);
  });

  it("refuses a lock call on a backend with no lock address", async () => {
    const store = gitlabStore(gitlabState(config("prod", { lock_address: undefined, unlock_address: undefined }), {})!);
    await expect(store.probeLock()).rejects.toThrow(/names no lock_address/);
  });

  it("takes the lock, writes the state with the lock's ID, and releases it", async () => {
    const store = stateStoreOf(s);
    expect(store.backend).toBe("http");
    expect(await store.lock(JSON.stringify({ ID: "run-1", Who: "chant" }))).toBe(true);
    expect(await gitlabStore(s).lock(JSON.stringify({ ID: "run-2" }))).toBe(false);
    // The binary's write with -lock=false carries no ID, which GitLab refuses while the lock is held: the store writes.
    const bare = await fetch(s.address, { method: "POST", headers: { authorization: BASIC }, body: state(5) });
    expect(bare.status).toBe(409);
    await store.write!(state(5));
    expect(gl.requests.at(-1)).toMatchObject({ method: "POST", query: "?ID=run-1" });
    expect(gl.states.get("prod")!.at(-1)!.serial).toBe(5);
    await store.unlock();
    expect(gl.locks.size).toBe(0);
    await expect(store.write!(state(6))).rejects.toThrow(/none is held/);
  });

  it("adopts a held lock, so unlock releases it by its ID", async () => {
    gl.locks.set("prod", { ID: "earlier", Info: "chant compose" });
    const store = gitlabStore(s);
    const held = (await store.heldLock())!;
    store.adopt(held);
    await store.unlock();
    expect(gl.locks.size).toBe(0);
  });
});

describe("gitlabStore beside", () => {
  it("keeps what is beside the state in another state of the project, the name with the suffix after it", async () => {
    const store = gitlabStore(s);
    expect(gitlabBesideAddress(s, ".chant-unwritten")).toBe(`${s.address}.chant-unwritten`);
    expect(store.besideLocation(".chant-unwritten")).toBe(`${s.address}.chant-unwritten`);
    expect(await store.readBeside(".chant-unwritten")).toBeUndefined();
    await store.writeBeside(".chant-unwritten", state(8));
    expect(gl.states.get("prod.chant-unwritten")!.at(-1)!.serial).toBe(8);
    expect(JSON.parse((await store.readBeside(".chant-unwritten"))!)).toMatchObject({ serial: 8 });
    await store.removeBeside(".chant-unwritten");
    expect(gl.states.has("prod.chant-unwritten")).toBe(false);
    await store.removeBeside(".chant-unwritten");
  });
});

/** The store through the StateStore interface the other stores share. */
function stateStoreOf(g: GitLabState) {
  const store: ReturnType<typeof stateStore> = gitlabStore(g);
  return store;
}
