/**
 * The index store (#4519): one conformance suite, run against every store.
 *
 * `git-ref`, `local` and `s3` keep what they are given; `none` keeps nothing
 * and every read is empty, which is every reader's fallback. The s3 store
 * runs against an in-process fake (`fakeS3` below): nothing leaves the
 * process, and no credential chain is read.
 */
import { afterEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotStore, snapshotReadPort, snapshotStoreConfig, SNAPSHOT_REF, type SnapshotStore } from "./snapshot-store";
import { resolveS3Credentials, type S3Fetch } from "./snapshot-store-s3";
import { indexDocumentDigest, indexScopeKey, type IndexDocument, type IndexScope } from "./index-document";
import { writeSnapshot } from "./git";
import { GRAPH_IR_VERSION } from "../graph-ir";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `snapshot-store-${name}-`)));
  dirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(name = "repo"): string {
  const dir = tmp(name);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

function hasRef(dir: string, ref: string): boolean {
  try {
    git(["rev-parse", "--verify", "-q", ref], dir);
    return true;
  } catch {
    return false;
  }
}

const snap = (resources: Record<string, unknown>, timestamp = "2026-10-26T00:00:00.000Z") =>
  JSON.stringify({ lexicon: "aws", environment: "prod", commit: "c0ffee", timestamp, resources });

const scope: IndexScope = { kind: "cloud", substrate: "aws", scopeId: "123456789012", locations: ["us-west-2", "us-east-1"], types: "*" };

function indexDoc(observedAt: string, nodes: string[] = ["a"]): IndexDocument {
  const graph = { version: GRAPH_IR_VERSION, nodes: nodes.map((id) => ({ id, kind: "AWS::S3::Bucket", lexicon: "aws" })), edges: [] } as unknown as IndexDocument["graph"];
  const coverage = [{ listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" as const }];
  return {
    index: "v1",
    stamp: {
      source: { kind: "cloud", name: "behold-lister" },
      scope,
      scopeKey: indexScopeKey(scope),
      observedAt,
      digest: indexDocumentDigest({ graph, coverage }),
    },
    coverage,
    graph,
  };
}

/**
 * An in-memory S3 with versioning on, path-style, speaking just the calls the
 * medium makes. Every request must carry a SigV4 header for the given key id.
 */
function fakeS3(accessKeyId: string): { fetch: S3Fetch; requests: string[] } {
  const objects = new Map<string, Array<{ versionId: string; body: string; at: string }>>();
  const requests: string[] = [];
  let n = 0;
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const res = (status: number, body = "", headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    text: async () => body,
  });
  const fetch: S3Fetch = async (url, init) => {
    requests.push(`${init.method} ${url}`);
    if (!init.headers.authorization?.includes(`Credential=${accessKeyId}/`)) return res(403, "<Error>unsigned</Error>");
    const u = new URL(url);
    const [, _bucket, ...rest] = u.pathname.split("/");
    const key = rest.map(decodeURIComponent).join("/");
    if (init.method === "PUT") {
      const versions = objects.get(key) ?? [];
      if (init.headers["if-none-match"] === "*" && versions.length > 0) return res(412);
      const versionId = `v${++n}`;
      versions.push({ versionId, body: init.body ?? "", at: new Date(Date.UTC(2026, 9, 26, 0, 0, n)).toISOString() });
      objects.set(key, versions);
      return res(200, "", { "x-amz-version-id": versionId });
    }
    if (key !== "") {
      const versions = objects.get(key);
      if (!versions) return res(404);
      const want = u.searchParams.get("versionId");
      const v = want ? versions.find((x) => x.versionId === want) : versions[versions.length - 1];
      return v ? res(200, v.body) : res(404);
    }
    const prefix = u.searchParams.get("prefix") ?? "";
    if (u.searchParams.has("versions")) {
      const rows = [...objects].filter(([k]) => k.startsWith(prefix)).flatMap(([k, vs]) =>
        vs.map((v, i) => `<Version><Key>${xml(k)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>${i === vs.length - 1}</IsLatest><LastModified>${v.at}</LastModified></Version>`),
      );
      return res(200, `<ListVersionsResult><IsTruncated>false</IsTruncated>${rows.join("")}</ListVersionsResult>`);
    }
    const contents: string[] = [];
    const prefixes = new Set<string>();
    for (const k of objects.keys()) {
      if (!k.startsWith(prefix)) continue;
      const tail = k.slice(prefix.length);
      const slash = tail.indexOf("/");
      if (slash >= 0) prefixes.add(prefix + tail.slice(0, slash + 1));
      else contents.push(`<Contents><Key>${xml(k)}</Key></Contents>`);
    }
    return res(200, `<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${xml(p)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`);
  };
  return { fetch, requests };
}

interface Subject {
  name: string;
  make: () => { store: SnapshotStore; cwd?: string };
  /** False for `none`: writes are dropped and reads are empty. */
  persists: boolean;
  /** Whether an older snapshot version stays readable after a newer write. */
  keepsHistory: boolean;
}

const subjects: Subject[] = [
  {
    name: "git-ref",
    make: () => {
      const cwd = repo();
      return { store: createSnapshotStore({ store: "git-ref" }, { cwd }), cwd };
    },
    persists: true,
    keepsHistory: true,
  },
  {
    name: "local",
    make: () => {
      const cwd = tmp("local");
      return { store: createSnapshotStore({ store: "local", dir: "store" }, { cwd }), cwd };
    },
    persists: true,
    keepsHistory: false,
  },
  {
    name: "s3 (fake)",
    make: () => {
      const cwd = repo("s3");
      const { fetch } = fakeS3("AKIDTEST");
      const store = createSnapshotStore(
        { store: "s3", bucket: "chant-index", prefix: "team/chant", endpoint: "http://127.0.0.1:4566", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" } },
        { cwd, fetch, env: {} },
      );
      return { store, cwd };
    },
    persists: true,
    keepsHistory: true,
  },
  {
    name: "none",
    make: () => ({ store: createSnapshotStore({ store: "none" }) }),
    persists: false,
    keepsHistory: false,
  },
];

describe.each(subjects)("index store conformance: $name", ({ make, persists, keepsHistory }) => {
  test("a snapshot written is the latest read, and an absent key reads null", async () => {
    const { store, cwd } = make();
    const at = cwd ? { cwd } : undefined;
    const w = await store.write("prod", "aws", snap({ bucket: {} }), at);
    expect(w.written).toBe(persists);
    expect(await store.readLatest("prod", "aws", at)).toBe(persists ? snap({ bucket: {} }) : null);
    expect(await store.readLatest("prod", "gcp", at)).toBeNull();
    expect(await store.readLatest("staging", "aws", at)).toBeNull();
  });

  test("a later write replaces the latest, and history keeps the earlier one where the store keeps history", async () => {
    const { store, cwd } = make();
    const at = cwd ? { cwd } : undefined;
    const first = await store.write("prod", "aws", snap({ one: {} }), at);
    await store.write("prod", "aws", snap({ two: {} }), at);
    expect(await store.readLatest("prod", "aws", at)).toBe(persists ? snap({ two: {} }) : null);
    const history = await store.list({ ...(at ?? {}), environment: "prod" });
    if (!persists) {
      expect(history).toEqual([]);
      return;
    }
    expect(history.length).toBeGreaterThanOrEqual(keepsHistory ? 2 : 1);
    if (keepsHistory) {
      expect(first.version).toBeDefined();
      expect(await store.readAt("prod", "aws", first.version!, at)).toBe(snap({ one: {} }));
    } else {
      expect(await store.readAt("prod", "aws", "latest", at)).toBe(snap({ two: {} }));
    }
  });

  test("keys and environments list what is there, never the index family", async () => {
    const { store, cwd } = make();
    const at = cwd ? { cwd } : undefined;
    await store.write("prod", "aws", snap({}), at);
    await store.write("prod", "web__aws", snap({}), at);
    await store.write("staging", "aws", snap({}), at);
    await store.writeIndex(indexDoc("2026-10-26T01:00:00.000Z"));
    expect(await store.keys("prod", at)).toEqual(persists ? ["aws", "web__aws"] : []);
    expect(await store.environments(at)).toEqual(persists ? ["prod", "staging"] : []);
    const port = snapshotReadPort(store, at);
    expect(await port.trees()).toEqual(persists ? ["prod", "staging"] : []);
    expect(await port.list("prod")).toEqual(persists ? ["aws.json", "web__aws.json"] : []);
  });

  test("a workspace member's snapshots are its own", async () => {
    const { store, cwd } = make();
    const base = cwd ? { cwd } : {};
    await store.write("prod", "aws", snap({ api: {} }), { ...base, member: "api" });
    expect(await store.readLatest("prod", "aws", { ...base, member: "api" })).toBe(persists ? snap({ api: {} }) : null);
    expect(await store.readLatest("prod", "aws", { ...base, member: "." })).toBeNull();
  });

  test("an index version is written once, listed in time order, and never overwritten", async () => {
    const { store } = make();
    const first = indexDoc("2026-10-26T01:00:00.000Z", ["a"]);
    const second = indexDoc("2026-10-26T02:00:00.000Z", ["a", "b"]);
    const w1 = await store.writeIndex(first);
    expect(w1.written).toBe(persists);
    expect(w1.path ?? "").toMatch(persists ? /20261026T010000Z-[0-9a-f]{12}\.json$/ : /.*/);
    // The same read again is the same version: refused, not overwritten.
    expect((await store.writeIndex(first)).written).toBe(false);
    await store.writeIndex(second);
    const key = first.stamp.scopeKey;
    const versions = await store.listIndex(key);
    if (!persists) {
      expect(versions).toEqual([]);
      expect(await store.readIndexLatest(key)).toBeNull();
      return;
    }
    expect(versions).toHaveLength(2);
    expect(versions[0] < versions[1]).toBe(true);
    expect(await store.readIndexAt(key, versions[0])).toEqual(first);
    expect(await store.readIndexLatest(key)).toEqual(second);
    expect(await store.readIndexScope(key)).toEqual(scope);
    expect(await store.readIndexAt(key, "not-a-version.json")).toBeNull();
  });

  test("a stamp whose scopeKey is not its scope's is refused before anything is written", async () => {
    const { store } = make();
    const doc = indexDoc("2026-10-26T01:00:00.000Z");
    await expect(store.writeIndex({ ...doc, stamp: { ...doc.stamp, scopeKey: "cloud/aws/elsewhere" } })).rejects.toThrow(/scopeKey/);
    expect(await store.listIndex("cloud/aws/elsewhere")).toEqual([]);
  });
});

describe("the git-ref store", () => {
  test("writes refs/chant/snapshots and creates no chant/lifecycle branch", async () => {
    const cwd = repo();
    const store = createSnapshotStore(snapshotStoreConfig(undefined, {}), { cwd });
    expect(store.kind).toBe("git-ref");
    await store.write("prod", "aws", snap({}), { cwd });
    await store.writeIndex(indexDoc("2026-10-26T01:00:00.000Z"));
    expect(hasRef(cwd, SNAPSHOT_REF)).toBe(true);
    expect(hasRef(cwd, "refs/heads/chant/lifecycle")).toBe(false);
    // Indexes sit under `_index/` on the same ref.
    expect(git(["ls-tree", "--name-only", SNAPSHOT_REF], cwd).split("\n").sort()).toEqual(["_index", "prod"]);
    // The working tree and HEAD are untouched.
    expect(git(["status", "--porcelain"], cwd)).toBe("");
  });

  test("snapshots written to chant/lifecycle before #4519 stay readable, and are never written there again", async () => {
    const cwd = repo();
    await writeSnapshot("prod", "aws", snap({ legacy: {} }), { cwd });
    const legacyTip = git(["rev-parse", "refs/heads/chant/lifecycle"], cwd);
    const store = createSnapshotStore({ store: "git-ref" }, { cwd });
    expect(await store.readLatest("prod", "aws", { cwd })).toBe(snap({ legacy: {} }));
    expect(await store.keys("prod", { cwd })).toEqual(["aws"]);
    expect((await store.list({ cwd })).length).toBe(1);
    await store.write("prod", "aws", snap({ fresh: {} }), { cwd });
    expect(await store.readLatest("prod", "aws", { cwd })).toBe(snap({ fresh: {} }));
    expect(git(["rev-parse", "refs/heads/chant/lifecycle"], cwd)).toBe(legacyTip);
  });

  test("the orphan-branch store is read-only", async () => {
    const cwd = repo();
    await writeSnapshot("prod", "aws", snap({ legacy: {} }), { cwd });
    const store = createSnapshotStore({ store: "orphan-branch" }, { cwd });
    expect(store.writable).toBe(false);
    expect((await store.write("prod", "aws", snap({}), { cwd })).written).toBe(false);
    expect(await store.readLatest("prod", "aws", { cwd })).toBe(snap({ legacy: {} }));
  });

  test("publish pushes the ref, a clone fetches it, and two writers' snapshots both land", async () => {
    const remote = tmp("remote");
    git(["init", "-q", "--bare", "-b", "main"], remote);
    const a = repo("a");
    git(["remote", "add", "origin", remote], a);
    git(["push", "-q", "origin", "main"], a);
    const b = tmp("b");
    git(["clone", "-q", remote, b], tmpdir());
    git(["config", "user.email", "b@chant.dev"], b);
    git(["config", "user.name", "B"], b);

    const storeA = createSnapshotStore({ store: "git-ref", readOrphanBranch: false }, { cwd: a });
    const storeB = createSnapshotStore({ store: "git-ref", readOrphanBranch: false }, { cwd: b });
    await storeA.write("prod", "aws", snap({ a: {} }), { cwd: a });
    expect((await storeA.publish()).status).toBe("pushed");
    // b wrote before seeing a's push: its publish rebases onto the remote.
    await storeB.write("staging", "aws", snap({ b: {} }), { cwd: b });
    expect((await storeB.publish()).status).toBe("pushed");
    await storeA.fetch();
    expect(await storeA.readLatest("staging", "aws", { cwd: a })).toBe(snap({ b: {} }));
    expect(await storeA.readLatest("prod", "aws", { cwd: a })).toBe(snap({ a: {} }));
    expect(hasRef(remote, "refs/heads/chant/lifecycle")).toBe(false);
  });
});

describe("the s3 store's credentials", () => {
  test("against an endpoint it takes explicit credentials and never the default AWS chain", () => {
    const env = { AWS_ACCESS_KEY_ID: "AKIAREAL", AWS_SECRET_ACCESS_KEY: "real-secret" };
    expect(() => resolveS3Credentials({ bucket: "b", endpoint: "http://127.0.0.1:4566" }, env)).toThrow(/explicit credentials/);
    expect(resolveS3Credentials({ bucket: "b", endpoint: "http://127.0.0.1:4566", credentials: { accessKeyId: "test", secretAccessKey: "test" } }, env).accessKeyId).toBe("test");
    expect(resolveS3Credentials({ bucket: "b", endpoint: "http://127.0.0.1:4566" }, { ...env, CHANT_SNAPSHOT_S3_ACCESS_KEY_ID: "store", CHANT_SNAPSHOT_S3_SECRET_ACCESS_KEY: "s" }).accessKeyId).toBe("store");
  });

  test("a store built for an emulator signs every request with the explicit key, to the endpoint only", async () => {
    const { fetch, requests } = fakeS3("test");
    const store = createSnapshotStore(
      { store: "s3", bucket: "b", endpoint: "http://127.0.0.1:4566", credentials: { accessKeyId: "test", secretAccessKey: "test" } },
      { cwd: tmp("s3-emulator"), fetch, env: { AWS_ACCESS_KEY_ID: "AKIAREAL", AWS_SECRET_ACCESS_KEY: "real-secret" } },
    );
    await store.write("prod", "aws", snap({}));
    await store.readLatest("prod", "aws");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.includes("http://127.0.0.1:4566/b/"))).toBe(true);
  });

  test("snapshots and indexes sit under the store's own prefix", async () => {
    const { fetch, requests } = fakeS3("k");
    const store = createSnapshotStore(
      { store: "s3", bucket: "b", prefix: "team/chant", endpoint: "http://127.0.0.1:4566", credentials: { accessKeyId: "k", secretAccessKey: "s" } },
      { cwd: tmp("s3-prefix"), fetch, env: {} },
    );
    await store.write("prod", "aws", snap({}));
    await store.writeIndex(indexDoc("2026-10-26T01:00:00.000Z"));
    const puts = requests.filter((r) => r.startsWith("PUT ")).map((r) => new URL(r.slice(4)).pathname);
    expect(puts[0]).toBe("/b/team/chant/snapshots/prod/aws.json");
    expect(puts.slice(1).every((p) => p.startsWith("/b/team/chant/index/cloud/aws/123456789012/"))).toBe(true);
  });
});

describe("store configuration", () => {
  test("the default is git-ref, and the environment overrides chant.config.ts", () => {
    expect(snapshotStoreConfig(undefined, {})).toEqual({ store: "git-ref" });
    expect(snapshotStoreConfig({ store: "local", dir: "x" }, {})).toEqual({ store: "local", dir: "x" });
    expect(snapshotStoreConfig({ store: "local", dir: "x" }, { CHANT_SNAPSHOT_STORE: "none" })).toEqual({ store: "none" });
    expect(snapshotStoreConfig(undefined, { CHANT_SNAPSHOT_STORE: "s3", CHANT_SNAPSHOT_S3_BUCKET: "b", CHANT_SNAPSHOT_S3_ENDPOINT: "http://127.0.0.1:4566" })).toEqual({
      store: "s3",
      bucket: "b",
      endpoint: "http://127.0.0.1:4566",
    });
    expect(() => snapshotStoreConfig({ store: "bucket" }, {})).toThrow(/not one of/);
    expect(() => snapshotStoreConfig({ store: "s3" }, {})).toThrow(/needs a bucket/);
  });

  test("a local store with no dir lives under .chant/store", async () => {
    const cwd = tmp("default-local");
    const store = createSnapshotStore({ store: "local" }, { cwd });
    await store.write("prod", "aws", snap({}));
    expect(existsSync(join(cwd, ".chant", "store", "snapshots", "prod", "aws.json"))).toBe(true);
  });
});
