import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { gcpPlugin } from "./plugin";
import { observeResourcesDeepGcp, toCnrmTree } from "./deep-observe";
import { gcpDeepNormalizationHooks, GCP_READ_ONLY_NAMES, GCP_SERVICE_DEFAULTS } from "./deep-observe-hooks";
import type { DeepNode } from "@intentius/chant/deep-observation";

/**
 * The deep reader is on GCP REST now, not kubectl (#1209), so these stub
 * `fetch`. What they mostly assert is the consequence of that: a REST payload
 * carries no field ownership, so the noise rules are a static table rather than
 * a per-resource managed-fields prune — plus the #1210 half of the port, the
 * per-kind mapping of each REST shape onto the declared CNRM vocabulary.
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

async function observe(e: ReturnType<typeof entities>, opts: { owned?: boolean; buildOutput?: string } = {}) {
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

  test("defaults are keyed by the CNRM kind, not a naive recasing of the entity type", () => {
    // `GCP::Pubsub::Subscription` names the kind `PubSubSubscription`; a naive
    // `${service}${shortKind}` gives `PubsubSubscription` and matches nothing.
    const defaulted = node({
      entityType: "GCP::Pubsub::Subscription",
      pattern: "ackDeadlineSeconds",
      value: 10,
      side: "live",
      counterpart: "absent",
    });
    expect(gcpDeepNormalizationHooks.prune!(defaulted)).toBe(true);
  });

  test("both ownership vocabularies are pruned — the serializer's k8s labels and the applier's GCP ones", () => {
    for (const pattern of [
      "metadata.labels.managed-by",
      "metadata.labels.chant-stack",
      "metadata.labels.chant-env",
      "metadata.labels.app.kubernetes.io/managed-by",
      "metadata.labels.chant.intentius.io/stack",
      "metadata.labels.chant.intentius.io/env",
    ]) {
      expect(gcpDeepNormalizationHooks.prune!(node({ pattern, side: "live" }))).toBe(true);
      expect(gcpDeepNormalizationHooks.prune!(node({ pattern, side: "declared" }))).toBe(true);
    }
  });

  test("declared-side CNRM machinery never reaches GCP and is not drift", () => {
    for (const pattern of ["projectRef", "resourceID", "metadata.annotations.cnrm.cloud.google.com/project-id"]) {
      expect(gcpDeepNormalizationHooks.prune!(node({ pattern, side: "declared" }))).toBe(true);
    }
    // A user's own annotation is still a fact worth diffing.
    expect(gcpDeepNormalizationHooks.prune!(node({ pattern: "metadata.annotations.team", side: "declared" }))).toBe(false);
  });

  test("an undeclared null or `{}` is GCP's spelling of unset, not drift", () => {
    const nullValue = node({ pattern: "description", value: null, side: "live", counterpart: "absent" });
    expect(gcpDeepNormalizationHooks.prune!(nullValue)).toBe(true);
    const husk = node({ pattern: "binaryAuthorization", value: {}, side: "live", counterpart: "absent" });
    expect(gcpDeepNormalizationHooks.prune!(husk)).toBe(true);
    // Declared, or carrying members, it is a value like any other.
    expect(gcpDeepNormalizationHooks.prune!(node({ pattern: "description", value: null, side: "live", counterpart: "present" }))).toBe(false);
    expect(gcpDeepNormalizationHooks.prune!(node({ pattern: "binaryAuthorization", value: { policy: "p" }, side: "live", counterpart: "absent" }))).toBe(false);
  });
});

describe("toCnrmTree — each REST shape in the declared vocabulary (#1210)", () => {
  const ctx = { project: "my-project" };

  test("a full resource path shortens to the declared name", () => {
    const tree = toCnrmTree("PubSubTopic", { name: "projects/my-project/topics/t", messageRetentionDuration: "86400s" }, ctx);
    expect(tree).toEqual({ metadata: { name: "t" }, messageRetentionDuration: "86400s" });
  });

  test("bucket: GCS's iamConfiguration and lifecycle map onto the CNRM field names", () => {
    const tree = toCnrmTree(
      "StorageBucket",
      {
        name: "b",
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
        lifecycle: { rule: [{ action: { type: "Delete" }, condition: { age: 30 } }] },
      },
      ctx,
    ) as Record<string, unknown>;
    expect(tree.uniformBucketLevelAccess).toBe(true);
    expect(tree.publicAccessPrevention).toBe("enforced");
    expect(tree.lifecycleRule).toEqual([{ action: { type: "Delete" }, condition: { age: 30 } }]);
    expect(tree.iamConfiguration).toBeUndefined();
    expect(tree.lifecycle).toBeUndefined();
  });

  test("subscription: a same-project topic path becomes topicRef.name, a foreign one topicRef.external", () => {
    const same = toCnrmTree("PubSubSubscription", { name: "projects/my-project/subscriptions/s", topic: "projects/my-project/topics/t" }, ctx) as Record<string, unknown>;
    expect(same.topicRef).toEqual({ name: "t" });
    expect(same.topic).toBeUndefined();
    const foreign = toCnrmTree("PubSubSubscription", { name: "projects/my-project/subscriptions/s", topic: "projects/other/topics/t" }, ctx) as Record<string, unknown>;
    expect(foreign.topicRef).toEqual({ external: "projects/other/topics/t" });
  });

  test("secret: automatic replication maps onto CNRM's boolean spelling", () => {
    const tree = toCnrmTree("SecretManagerSecret", { name: "projects/my-project/secrets/s", replication: { automatic: {} } }, ctx) as Record<string, unknown>;
    expect(tree.replication).toEqual({ automatic: true });
  });

  test("service account: the email identity maps back to the declared account id", () => {
    const tree = toCnrmTree(
      "IAMServiceAccount",
      { name: "projects/my-project/serviceAccounts/sa-1@my-project.iam.gserviceaccount.com", displayName: "SA" },
      ctx,
    );
    expect((tree.metadata as Record<string, unknown>).name).toBe("sa-1");
  });

  test("run service: location comes from the resource name the payload carries nowhere else", () => {
    const tree = toCnrmTree(
      "RunService",
      { name: "projects/my-project/locations/us-central1/services/svc", template: { containers: [{ image: "i" }] } },
      ctx,
    ) as Record<string, unknown>;
    expect(tree.location).toBe("us-central1");
    expect((tree.metadata as Record<string, unknown>).name).toBe("svc");
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
    const props = out.resources.b.properties as Record<string, unknown>;

    // Reshaped into the declared-props shape — identity under `metadata`, spec
    // fields at the root, exactly as `new StorageBucket({ … })` authors them.
    // Without this every field drifts twice, once as `declared -> <absent>`
    // and once as `<undeclared> -> live`.
    expect(props.storageClass).toBe("NEARLINE");
    expect(props.location).toBe("US");
    expect((props.metadata as Record<string, unknown>).name).toBe("my-bucket");

    // Server-assigned, pruned wherever they landed.
    expect(props.etag).toBeUndefined();
    expect(props.selfLink).toBeUndefined();
    expect(props.id).toBeUndefined();
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

  test("kinds resolve through the serializer's GVK map, not naive recasing", async () => {
    // `GCP::Pubsub::Topic` derives `PubsubTopic` naively — no such mapper, so
    // 4 of the 6 appliable kinds silently reported unsupported-kind until the
    // readers resolved kinds the way the serializer does.
    fetchMock.mockResolvedValue(reply(200, { name: "projects/my-project/topics/t" }));
    const out = await observe(entities([["t", "GCP::Pubsub::Topic", { metadata: { name: "t" } }]]));
    expect(out.unobserved?.t).toBeUndefined();
    expect(out.resources.t).toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4588/v1/projects/my-project/topics/t");
  });

  test("the project falls back to the built manifest's merged annotation", async () => {
    // A project-wide `defaultAnnotations` is a separate declarable the
    // serializer merges at synthesis — the entity's own props never carry it,
    // and discovery is what the observe paths receive.
    delete process.env.GOOGLE_CLOUD_PROJECT;
    fetchMock.mockResolvedValue(reply(200, { name: "b" }));
    const buildOutput = [
      "apiVersion: storage.cnrm.cloud.google.com/v1beta1",
      "kind: StorageBucket",
      "metadata:",
      "  name: b",
      "  annotations:",
      "    cnrm.cloud.google.com/project-id: manifest-project",
      "spec:",
      "  location: US",
    ].join("\n");
    const out = await observe(entities([["b", "GCP::Storage::Bucket", { metadata: { name: "b" } }]]), { buildOutput });
    expect(out.unobserved?.b).toBeUndefined();
    expect(out.resources.b).toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4588/storage/v1/b/b");
  });

  test("no project from any source is still a no-binding hole, never a guess", async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const out = await observe(entities([["t", "GCP::Pubsub::Topic", { metadata: { name: "t" } }]]));
    expect(out.unobserved?.t?.reason).toBe("no-binding");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
