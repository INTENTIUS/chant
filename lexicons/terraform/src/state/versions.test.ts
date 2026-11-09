/**
 * #4793: a state store's version reads on each backend chant reads (s3, gcs,
 * azurerm, a GitLab-managed http backend and local), the version an apply
 * leaves (`readStateVersion`), and every version a store keeps
 * (`listStateVersions`). Each store is in memory behind the fetch the store
 * calls; no bucket, container or GitLab is reached.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LOCKABLE_BACKENDS, LOCKS, isRefused, lockRefusal, readableStateObject, stateObject, type LockableState } from "./backend";
import type { StoreFetch } from "./object-store";
import { stateStore } from "./store";
import { keepsHistory, listStateVersions, readStateVersion, stateVersionSource } from "./versions";

type Answer = Awaited<ReturnType<StoreFetch>>;
const answer = (status = 200, body = "", headers: Record<string, string> = {}): Answer => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 300, status, text: async () => body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null, forEach: (fn: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => fn(v, k)) } as Answer["headers"] };
};

const at = (m: number): string => `2026-11-09T12:${String(m).padStart(2, "0")}:00.000Z`;

/** A root whose data dir records `type` and `config`, as init leaves it. */
function initialised(type: string, config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-versions-"));
  mkdirSync(join(dir, ".terraform"));
  writeFileSync(join(dir, ".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type, config } }));
  return dir;
}

/** A versioned S3 bucket in memory, path-style at http://s3.test/<bucket>/<key>, with ListObjectVersions; unversioned when `versioning` is false. */
function fakeS3(versioning = true) {
  const objects = new Map<string, Array<{ id: string; body: string; when: string }>>();
  const seen: string[] = [];
  let n = 0;
  const put = (key: string, body: string): string => {
    const id = versioning ? `v${++n}` : "";
    objects.set(key, [...(versioning ? (objects.get(key) ?? []) : []), { id, body, when: at(++n) }]);
    return id;
  };
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.slice(1));
    const vid = u.searchParams.get("versionId");
    seen.push(`${init.method} ${path}${vid ? `?${vid}` : ""}`);
    if (u.searchParams.has("versions")) {
      const prefix = `${path}${u.searchParams.get("prefix")}`;
      const blocks = [...objects].filter(([k]) => k.startsWith(prefix)).flatMap(([k, vs]) => vs.map((v, i) => `<Version><Key>${k.slice(path.length)}</Key><VersionId>${v.id || "null"}</VersionId><IsLatest>${i === vs.length - 1}</IsLatest><LastModified>${v.when}</LastModified></Version>`));
      return answer(200, `<ListVersionsResult>${blocks.join("")}<IsTruncated>false</IsTruncated></ListVersionsResult>`);
    }
    const all = objects.get(path) ?? [];
    const v = vid ? all.find((x) => x.id === vid) : all.at(-1);
    if (!v) return answer(404);
    return answer(200, init.method === "HEAD" ? "" : v.body, v.id ? { "x-amz-version-id": v.id } : {});
  };
  return { put, fetch, seen };
}

/** GCS's JSON API in memory, at http://gcs.test: objects by generation, object versioning on unless `versioning` is false, and the object listing. */
function fakeGcs(versioning = true) {
  const objects = new Map<string, { generation: string; body: string; when: string }[]>();
  let n = 1000;
  const put = (key: string, body: string): string => {
    const generation = String(++n);
    objects.set(key, [...(versioning ? (objects.get(key) ?? []) : []), { generation, body, when: at(n - 1000) }]);
    return generation;
  };
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    const gen = u.searchParams.get("generation");
    let m = /^\/storage\/v1\/b\/([^/]+)$/.exec(u.pathname);
    if (m) return answer(200, JSON.stringify({ versioning: { enabled: versioning } }));
    m = /^\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (m && init.method === "GET") {
      const prefix = `${m[1]}/${u.searchParams.get("prefix")}`;
      const items = [...objects].filter(([k]) => k.startsWith(prefix)).flatMap(([k, vs]) => vs.map((v, i) => ({ name: k.slice(m![1]!.length + 1), generation: v.generation, timeCreated: v.when, ...(i < vs.length - 1 ? { timeDeleted: at(59) } : {}) })));
      return answer(200, JSON.stringify({ items }));
    }
    m = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(u.pathname);
    if (!m) return answer(404);
    const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
    const found = gen ? objects.get(key)?.find((o) => o.generation === gen) : objects.get(key)?.at(-1);
    if (!found) return answer(404);
    if (u.searchParams.get("alt") === "media") return answer(200, found.body, { "x-goog-generation": found.generation });
    return answer(200, JSON.stringify({ name: m[2], generation: found.generation }));
  };
  return { put, fetch };
}

/**
 * Azure Blob Storage in memory, at `host`: blobs with snapshots (and version
 * ids when `versions`), and List Blobs with include=versions.
 */
function fakeAzure(versions = false, host = "acme.blob.core.windows.net") {
  type Blob = { body: string; snapshots: { id: string; body: string }[]; versions: { id: string; body: string; when: string }[] };
  const blobs = new Map<string, Blob>();
  let n = 0;
  const stamp = (): string => `2026-11-09T12:00:${String(++n).padStart(2, "0")}.0000000Z`;
  const write = (key: string, body: string): string => {
    const b = blobs.get(key);
    const id = stamp();
    blobs.set(key, { body, snapshots: b?.snapshots ?? [], versions: [...(b?.versions ?? []), { id, body, when: new Date(Date.UTC(2026, 10, 9, 12, n)).toUTCString() }] });
    return id;
  };
  const fetch: StoreFetch = async (url, init) => {
    const u = new URL(url);
    if (u.host !== host) return answer(404);
    const comp = u.searchParams.get("comp");
    if (comp === "list") {
      const prefix = `${u.pathname.slice(1)}/${u.searchParams.get("prefix")}`;
      const listed = versions ? [...blobs].filter(([k]) => k.startsWith(prefix)).flatMap(([k, b]) => b.versions.map((v, i) => `<Blob><Name>${k.slice(k.indexOf("/") + 1)}</Name><VersionId>${v.id}</VersionId>${i === b.versions.length - 1 ? "<IsCurrentVersion>true</IsCurrentVersion>" : ""}<Properties><Last-Modified>${v.when}</Last-Modified></Properties></Blob>`)) : [];
      return answer(200, `<EnumerationResults><Blobs>${listed.join("")}</Blobs><NextMarker /></EnumerationResults>`);
    }
    const key = decodeURIComponent(u.pathname.slice(1));
    const b = blobs.get(key);
    if (init.method === "PUT" && comp === "snapshot") {
      if (!b) return answer(404);
      const id = stamp();
      b.snapshots.push({ id, body: b.body });
      return answer(201, "", { "x-ms-snapshot": id });
    }
    const snap = u.searchParams.get("snapshot");
    const ver = u.searchParams.get("versionid");
    if (!b) return answer(404);
    const found = snap ? b.snapshots.find((s) => s.id === snap) : ver ? b.versions.find((v) => v.id === ver) : { body: b.body };
    if (!found) return answer(404);
    const headers: Record<string, string> = { etag: `"${b.body.length}"`, "x-ms-lease-state": "available", ...(versions && !snap ? { "x-ms-version-id": ver ?? b.versions.at(-1)!.id } : {}) };
    return answer(200, init.method === "HEAD" ? "" : found.body, headers);
  };
  return { blobs, write, fetch };
}

/** GitLab's Terraform state API in memory, for project 7 at http://gitlab.test: versions by serial. */
function fakeGitLab() {
  const versions: Array<{ serial: number; body: string }> = [];
  const fetch: StoreFetch = async (url, init) => {
    const m = new URL(url).pathname.match(/^\/api\/v4\/projects\/7\/terraform\/state\/net(\/versions\/(\d+))?$/);
    if (!m) return answer(404);
    const v = m[2] !== undefined ? versions.find((x) => String(x.serial) === m[2]) : versions.at(-1);
    if (!v) return answer(404);
    return answer(200, init.method === "HEAD" ? "" : v.body);
  };
  const put = (serial: number) => versions.push({ serial, body: JSON.stringify({ version: 4, serial, lineage: "l", resources: [] }) });
  return { put, fetch };
}

const AWS = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const S3_CONFIG = { bucket: "acme-state", key: "app.tfstate", endpoints: { s3: "http://s3.test" }, use_lockfile: true };
const GCS_CONFIG = { bucket: "acme-state", prefix: "app", storage_custom_endpoint: "http://gcs.test/storage/v1/", access_token: "tok" };
const AZ_CONFIG = { storage_account_name: "acme", container_name: "tfstate", key: "app.tfstate", access_key: Buffer.from("key").toString("base64") };
const GITLAB_ADDRESS = "http://gitlab.test/api/v4/projects/7/terraform/state/net";
const GITLAB_CONFIG = { address: GITLAB_ADDRESS, lock_address: `${GITLAB_ADDRESS}/lock`, unlock_address: `${GITLAB_ADDRESS}/lock`, username: "gitlab-ci-token", password: "glcbt" };

/** The store of the root initialised with `type` and `config`. */
function storeOf(dir: string, env: NodeJS.ProcessEnv, fetch: StoreFetch) {
  const o = stateObject(dir, env);
  if (isRefused(o)) throw new Error(o.reason);
  return stateStore(o as LockableState, dir, fetch);
}

describe("a state store reads the state's versions", () => {
  test("s3: the object's version id, an older one by its id, and the bucket's list of them", async () => {
    const s3 = fakeS3();
    const v1 = s3.put("acme-state/app.tfstate", '{"serial":1}');
    const v2 = s3.put("acme-state/app.tfstate", '{"serial":2}');
    const store = storeOf(initialised("s3", S3_CONFIG), AWS, s3.fetch);
    expect(await store.version()).toEqual({ exists: true, versionId: v2 });
    expect(await store.hasVersion(v1)).toBe(true);
    expect(await store.hasVersion("v9")).toBe(false);
    expect(await store.readVersion(v1)).toBe('{"serial":1}');
    expect(await store.isAt(v2)).toBe(true);
    expect(await store.isAt(v1)).toBe(false);
    expect((await store.listVersions!()).map((v) => [v.version_id, v.latest])).toEqual([[v2, true], [v1, false]]);
  });

  test("s3: a bucket without versioning keeps only the latest state", async () => {
    const s3 = fakeS3(false);
    s3.put("acme-state/app.tfstate", "{}");
    const store = storeOf(initialised("s3", S3_CONFIG), AWS, s3.fetch);
    expect(await store.version()).toEqual({ exists: true, off: "bucket versioning is off for acme-state, so it keeps only the latest state" });
  });

  test("gcs: a generation, read by generation, and the listing of each", async () => {
    const g = fakeGcs();
    const g1 = g.put("acme-state/app/default.tfstate", '{"serial":1}');
    const g2 = g.put("acme-state/app/default.tfstate", '{"serial":2}');
    const store = storeOf(initialised("gcs", GCS_CONFIG), {}, g.fetch);
    expect(await store.version()).toEqual({ exists: true, versionId: g2 });
    expect(await store.hasVersion(g1)).toBe(true);
    expect(await store.readVersion(g1)).toBe('{"serial":1}');
    expect(await store.isAt(g2)).toBe(true);
    expect((await store.listVersions!()).map((v) => [v.version_id, v.latest])).toEqual([[g2, true], [g1, false]]);
    const off = fakeGcs(false);
    off.put("acme-state/app/default.tfstate", "{}");
    expect(await storeOf(initialised("gcs", GCS_CONFIG), {}, off.fetch).version()).toMatchObject({ off: "object versioning is off for acme-state, so it keeps only the latest state" });
  });

  test("azurerm: the blob's version id when the account keeps versions, and the list of them", async () => {
    const a = fakeAzure(true);
    const v1 = a.write("tfstate/app.tfstate", '{"serial":1}');
    const v2 = a.write("tfstate/app.tfstate", '{"serial":2}');
    const store = storeOf(initialised("azurerm", AZ_CONFIG), {}, a.fetch);
    expect(await store.version()).toEqual({ exists: true, versionId: v2 });
    expect(await store.hasVersion(v1)).toBe(true);
    expect(await store.readVersion(v1)).toBe('{"serial":1}');
    expect(await store.isAt(v1)).toBe(false);
    expect((await store.listVersions!()).map((v) => [v.version_id, v.latest])).toEqual([[v2, true], [v1, false]]);
  });

  test("azurerm: without versions, a snapshot names the state when pinned, and the state is at it while its text is the same", async () => {
    const a = fakeAzure();
    a.write("tfstate/app.tfstate", '{"serial":1}');
    const store = storeOf(initialised("azurerm", { ...AZ_CONFIG, snapshot: true }), {}, a.fetch);
    expect(await store.version()).toEqual({ exists: true, off: "the blob keeps no versions, and only a snapshot would name this one" });
    const pinned = await store.version(true);
    expect(pinned.versionId).toBe(a.blobs.get("tfstate/app.tfstate")!.snapshots[0]!.id);
    expect(await store.hasVersion(pinned.versionId!)).toBe(true);
    expect(await store.readVersion(pinned.versionId!)).toBe('{"serial":1}');
    expect(await store.isAt(pinned.versionId!)).toBe(true);
    a.write("tfstate/app.tfstate", '{"serial":2}');
    expect(await store.isAt(pinned.versionId!)).toBe(false);
    expect(await storeOf(initialised("azurerm", AZ_CONFIG), {}, a.fetch).version()).toMatchObject({ off: expect.stringContaining("takes no snapshots (snapshot = true)") });
  });

  test("azurerm: a backend that names a metadata_host gets its endpoint from that cloud's metadata", async () => {
    const a = fakeAzure(true, "acme.blob.core.example.test");
    const id = a.write("tfstate/app.tfstate", "{}");
    const fetch: StoreFetch = async (url, init) => (url.startsWith("https://meta.test/metadata/endpoints?") ? answer(200, JSON.stringify({ suffixes: { storage: "core.example.test" } })) : a.fetch(url, init));
    const o = stateObject(initialised("azurerm", { ...AZ_CONFIG, environment: "stack", metadata_host: "meta.test" }), {});
    expect(o).toMatchObject({ backend: "azurerm", metadataHost: "meta.test" });
    expect(await stateStore(o as LockableState, "", fetch).version()).toEqual({ exists: true, versionId: id });
    expect(stateObject(initialised("azurerm", { ...AZ_CONFIG, environment: "stack" }), {})).toMatchObject({ refused: "config", reason: expect.stringContaining("names no metadata_host") });
  });

  test("http: a GitLab-managed state's version id is its serial", async () => {
    const g = fakeGitLab();
    g.put(3);
    g.put(4);
    const store = storeOf(initialised("http", GITLAB_CONFIG), {}, g.fetch);
    expect(store.backend).toBe("http");
    expect(await store.version()).toEqual({ exists: true, versionId: "4" });
    expect(await store.hasVersion("3")).toBe(true);
    expect(await store.hasVersion("v3")).toBe(false);
    expect(await store.readVersion("3")).toContain('"serial":3');
    expect(await store.isAt("4")).toBe(true);
    expect(await store.isAt("3")).toBe(false);
    expect(store.listVersions).toBeUndefined();
  });

  test("local: keeps only the latest state, and lists none", async () => {
    const dir = initialised("local", {});
    writeFileSync(join(dir, "terraform.tfstate"), "{}");
    const store = storeOf(dir, {}, fakeS3().fetch);
    expect(await store.version()).toEqual({ exists: true, off: "a local backend keeps only the latest state" });
    expect(await store.hasVersion("1")).toBe(false);
    expect(await store.readVersion("1")).toBeUndefined();
    expect(store.listVersions).toBeUndefined();
  });

  test("a state export's version source reads a GitLab-managed state like the others", async () => {
    const g = fakeGitLab();
    g.put(5);
    const src = stateVersionSource(stateObject(initialised("http", GITLAB_CONFIG), {}), g.fetch);
    expect("refused" in src).toBe(false);
    if ("refused" in src) return;
    expect(src.location).toBe(GITLAB_ADDRESS);
    expect(await src.current()).toEqual({ exists: true, versionId: "5" });
  });
});

describe("an http backend is locked when it is a GitLab-managed state", () => {
  test("LOCKABLE_BACKENDS takes http, and the verdict refuses an http backend at any other address", () => {
    expect(LOCKABLE_BACKENDS).toContain("http");
    expect(LOCKS).toBe("chant locks and writes s3 (with use_lockfile = true), gcs, azurerm, local and GitLab-managed http states");
    expect(lockRefusal({ backend: { type: "http", config: { address: GITLAB_ADDRESS } } })).toBeUndefined();
    expect(lockRefusal({ backend: { type: "http", config: {} } }, { TF_HTTP_ADDRESS: GITLAB_ADDRESS })).toBeUndefined();
    expect(lockRefusal({ backend: { type: "http", config: { address: "https://state.example.test/net" } } })).toMatchObject({ refused: "backend", reason: expect.stringContaining("is not a GitLab project's state API") });
    expect(stateObject(initialised("http", GITLAB_CONFIG), {})).toMatchObject({ backend: "http", address: GITLAB_ADDRESS, lockAddress: `${GITLAB_ADDRESS}/lock` });
  });
});

describe("the version an apply leaves", () => {
  test("is the store's version id, read from metadata only, on each backend", async () => {
    const s3 = fakeS3();
    const v = s3.put("acme-state/app.tfstate", "{}");
    expect(await readStateVersion(initialised("s3", S3_CONFIG), AWS, { fetch: s3.fetch })).toEqual({ backend: "s3", location: "s3://acme-state/app.tfstate", version_id: v, versioning: "on" });
    expect(s3.seen).toEqual(["HEAD acme-state/app.tfstate"]);
    const g = fakeGcs();
    const gen = g.put("acme-state/app/default.tfstate", "{}");
    expect(await readStateVersion(initialised("gcs", GCS_CONFIG), {}, { fetch: g.fetch })).toEqual({ backend: "gcs", location: "gs://acme-state/app/default.tfstate", version_id: gen, versioning: "on" });
    const gl = fakeGitLab();
    gl.put(9);
    expect(await readStateVersion(initialised("http", GITLAB_CONFIG), {}, { fetch: gl.fetch })).toEqual({ backend: "http", location: GITLAB_ADDRESS, version_id: "9", versioning: "on" });
  });

  test("an azurerm blob without versions that the backend snapshots is named by a snapshot", async () => {
    const a = fakeAzure();
    a.write("tfstate/app.tfstate", "{}");
    const r = await readStateVersion(initialised("azurerm", { ...AZ_CONFIG, snapshot: true }), {}, { fetch: a.fetch });
    expect(r).toEqual({ backend: "azurerm", location: "az://acme/tfstate/app.tfstate", version_id: a.blobs.get("tfstate/app.tfstate")!.snapshots[0]!.id, versioning: "on" });
  });

  test("an s3 backend without use_lockfile is read all the same: a read holds no lock", async () => {
    const s3 = fakeS3();
    const v = s3.put("acme-state/app.tfstate", "{}");
    const dir = initialised("s3", { ...S3_CONFIG, use_lockfile: false, dynamodb_table: "locks" });
    expect(stateObject(dir, AWS)).toMatchObject({ refused: "no-lockfile" });
    expect(readableStateObject(dir, AWS)).toMatchObject({ backend: "s3", lockfile: false });
    expect(await readStateVersion(dir, AWS, { fetch: s3.fetch })).toMatchObject({ version_id: v, versioning: "on" });
  });

  test("off for a bucket without versioning, a local state and a backend that keeps no history; unknown with why otherwise; never throws", async () => {
    const off = fakeS3(false);
    off.put("acme-state/app.tfstate", "{}");
    expect(await readStateVersion(initialised("s3", S3_CONFIG), AWS, { fetch: off.fetch })).toMatchObject({ versioning: "off", note: expect.stringContaining("bucket versioning is off for acme-state") });
    expect(await readStateVersion(initialised("s3", S3_CONFIG), AWS, { fetch: fakeS3().fetch })).toMatchObject({ versioning: "unknown", note: "the state object is not in the bucket" });
    expect(await readStateVersion(initialised("s3", S3_CONFIG), AWS, { fetch: async () => answer(403, "<Error><Code>AccessDenied</Code></Error>") })).toMatchObject({ versioning: "unknown", note: expect.stringContaining("403") });
    expect(await readStateVersion(initialised("s3", S3_CONFIG), {}, { fetch: fakeS3().fetch })).toMatchObject({ versioning: "unknown", note: expect.stringContaining("no credentials") });
    expect(await readStateVersion(initialised("http", GITLAB_CONFIG), {}, { fetch: fakeGitLab().fetch })).toMatchObject({ backend: "http", versioning: "unknown", note: "GitLab holds no state at this address" });
    expect(await readStateVersion(mkdtempSync(join(tmpdir(), "chant-versions-")), {})).toEqual({ backend: "local", location: "terraform.tfstate", versioning: "off", note: "a local backend keeps only the latest state" });
    const pg = await readStateVersion(initialised("pg", { conn_str: "postgres://tf:secret@db.internal:5432/states", schema_name: "net" }), {});
    expect(pg).toMatchObject({ backend: "pg", versioning: "off", location: "pg:db.internal:5432/states/net.states", note: expect.stringContaining("which each write replaces") });
    expect(JSON.stringify(pg)).not.toContain("secret");
    expect(await readStateVersion(initialised("http", { address: "https://state.example.test/net" }), {})).toMatchObject({ backend: "http", versioning: "off", note: expect.stringContaining("names no versions") });
    expect(await readStateVersion(initialised("cos", { bucket: "b", prefix: "net" }), {})).toMatchObject({ backend: "cos", versioning: "unknown", note: "a cos backend can keep versions of the state, which chant does not read" });
    expect(await readStateVersion(initialised("remote", { organization: "acme", workspaces: [{ name: "net" }] }), {})).toMatchObject({ backend: "remote", versioning: "unknown", location: "remote:app.terraform.io/acme/net" });
    expect(keepsHistory({ type: "http", config: {} }, { TF_HTTP_ADDRESS: GITLAB_ADDRESS })).toBeUndefined();
  });

  test("a product's words name its keys in a credentials refusal, and `backend` stands in for the recorded one", async () => {
    const words = { hints: { gcp: "oidc.gcp", azure: "oidc.azure" } };
    expect(await readStateVersion(initialised("gcs", { bucket: "b" }), {}, { words })).toMatchObject({ backend: "gcs", versioning: "unknown", note: expect.stringContaining("give the job oidc.gcp") });
    expect(await readStateVersion(initialised("azurerm", { ...AZ_CONFIG, access_key: null }), {}, { words })).toMatchObject({ note: expect.stringContaining("give the job oidc.azure") });
    const s3 = fakeS3();
    const v = s3.put("acme-state/unit.tfstate", "{}");
    expect(await readStateVersion(mkdtempSync(join(tmpdir(), "chant-versions-")), AWS, { fetch: s3.fetch, backend: { type: "s3", config: { ...S3_CONFIG, key: "unit.tfstate" } } })).toMatchObject({ version_id: v });
  });
});

describe("every version a store keeps", () => {
  test("lists an s3, gcs or azurerm state's versions by the location a run recorded, newest first", async () => {
    const s3 = fakeS3();
    const v1 = s3.put("acme-state/app.tfstate", "{}");
    const v2 = s3.put("acme-state/app.tfstate", "{}");
    s3.put("acme-state/app.tfstate.tflock", "{}");
    const listed = await listStateVersions("s3://acme-state/app.tfstate", { ...AWS, AWS_ENDPOINT_URL: "http://s3.test" }, { fetch: s3.fetch });
    expect(listed).toMatchObject({ versions: [{ version_id: v2, latest: true }, { version_id: v1, latest: false }] });
    const a = fakeAzure(true);
    const id = a.write("tfstate/app.tfstate", "{}");
    expect(await listStateVersions("az://acme/tfstate/app.tfstate", { AZURE_STORAGE_KEY: Buffer.from("key").toString("base64") }, { fetch: a.fetch })).toMatchObject({ versions: [{ version_id: id, latest: true }] });
    // The job's own identity lists a gcs state's generations; with none, the list says so.
    expect(await listStateVersions("gs://acme-state/app/default.tfstate", {}, { words: { hints: { gcp: "oidc.gcp" } } })).toMatchObject({ error: expect.stringContaining("give the job oidc.gcp") });
  });

  test("skips a GitLab state, any other location and a store that lists none, and answers a failed list with why", async () => {
    expect(await listStateVersions(GITLAB_ADDRESS, {})).toEqual({ skipped: "GitLab's state API lists no versions of a state" });
    expect(await listStateVersions("terraform.tfstate", {})).toEqual({ skipped: "chant lists the versions of s3, gcs and azurerm states only" });
    expect(await listStateVersions("az://acme/tfstate", {})).toEqual({ skipped: "az://acme/tfstate names no blob" });
    expect(await listStateVersions("az://acme/tfstate/app.tfstate", { AZURE_STORAGE_KEY: "a2V5" }, { fetch: fakeAzure(false).fetch })).toEqual({ skipped: "the store lists no versions of the state" });
    expect(await listStateVersions("s3://acme-state/app.tfstate", AWS, { fetch: async () => answer(403, "<Error><Code>AccessDenied</Code></Error>") })).toMatchObject({ error: expect.stringContaining("403") });
    expect(await listStateVersions("s3://acme-state/app.tfstate", {}, { words: { setting: "reports.bucket" } })).toMatchObject({ error: expect.stringContaining("reports.bucket") });
  });
});
