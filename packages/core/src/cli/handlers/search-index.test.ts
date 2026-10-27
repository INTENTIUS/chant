import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs } from "../registry";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import { createMockPlugin } from "../../../../test-utils/src/mock-plugin";
import { NO_LEXICON_DETECTED_MESSAGE } from "../../detectLexicon";
import type { DeclaredIdentity, IndexIdentity } from "../../lifecycle/identity-match";
import type { IndexDocument } from "../../lifecycle/index-document";
import { typeListing, type ListedResource, type ListingResult } from "../../lifecycle/type-listing";
import { fakeSnapshotStore } from "../../lifecycle/snapshot-store-fake";

// #4525: `chant search --index <ref>` answers from an index version in the
// store: the declared rows joined to it, each with its verdict, or the index
// alone with no project. No cloud is read; the store is a fake holding one
// fixture version typed the way behold#1026 writes one.

const discoverMock = vi.fn();
vi.mock("../../discovery/index", () => ({
  discover: (...a: unknown[]) => discoverMock(...a),
}));
const loadPluginsMock = vi.fn();
const resolveLexMock = vi.fn();
vi.mock("../plugins", async () => {
  const actual = await vi.importActual<typeof import("../plugins")>("../plugins");
  return {
    ...actual,
    loadPlugins: (...a: unknown[]) => loadPluginsMock(...a),
    resolveProjectLexicons: (...a: unknown[]) => resolveLexMock(...a),
  };
});
const loadChantConfigMock = vi.fn();
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...a: unknown[]) => loadChantConfigMock(...a) };
});
const storeMock = vi.fn();
vi.mock("../../lifecycle/snapshot-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/snapshot-store")>("../../lifecycle/snapshot-store");
  return { ...actual, resolveSnapshotStore: (...a: unknown[]) => Promise.resolve(storeMock(...a)) };
});
const liveRead = vi.fn();

import searchSchema from "../../workspace/search.schema.json";
import { contract } from "../../workspace/__fixtures__/contract-repo";
const { expectValid } = contract(searchSchema);
const { runSearch } = await import("./search");

const PARTS: Record<string, string[]> = { "Store::Bucket": ["BucketName"] };
const identity: IndexIdentity = {
  substrate: "aws",
  declaredIdentity(entityType, props): DeclaredIdentity {
    const parts = PARTS[entityType];
    if (entityType === "Queue::Queue") return { kind: "unmatchable", reason: "no-binding", detail: "the queue URL is assigned by the service" };
    if (!parts) return { kind: "unmatchable", reason: "unsupported-kind", detail: `${entityType} has no primary identifier on record` };
    const v = props[parts[0]];
    if (typeof v !== "string") return { kind: "unmatchable", reason: "no-binding", detail: "identity is not in the declaration" };
    return { kind: "identifier", listedType: entityType, identifier: v, global: false };
  },
};

const r = (listedType: string, nativeId: string, properties: Record<string, unknown>, tags: Record<string, string> = {}): ListedResource => ({
  listedType,
  location: "us-east-1",
  nativeId,
  cloudIds: [{ kind: "import-id", value: nativeId }],
  tags,
  properties,
  observedAt: "2026-10-26T09:00:01.000Z",
});
const listing: ListingResult = {
  listing: "v1",
  source: { name: "behold-lister", version: "0.0.0-test" },
  scope: { substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: ["Store::Bucket", "Queue::Queue"] },
  startedAt: "2026-10-26T09:00:00.000Z",
  completedAt: "2026-10-26T09:00:04.000Z",
  resources: [
    r("Store::Bucket", "shop-assets", { BucketName: "shop-assets", Arn: "arn:aws:s3:::shop-assets" }, { team: "web" }),
    r("Store::Bucket", "made-by-hand", { BucketName: "made-by-hand" }, { team: "data" }),
    r("Queue::Queue", "https://sqs.us-east-1.amazonaws.com/000000000000/orders", { QueueName: "orders" }),
  ],
  coverage: [
    { listedType: "Store::Bucket", location: "us-east-1", verdict: "listed" },
    { listedType: "Queue::Queue", location: "us-east-1", verdict: "listed" },
  ],
  notes: [],
};
const doc: IndexDocument = typeListing(listing, [{ name: "fake", listedTypes: { substrate: "aws", kindFor: (t) => t } }]);
const KEY = doc.stamp.scopeKey;
const indexStore = fakeSnapshotStore({
  readIndexLatest: async (k) => (k === KEY ? doc : null),
  readIndexAt: async () => null,
});

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

function makeArgs(overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command: "search", path: "kind:Bucket",
    format: "", fix: false, watch: false, verbose: false, help: false, live: false, index: KEY,
    ...overrides,
  };
}

const plugin = { ...createMockPlugin({ name: "fake", describeResources: async (...a: unknown[]) => liveRead(...a) }), indexIdentity: identity };

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(s); });
  vi.spyOn(console, "error").mockImplementation((s: string) => { err.push(s); });
  discoverMock.mockReset();
  loadPluginsMock.mockReset();
  resolveLexMock.mockReset();
  loadChantConfigMock.mockReset();
  storeMock.mockReset();
  storeMock.mockReturnValue(indexStore);
  liveRead.mockReset();
});

describe("search --index with no project", () => {
  beforeEach(() => {
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockRejectedValue(new Error(NO_LEXICON_DETECTED_MESSAGE));
    loadPluginsMock.mockResolvedValue([]);
  });

  test("answers from the index alone, each row an indexed node, with the stamp on the provenance line", async () => {
    expect(await runSearch({ args: makeArgs(), plugins: [], serializers: [] })).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("aws/000000000000/us-east-1/Store::Bucket/made-by-hand  Store::Bucket  made-by-hand");
    expect(stdout).toContain("aws/000000000000/us-east-1/Store::Bucket/shop-assets  Store::Bucket  shop-assets");
    expect(stdout).not.toContain("Queue::Queue");
    expect(stdout).toMatch(/— index only, no project · cloud\/aws\/000000000000\/[0-9a-f]{12}@20261026T090000Z-[0-9a-f]{12} taken 2026-10-26T09:00:00.000Z by behold-lister 0.0.0-test · 2 rows/);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  test("a tag: term reads an indexed node's tag map", async () => {
    expect(await runSearch({ args: makeArgs({ path: "tag:team=data" }), plugins: [], serializers: [] })).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("made-by-hand");
    expect(stdout).not.toContain("shop-assets  ");
  });

  test("--json is a search document whose source is the index version", async () => {
    expect(await runSearch({ args: makeArgs({ json: true }), plugins: [], serializers: [] })).toBe(0);
    const json = JSON.parse(out.join(""));
    expectValid(json);
    expect(json.source).toMatchObject({ kind: "index", scopeKey: KEY, observedAt: "2026-10-26T09:00:00.000Z", digest: doc.stamp.digest, project: false });
    expect(json.matches.map((m: { id: string }) => m.id)).toEqual([
      "aws/000000000000/us-east-1/Store::Bucket/made-by-hand",
      "aws/000000000000/us-east-1/Store::Bucket/shop-assets",
    ]);
    expect(json.matches[0].displayId).toBe(json.matches[0].id);
    expect(json.matches[0].join).toBeUndefined();
  });

  test("an empty answer still names the version it read", async () => {
    expect(await runSearch({ args: makeArgs({ path: "kind:Bucket attr:BucketName=nothing-like-this" }), plugins: [], serializers: [] })).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("(no matches)");
    expect(stdout).toContain("— index only, no project");
  });
});

describe("search --index with a project", () => {
  const east = new Map<string, Declarable>([
    ["assets", decl({ lexicon: "fake", entityType: "Store::Bucket", props: { BucketName: "shop-assets" } })],
    ["archive", decl({ lexicon: "fake", entityType: "Store::Bucket", props: { BucketName: "never-made" } })],
    ["orders", decl({ lexicon: "fake", entityType: "Queue::Queue", props: { QueueName: "orders" } })],
  ]);

  beforeEach(() => {
    loadChantConfigMock.mockResolvedValue({ config: { stacks: [{ name: "east", region: "us-east-1", src: "east" }] } });
    resolveLexMock.mockResolvedValue(["fake"]);
    loadPluginsMock.mockResolvedValue([plugin]);
    discoverMock.mockResolvedValue({ entities: east, errors: [], sourceFiles: [] });
  });

  test("declared rows join through the lexicon's index match, each row showing its verdict, and nothing reads live", async () => {
    expect(await runSearch({ args: makeArgs(), plugins: [], serializers: [] })).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("assets  Store::Bucket  shop-assets");
    expect(stdout).toContain("archive  Store::Bucket  (absent)");
    // An indexed bucket no declaration binds is not a declared row.
    expect(stdout).not.toContain("made-by-hand");
    expect(stdout).toMatch(/— observed from index cloud\/aws\/000000000000\/[0-9a-f]{12}@20261026T090000Z-[0-9a-f]{12} taken 2026-10-26T09:00:00.000Z · bound 1\/2 · absent 1/);
    expect(liveRead).not.toHaveBeenCalled();
  });

  test("a declaration with no identity to match is no-binding, never absent", async () => {
    expect(await runSearch({ args: makeArgs({ path: "kind:Queue" }), plugins: [], serializers: [] })).toBe(0);
    const stdout = out.join("\n");
    expect(stdout).toContain("orders  Queue::Queue  (no-binding)");
    expect(stdout).toContain("bound 0/1 · no-binding 1");
  });

  test("--json carries each row's join and validates against the search schema", async () => {
    expect(await runSearch({ args: makeArgs({ path: "kind:Store::Bucket", json: true, show: "Arn" }), plugins: [], serializers: [] })).toBe(0);
    const json = JSON.parse(out.join(""));
    expectValid(json);
    expect(json.source).toMatchObject({ kind: "index", project: true });
    const byId = Object.fromEntries(json.matches.map((m: { id: string }) => [m.id, m]));
    expect(byId["east::assets"]).toMatchObject({
      physicalId: "shop-assets",
      show: { Arn: "arn:aws:s3:::shop-assets" },
      join: { verdict: "bound", node: "aws/000000000000/us-east-1/Store::Bucket/shop-assets", nativeId: "shop-assets" },
    });
    expect(byId["east::archive"]).toMatchObject({ join: { verdict: "absent", identifier: "never-made", location: "us-east-1" } });
    expect(byId["east::archive"].physicalId).toBeUndefined();
    expect(json.provenance).toContain("bound 1/2 · absent 1");
  });
});

describe("search --index refusals", () => {
  beforeEach(() => {
    loadChantConfigMock.mockResolvedValue({ config: {} });
    resolveLexMock.mockRejectedValue(new Error(NO_LEXICON_DETECTED_MESSAGE));
    loadPluginsMock.mockResolvedValue([]);
  });

  test("--index with --live, --snapshot or --ambient is refused before anything is read", async () => {
    for (const extra of [{ live: true, env: "dev" }, { snapshot: "latest", env: "dev" }, { ambient: true }] as Partial<ParsedArgs>[]) {
      out = [];
      expect(await runSearch({ args: makeArgs({ ...extra, json: true }), plugins: [], serializers: [] })).toBe(1);
      const json = JSON.parse(out.join(""));
      expectValid(json);
      expect(json.error.code).toBe("usage-invalid");
      expect(json.error.message).toContain("--index or");
    }
    expect(storeMock).not.toHaveBeenCalled();
  });

  test("a ref that is not a scope key is usage-invalid, with the shape in the hint", async () => {
    expect(await runSearch({ args: makeArgs({ index: "my-account", json: true }), plugins: [], serializers: [] })).toBe(1);
    const json = JSON.parse(out.join(""));
    expectValid(json);
    expect(json.error).toMatchObject({ code: "usage-invalid", hint: expect.stringContaining("scope key") });
  });

  test("a scope key the store holds nothing under is index-unavailable", async () => {
    expect(await runSearch({ args: makeArgs({ index: "cloud/aws/111111111111/0123456789ab", json: true }), plugins: [], serializers: [] })).toBe(1);
    const json = JSON.parse(out.join(""));
    expectValid(json);
    expect(json.error.code).toBe("index-unavailable");
    expect(json.error.message).toContain("cloud/aws/111111111111/0123456789ab");
  });

  test("a version the store does not hold is index-unavailable", async () => {
    expect(await runSearch({ args: makeArgs({ index: `${KEY}@20261026T090000Z-ffffffffffff` }), plugins: [], serializers: [] })).toBe(1);
    expect(err.join("\n")).toContain("no index version 20261026T090000Z-ffffffffffff");
  });
});
