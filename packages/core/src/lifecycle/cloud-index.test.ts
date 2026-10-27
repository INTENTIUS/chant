// chant#4532: `chant index <substrate>` and `indexCloud`, moved from behold#1026.
// The refusal of every action flag, the default store location, the pipeline
// (typeListing, deriveEdges, a stamped write) over a fake lister, and that
// nothing is written outside the store. Nothing here opens a socket: the lister
// is faked, or the real one runs over a fake fetcher.
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFetcher, json, refusingChains } from "../cloud-lister/fakes";
import type { ParsedArgs } from "../cli/registry";
import {
  ACTION_FLAGS,
  CLOUD_INDEX_FLOOR,
  chantUserStoreDir,
  findChantProject,
  indexCloud,
  IndexUsageError,
  listCloud,
  parseIndexArgs,
  planIndexStore,
  runCloudIndex,
  scopeAndTarget,
  type CloudScope,
  type IndexStore,
  type ListingResult,
  type RunCloudIndexOptions,
  type StorePlan,
  type SubstrateTarget,
} from "./cloud-index";
import type { IndexDocument } from "./index-document";
import { NEXT_RELEASE } from "../release-floors";
import { createSnapshotStore } from "./snapshot-store";

const ACCOUNT = "000000000000";
const ENDPOINT = "http://localhost:4566";
const EMULATOR_ENV = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" };

function listing(scope: CloudScope, startedAt: string): ListingResult {
  const at = startedAt;
  const res = (listedType: string, nativeId: string, properties: Record<string, unknown>) => {
    const location = listedType.startsWith("AWS::IAM::") ? "global" : "us-east-1";
    return {
      id: `aws/${scope.scopeId}/${location}/${listedType}/${nativeId}`,
      listedType,
      location,
      nativeId,
      cloudIds: [{ kind: "import-id" as const, value: nativeId }],
      tags: {},
      properties,
      observedAt: at,
      facts: { cloudIds: [{ kind: "import-id" as const, value: nativeId }], observedAt: at },
    };
  };
  return {
    listing: "v1",
    source: { name: "chant-lister", version: "test" },
    scope,
    startedAt: at,
    completedAt: at,
    resources: [
      res("AWS::S3::Bucket", "web-assets", { BucketName: "web-assets", Arn: "arn:aws:s3:::web-assets" }),
      res("AWS::IAM::Role", "app-role", { RoleName: "app-role", Arn: `arn:aws:iam::${scope.scopeId}:role/app-role` }),
    ],
    coverage: [
      { listedType: "AWS::IAM::Role", location: "global", verdict: "listed" },
      { listedType: "AWS::S3::Bucket", location: "us-east-1", verdict: "listed" },
    ],
    notes: [],
  };
}

/** A lister that records what it was asked and answers {@link listing}, one second later each call. */
function fakeLister(start = "2026-10-26T12:00:00.000Z") {
  const calls: Array<{ scope: CloudScope; target: SubstrateTarget }> = [];
  let t = Date.parse(start);
  return {
    calls,
    list: async (scope: CloudScope, target: SubstrateTarget) => {
      calls.push({ scope, target });
      const at = new Date(t).toISOString();
      t += 1000;
      return listing(scope, at);
    },
  };
}

/** A store that keeps writes in memory, and records each plan it was opened for. */
function fakeStore() {
  const writes: IndexDocument[] = [];
  const opened: StorePlan[] = [];
  const store: IndexStore = {
    kind: "local",
    where: "fake-store",
    writable: true,
    async writeIndex(doc) {
      writes.push(doc);
      const name = `${doc.stamp.observedAt.replace(/[-:]|\.\d{3}/g, "")}-${doc.stamp.digest.slice(0, 12)}.json`;
      return { written: true, path: `${doc.stamp.scopeKey}/${name}` };
    },
    async listIndex() {
      return [];
    },
  };
  return {
    writes,
    opened,
    openStore: async (plan: StorePlan) => {
      opened.push(plan);
      return store;
    },
  };
}

function tempTree() {
  const root = mkdtempSync(join(tmpdir(), "chant-index-"));
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  for (const d of [cwd, home, xdg]) mkdirSync(d, { recursive: true });
  return { root, cwd, home, xdg };
}

/** Every file under `root`, relative and sorted. */
function files(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(root, rel)).sort()) {
    const r = rel ? join(rel, n) : n;
    if (statSync(join(root, r)).isDirectory()) out.push(...files(root, r));
    else out.push(r);
  }
  return out;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
}

const noLexicons: RunCloudIndexOptions["lexicons"] = async () => ({ lexicons: [] });

describe("the floor", () => {
  it("names the next release", () => {
    expect(CLOUD_INDEX_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("chant index refuses every action flag", () => {
  it("names the flag, wherever it sits and in either form", () => {
    for (const flag of ACTION_FLAGS) {
      for (const argv of [["aws", flag], [flag, "aws"], ["aws", "--account", ACCOUNT, `${flag}=1`]]) {
        let caught: unknown;
        try {
          parseIndexArgs(argv);
        } catch (e) {
          caught = e;
        }
        expect(caught, `${argv.join(" ")}`).toBeInstanceOf(IndexUsageError);
        expect((caught as IndexUsageError).actionFlag).toBe(flag);
        expect((caught as Error).message).toMatch(/read-only/);
      }
    }
  });

  it("the action flags include every action verb", () => {
    for (const f of ["--apply", "--deploy", "--destroy", "--rollback", "--op", "--approve", "--enable-api", "--yes"]) expect(ACTION_FLAGS).toContain(f);
  });

  it("stops before the lister or the store is touched", async () => {
    const t = tempTree();
    const store = fakeStore();
    const lister = fakeLister();
    const io = capture();
    let lexiconLookups = 0;
    for (const flag of ACTION_FLAGS) {
      const code = await runCloudIndex(["aws", "--account", ACCOUNT, "--regions", "us-east-1", flag], {
        cwd: t.cwd,
        home: t.home,
        env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
        stdout: io.stdout,
        stderr: io.stderr,
        list: lister.list,
        openStore: store.openStore,
        lexicons: async () => {
          lexiconLookups++;
          return { lexicons: [] };
        },
      });
      expect(code, flag).toBe(2);
    }
    expect(store.opened).toEqual([]);
    expect(lexiconLookups).toBe(0);
    expect(lister.calls).toEqual([]);
    expect(store.writes).toEqual([]);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toMatch(/chant index is read-only and refuses --apply/);
    expect(files(t.root)).toEqual([]);
  });

  it("the registry entry refuses an action flag core's parser kept", async () => {
    const { runIndexCommand } = await import("../cli/handlers/index-cloud");
    const args = { command: "index", path: "aws", positionals: ["aws"], format: "", fix: false, watch: false, verbose: false, help: false, live: false, yes: true } as unknown as ParsedArgs;
    const code = await runIndexCommand({ args, plugins: [], serializers: [] });
    expect(code).toBe(2);
  });

  it("an unknown flag is a usage error, not a pass", () => {
    expect(() => parseIndexArgs(["aws", "--frobnicate"])).toThrow(/unknown argument/);
    expect(() => parseIndexArgs(["--account", ACCOUNT])).toThrow(/needs a substrate/);
    expect(() => parseIndexArgs(["cloudflare"])).toThrow(/unknown substrate/);
  });

  it("names the caller's command", () => {
    expect(() => parseIndexArgs(["aws", "--apply"], "behold index")).toThrow(/^behold index is read-only and refuses --apply/);
  });
});

describe("chant index over a fake lister", () => {
  it("lists the scope asked for, types it, derives edges and writes one version", async () => {
    const t = tempTree();
    const store = fakeStore();
    const lister = fakeLister();
    const io = capture();
    const code = await runCloudIndex(
      ["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1,eu-west-1", "--types", "AWS::S3::Bucket,AWS::IAM::Role", "--tag", "team=web"],
      { cwd: t.cwd, home: t.home, env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg }, stdout: io.stdout, stderr: io.stderr, list: lister.list, openStore: store.openStore, lexicons: noLexicons },
    );
    expect(io.err).toEqual([]);
    expect(code).toBe(0);
    expect(lister.calls).toHaveLength(1);
    expect(lister.calls[0].scope).toEqual({
      substrate: "aws",
      scopeId: ACCOUNT,
      locations: ["us-east-1", "eu-west-1"],
      types: ["AWS::S3::Bucket", "AWS::IAM::Role"],
      tagFilter: { team: "web" },
    });
    expect(lister.calls[0].target).toEqual({ substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } } });
    // The default store is the per-user one (no project, no --store).
    expect(store.opened).toEqual([{ kind: "user", dir: join(t.xdg, "chant") }]);
    expect(store.writes).toHaveLength(1);
    const doc = store.writes[0];
    // chant's typeListing ran: path-style ids, kept as unknown kind with no lexicon.
    expect(doc.graph.nodes.map((n) => n.id).sort()).toEqual([`aws/${ACCOUNT}/global/AWS::IAM::Role/app-role`, `aws/${ACCOUNT}/us-east-1/AWS::S3::Bucket/web-assets`]);
    expect(doc.graph.nodes.every((n) => n.unmappedKind === true)).toBe(true);
    expect(doc.stamp.source).toMatchObject({ kind: "cloud", name: "chant-lister" });
    const text = io.out.join("");
    expect(text).toMatch(/2 nodes \(0 typed, 2 of unknown kind\), 0 derived edges/);
    expect(text).toMatch(/^chant index: wrote \d{8}T\d{6}Z-[0-9a-f]{12}\.json under cloud\/aws\/000000000000\/\S+ in fake-store$/m);
  });

  it("a second run writes a second version", async () => {
    const t = tempTree();
    const store = fakeStore();
    const lister = fakeLister();
    const opts: RunCloudIndexOptions = { cwd: t.cwd, home: t.home, env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg }, stdout: () => {}, stderr: () => {}, list: lister.list, openStore: store.openStore, lexicons: noLexicons };
    expect(await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], opts)).toBe(0);
    expect(await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], opts)).toBe(0);
    expect(store.writes.map((d) => d.stamp.observedAt)).toEqual(["2026-10-26T12:00:00.000Z", "2026-10-26T12:00:01.000Z"]);
  });

  it("--json prints one object with the verdict fields", async () => {
    const t = tempTree();
    const store = fakeStore();
    const io = capture();
    const code = await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1", "--json"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      list: fakeLister().list,
      openStore: store.openStore,
      lexicons: noLexicons,
    });
    expect(code).toBe(0);
    const summary = JSON.parse(io.out.join(""));
    expect(summary).toMatchObject({ substrate: "aws", scopeId: ACCOUNT, written: true, nodes: 2, coverage: { listed: 2, notObserved: 0 } });
  });

  it("with an endpoint and no static credentials it is refused, and no SDK chain is asked", async () => {
    const t = tempTree();
    const store = fakeStore();
    const chains = refusingChains();
    const fake = fakeFetcher(() => undefined);
    const io = capture();
    const code = await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      cwd: t.cwd,
      home: t.home,
      env: { XDG_DATA_HOME: t.xdg },
      stdout: io.stdout,
      stderr: io.stderr,
      listOptions: { fetcher: fake.fetcher, chains, retryDelays: [] },
      openStore: store.openStore,
      lexicons: noLexicons,
    });
    expect(code).toBe(2);
    expect(io.err.join("")).toMatch(/needs static credentials/);
    expect(chains.count).toEqual({ aws: 0, azure: 0, gcp: 0 });
    expect(fake.calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it("the command itself writes nothing: with a fake store the tree is unchanged", async () => {
    const t = tempTree();
    const store = fakeStore();
    await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      cwd: t.cwd,
      home: t.home,
      env: { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg },
      stdout: () => {},
      stderr: () => {},
      list: fakeLister().list,
      openStore: store.openStore,
      lexicons: noLexicons,
    });
    expect(store.writes).toHaveLength(1);
    expect(files(t.root)).toEqual([]);
  });

  it("a read-only store is refused before anything is listed", async () => {
    const lister = fakeLister();
    const io = capture();
    const ro: IndexStore = { kind: "orphan-branch", where: "chant/lifecycle", writable: false, writeIndex: async () => ({ written: false }), listIndex: async () => [] };
    const code = await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      env: EMULATOR_ENV,
      stdout: io.stdout,
      stderr: io.stderr,
      list: lister.list,
      openStore: async () => ro,
      lexicons: noLexicons,
    });
    expect(code).toBe(2);
    expect(lister.calls).toEqual([]);
    expect(io.err.join("")).toMatch(/read-only/);
  });
});

describe("indexCloud, the library function", () => {
  it("runs list, typeListing, deriveEdges and one write, and returns all three", async () => {
    const store = fakeStore();
    const lister = fakeLister();
    const scope: CloudScope = { substrate: "aws", scopeId: ACCOUNT, locations: ["us-east-1"], types: "*" };
    const target: SubstrateTarget = { substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } } };
    const s = await store.openStore({ kind: "user", dir: "/unused" });
    const r = await indexCloud({ scope, target, store: s, lexicons: [], version: "9.9.9" }, { list: lister.list });
    expect(lister.calls).toEqual([{ scope, target }]);
    expect(r.listing.resources).toHaveLength(2);
    expect(r.doc.stamp.scopeKey.startsWith(`cloud/aws/${ACCOUNT}/`)).toBe(true);
    expect(r.write.written).toBe(true);
    expect(store.writes).toEqual([r.doc]);
  });

  it("types through a lexicon's listedTypes and runs its catalog", async () => {
    const store = fakeStore();
    const s = await store.openStore({ kind: "user", dir: "/unused" });
    // A lexicon whose kind for every AWS type is the type itself, with an empty catalog.
    const lexicon = {
      name: "aws",
      listedTypes: { substrate: "aws" as const, kindFor: (t: string) => t },
      referenceCatalog: { identities: [], refs: [] },
    };
    const r = await indexCloud(
      {
        scope: { substrate: "aws", scopeId: ACCOUNT, locations: ["us-east-1"], types: "*" },
        target: { substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } } },
        store: s,
        lexicons: [lexicon],
      },
      { list: fakeLister().list },
    );
    expect(r.doc.graph.nodes.map((n) => n.kind).sort()).toEqual(["AWS::IAM::Role", "AWS::S3::Bucket"]);
    expect(r.doc.graph.nodes.some((n) => n.unmappedKind === true)).toBe(false);
    // Whatever a catalog draws is derived; an empty one draws nothing.
    expect(r.doc.graph.edges).toEqual([]);
  });

  it("a store whose write throws is an IndexWriteError, after the listing", async () => {
    const { IndexWriteError } = await import("./cloud-index");
    const boom: IndexStore = { kind: "local", where: "x", writable: true, writeIndex: async () => { throw new Error("disk full"); }, listIndex: async () => [] };
    await expect(
      indexCloud(
        { scope: { substrate: "aws", scopeId: ACCOUNT, locations: ["us-east-1"], types: "*" }, target: { substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "t", secretAccessKey: "t" } } }, store: boom, lexicons: [] },
        { list: fakeLister().list },
      ),
    ).rejects.toBeInstanceOf(IndexWriteError);
  });
});

describe("scope and target from flags and the environment", () => {
  const deps = { cwd: "/w", home: "/h" };
  it("aws takes its region from AWS_REGION and its endpoint from AWS_ENDPOINT_URL", () => {
    const { scope, target } = scopeAndTarget(parseIndexArgs(["aws", "--account", ACCOUNT]), { ...deps, env: { ...EMULATOR_ENV, AWS_REGION: "us-west-2", AWS_ENDPOINT_URL: ENDPOINT } });
    expect(scope).toEqual({ substrate: "aws", scopeId: ACCOUNT, locations: ["us-west-2"], types: "*" });
    expect(target).toEqual({ substrate: "aws", aws: { endpoint: ENDPOINT, credentials: { accessKeyId: "test", secretAccessKey: "test" } } });
  });
  it("azure and gcp read chant's token variables", () => {
    const az = scopeAndTarget(parseIndexArgs(["azure", "--subscription", "s", "--endpoint", "https://localhost:4577"]), { ...deps, env: { CHANT_AZURE_TOKEN: "a" } });
    expect(az.target).toEqual({ substrate: "azure", azure: { endpoint: "https://localhost:4577", token: "a" } });
    const g = scopeAndTarget(parseIndexArgs(["gcp", "--project", "p", "--endpoint", "http://localhost:4588/cloudasset"]), { ...deps, env: { CHANT_GCP_TOKEN: "g" } });
    expect(g.target).toEqual({ substrate: "gcp", gcp: { endpoint: "http://localhost:4588/cloudasset", token: "g" } });
  });
  it("gcp --anonymous sends no token, and needs an endpoint", () => {
    const { target } = scopeAndTarget(parseIndexArgs(["gcp", "--project", "plc-corpus", "--endpoint", "http://localhost:4588/cloudasset", "--anonymous"]), { ...deps, env: {} });
    expect(target).toEqual({ substrate: "gcp", gcp: { endpoint: "http://localhost:4588/cloudasset", token: null } });
    expect(() => parseIndexArgs(["gcp", "--project", "p", "--anonymous"])).toThrow(/needs --endpoint/);
  });
  it("needs a scope id, and skips TLS checks only on loopback", () => {
    expect(() => scopeAndTarget(parseIndexArgs(["azure"]), { ...deps, env: {} })).toThrow(/--subscription/);
    expect(() => scopeAndTarget(parseIndexArgs(["azure", "--subscription", "s", "--endpoint", "https://management.azure.com", "--insecure-skip-verify"]), { ...deps, env: {} })).toThrow(/loopback/);
  });
});

describe("the default store location (behold#1025 Q4)", () => {
  it("is chant's per-user data directory", () => {
    expect(chantUserStoreDir({ XDG_DATA_HOME: "/x" }, "/h")).toBe(join("/x", "chant"));
    expect(chantUserStoreDir({}, "/h")).toBe(join("/h", ".local", "share", "chant"));
    expect(chantUserStoreDir({ XDG_DATA_HOME: "relative" }, "/h")).toBe(join("/h", ".local", "share", "chant"));
    expect(chantUserStoreDir({ CHANT_INDEX_DIR: "/d/index" }, "/h")).toBe("/d");
    expect(() => chantUserStoreDir({ CHANT_INDEX_DIR: "/d/elsewhere" }, "/h")).toThrow(/must end in \/index/);
  });

  it("is used with no project and no --store, wherever the command runs", () => {
    const none = () => false;
    const dflt = () => chantUserStoreDir({ XDG_DATA_HOME: "/x" }, "/h");
    expect(planIndexStore({ cwd: "/a/b", env: {}, defaultStoreDir: dflt, exists: none })).toEqual({ kind: "user", dir: join("/x", "chant") });
    expect(planIndexStore({ cwd: "/elsewhere", env: {}, defaultStoreDir: dflt, exists: none })).toEqual({ kind: "user", dir: join("/x", "chant") });
  });

  it("is the caller's when it passes one (behold's userIndexDir parent)", async () => {
    const store = fakeStore();
    await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1"], {
      command: "behold index",
      defaultStoreDir: () => "/x/behold",
      env: EMULATOR_ENV,
      cwd: "/",
      exists: () => false,
      stdout: () => {},
      stderr: () => {},
      list: fakeLister().list,
      openStore: store.openStore,
      lexicons: noLexicons,
    });
    expect(store.opened).toEqual([{ kind: "user", dir: "/x/behold" }]);
  });

  it("gives way to a chant project's store, and to --store", () => {
    const exists = (p: string) => p === join("/proj", "chant.config.ts");
    const dflt = () => "/unused";
    expect(findChantProject(join("/proj", "sub"), exists)).toBe("/proj");
    expect(planIndexStore({ cwd: join("/proj", "sub"), env: {}, defaultStoreDir: dflt, exists })).toEqual({ kind: "project", projectDir: "/proj" });
    const local = planIndexStore({ store: "local:out", cwd: "/w", env: {}, defaultStoreDir: dflt, exists });
    expect(local).toMatchObject({ kind: "spec", configured: { store: "local" }, env: { CHANT_SNAPSHOT_STORE: "local", CHANT_SNAPSHOT_STORE_DIR: join("/w", "out") } });
    const s3 = planIndexStore({ store: "s3://bucket/some/prefix/", cwd: "/w", env: {}, defaultStoreDir: dflt });
    expect(s3).toMatchObject({ kind: "spec", env: { CHANT_SNAPSHOT_STORE: "s3", CHANT_SNAPSHOT_S3_BUCKET: "bucket", CHANT_SNAPSHOT_S3_PREFIX: "some/prefix" } });
    expect(planIndexStore({ store: "git-ref:refs/x", cwd: "/w", env: {}, defaultStoreDir: dflt })).toMatchObject({ configured: { store: "git-ref", ref: "refs/x" } });
    expect(() => planIndexStore({ store: "orphan-branch", cwd: "/w", env: {}, defaultStoreDir: dflt })).toThrow(/read-only/);
    expect(() => planIndexStore({ store: "ftp://x", cwd: "/w", env: {}, defaultStoreDir: dflt })).toThrow(/not a store spec/);
  });
});

describe("chant index with the real local store", () => {
  it("writes only under the per-user store, and two runs give two versions under one scope.json", async () => {
    const t = tempTree();
    const lister = fakeLister();
    const env = { ...EMULATOR_ENV, XDG_DATA_HOME: t.xdg };
    const opts: RunCloudIndexOptions = { cwd: t.cwd, home: t.home, env, stdout: () => {}, stderr: () => {}, list: lister.list, lexicons: noLexicons, exists: () => false };
    const argv = ["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1", "--types", "AWS::S3::Bucket,AWS::IAM::Role"];
    expect(await runCloudIndex(argv, opts)).toBe(0);
    expect(await runCloudIndex(argv, opts)).toBe(0);

    const all = files(t.root);
    const storeIndex = relative(t.root, join(t.xdg, "chant", "index")) + sep;
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.startsWith(storeIndex), f).toBe(true);
    expect(files(t.cwd)).toEqual([]);
    expect(files(t.home)).toEqual([]);

    const versions = all.filter((f) => /\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(f));
    expect(versions).toHaveLength(2);
    expect(all.filter((f) => f.endsWith(`${sep}scope.json`))).toHaveLength(1);
    expect(versions.every((v) => v.includes(`${sep}cloud${sep}aws${sep}${ACCOUNT}${sep}`))).toBe(true);

    const store = createSnapshotStore({ store: "local", dir: join(t.xdg, "chant") }, { cwd: t.cwd });
    const scopeKey = relative(storeIndex, versions[0]).split(sep).slice(0, -1).join("/");
    expect(await store.listIndex(scopeKey)).toHaveLength(2);
  });
});

describe("the real lister through the command", () => {
  it("lists over a fake fetcher with static credentials and sends only reads", async () => {
    const store = fakeStore();
    const fake = fakeFetcher(() => json(200, { TypeName: "AWS::S3::Bucket", ResourceDescriptions: [] }));
    const chains = refusingChains();
    const code = await runCloudIndex(["aws", "--endpoint", ENDPOINT, "--account", ACCOUNT, "--regions", "us-east-1", "--types", "AWS::S3::Bucket"], {
      env: EMULATOR_ENV,
      cwd: "/",
      exists: () => false,
      stdout: () => {},
      stderr: () => {},
      listOptions: { fetcher: fake.fetcher, chains, retryDelays: [] },
      openStore: store.openStore,
      lexicons: noLexicons,
    });
    expect(code).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].headers["x-amz-target"] ?? fake.calls[0].headers["X-Amz-Target"]).toBe("CloudApiService.ListResources");
    expect(chains.count).toEqual({ aws: 0, azure: 0, gcp: 0 });
    expect(store.writes).toHaveLength(1);
  });
});

// listCloud is the lister's own export, re-exported for library callers.
it("re-exports the lister", () => {
  expect(typeof listCloud).toBe("function");
});
