import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { gcpPlugin } from "./plugin";
import { observeResourcesDeepGcp } from "./deep-observe";
import { gcpDeepNormalizationHooks, GCP_READ_ONLY_NAMES, GCP_SERVICE_DEFAULTS } from "./deep-observe-hooks";
import type { DeepNode } from "@intentius/chant/deep-observation";

/**
 * The deep reader is on GCP REST now, not kubectl (#1209), so these stub
 * `fetch`. What they mostly assert is the consequence of that: a REST payload
 * carries no field ownership, so the noise rules are a static table rather than
 * a per-resource managed-fields prune.
 */
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

const node = (over: Partial<DeepNode>): DeepNode =>
  ({ entityType: "GCP::Storage::Bucket", path: "x", pattern: "x", key: "x", value: undefined, side: "live", counterpart: "unknown", ...over }) as DeepNode;

function entities(records: Array<[string, string, Record<string, unknown>]>) {
  return new Map(records.map(([n, t, p]) => [n, { entityType: t, props: p }]));
}

async function observe(e: ReturnType<typeof entities>, opts: { owned?: boolean } = {}) {
  return observeResourcesDeepGcp({ environment: "local", entityNames: [...e.keys()], entities: e, ...opts });
}

describe("gcpPlugin wiring", () => {
  test("exposes the deep-observe contract, sharing the static hook instance", () => {
    expect(gcpPlugin.observeResourcesDeep).toBeTypeOf("function");
    expect(gcpPlugin.deepNormalizationHooks).toBe(gcpDeepNormalizationHooks);
  });
});

describe("gcpDeepNormalizationHooks — the static rules (#1209)", () => {
  test("prunes server-assigned fields wherever they appear, on either side", () => {
    for (const name of ["etag", "selfLink", "id", "timeCreated", "generation"]) {
      expect(GCP_READ_ONLY_NAMES.has(name)).toBe(true);
      expect(gcpDeepNormalizationHooks.prune!(node({ pattern: `spec.${name}`, side: "live" }))).toBe(true);
      expect(gcpDeepNormalizationHooks.prune!(node({ pattern: name, side: "declared" }))).toBe(true);
    }
  });

  test("prunes a provider default ONLY where source never declared it", () => {
    const undeclared = node({ pattern: "storageClass", value: "STANDARD", side: "live", counterpart: "absent" });
    expect(gcpDeepNormalizationHooks.prune!(undeclared)).toBe(true);

    // Declared: a change away from it must still surface, so it is not pruned.
    const declared = node({ pattern: "storageClass", value: "STANDARD", side: "live", counterpart: "present" });
    expect(gcpDeepNormalizationHooks.prune!(declared)).toBe(false);
  });

  test("does not prune a value that merely shares a default's path", () => {
    const different = node({ pattern: "storageClass", value: "NEARLINE", side: "live", counterpart: "absent" });
    expect(gcpDeepNormalizationHooks.prune!(different)).toBe(false);
  });

  test("defaults are per kind, not global", () => {
    expect(GCP_SERVICE_DEFAULTS.StorageBucket).toBeDefined();
    const wrongKind = node({ entityType: "GCP::PubSub::Topic", pattern: "storageClass", value: "STANDARD", side: "live", counterpart: "absent" });
    expect(gcpDeepNormalizationHooks.prune!(wrongKind)).toBe(false);
  });

  test("no per-resource ownership hook — a REST payload carries none to drive one", () => {
    // The CNRM path layered a managedFields prune under these rules. There is
    // nothing to layer now, which is why the static table has to be enough.
    expect(Object.keys(gcpDeepNormalizationHooks)).toEqual(["prune"]);
  });
});

describe("observeResourcesDeepGcp — over REST (#1209)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.GOOGLE_CLOUD_PROJECT = "my-project";
    process.env.GCP_ENDPOINT_URL = "http://localhost:4588";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GCP_ENDPOINT_URL;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  test("reads the property tree over the applier's URL, pruning server noise", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { id: "b/my-bucket", name: "my-bucket", etag: "abc", selfLink: "https://…", storageClass: "NEARLINE", location: "US" }),
    );
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "my-bucket" } }]]));

    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4588/storage/v1/b/my-bucket");
    const props = out.resources.b.properties as Record<string, Record<string, unknown>>;

    // Reshaped into the CNRM shape the declared source is written in — without
    // this every field drifts twice, once as `spec.x -> <absent>` and once as
    // `x -> <undeclared>`.
    expect(props.spec.storageClass).toBe("NEARLINE");
    expect(props.spec.location).toBe("US");
    expect(props.metadata.name).toBe("my-bucket");

    // Server-assigned, pruned wherever they landed.
    expect(props.spec.etag).toBeUndefined();
    expect(props.spec.selfLink).toBeUndefined();
    expect(props.spec.id).toBeUndefined();
  });

  test("chant's own ownership labels are not drift", async () => {
    // The applier stamps them, so reporting them back is chant showing its own
    // signature to itself — the correction #1301 made for AWS.
    fetchMock.mockResolvedValue(reply(200, { name: "x", labels: { "managed-by": "chant", team: "data" } }));
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "x" } }]]));
    const meta = (out.resources.b.properties as Record<string, Record<string, Record<string, unknown>>>).metadata;
    expect(meta.labels["managed-by"]).toBeUndefined();
    // A user's own label is still a fact worth diffing.
    expect(meta.labels.team).toBe("data");
  });

  test("a 404 is an absence the thin read already reported, not restated here", async () => {
    fetchMock.mockResolvedValue(reply(404, {}));
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "gone" } }]]));
    expect(out.resources.b).toBeUndefined();
    expect(out.unobserved?.b).toBeUndefined();
  });

  test("a 403 is a hole with a reason, never silence", async () => {
    fetchMock.mockResolvedValue(reply(403, {}));
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "x" } }]]));
    expect(out.unobserved?.b?.reason).toBe("no-credentials");
  });

  test("a kind the applier cannot write is unsupported-kind, and is never queried", async () => {
    const out = await observe(entities([["e", "GCP::Compute::Address", { metadata: { name: "a" } }]]));
    expect(out.unobserved?.e?.reason).toBe("unsupported-kind");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("--owned withholds an unmarked object as filtered, not absent", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "b/x", labels: { team: "other" } }));
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "x" } }]]), { owned: true });
    expect(out.unobserved?.b?.reason).toBe("filtered");
    expect(out.resources.b).toBeUndefined();
  });

  test("--owned keeps an object carrying the marker the applier stamps", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "b/x", labels: { "managed-by": "chant" } }));
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "x" } }]]), { owned: true });
    expect(out.resources.b).toBeDefined();
  });

  test("--owned passes through a kind whose payload has no labels to filter on", async () => {
    fetchMock.mockResolvedValue(reply(200, { name: "projects/my-project/topics/t" }));
    const out = await observe(entities([["t", "GCP::PubSub::Topic", { metadata: { name: "t" } }]]), { owned: true });
    expect(out.resources.t).toBeDefined();
    expect(out.unobserved?.t).toBeUndefined();
  });

  test("reads concurrently", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    await observe(
      entities([
        ["a", "GCP::Storage::Bucket", { metadata: { name: "a" } }],
        ["b", "GCP::Storage::Bucket", { metadata: { name: "b" } }],
      ]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
