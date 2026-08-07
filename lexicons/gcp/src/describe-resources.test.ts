import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { describeResources, statusFromRest } from "./describe-resources";

/**
 * The transport is `fetch` now, not a kubectl spawn (#1209), so these stub the
 * global rather than `node:child_process`. Stubbing fetch also keeps the URL
 * under test: a reader that composed its own paths instead of reusing the
 * applier's mapper would show up here as a changed URL.
 */
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

function makeEntities(records: Array<{ name: string; entityType: string; props: Record<string, unknown> }>) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

const bucket = (name: string) => ({
  name: "bucket-entity",
  entityType: "GCP::Storage::Bucket",
  props: { metadata: { name }, spec: { location: "US" } },
});

async function read(entities: ReturnType<typeof makeEntities>, opts: { owned?: boolean; buildOutput?: string } = {}) {
  return describeResources({
    environment: "local",
    buildOutput: "",
    entityNames: [...entities.keys()],
    entities,
    ...opts,
  });
}

describe("gcp describeResources — direct REST (#1209)", () => {
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

  test("reads through the applier's mapper URL, against the endpoint override", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "b/my-bucket", labels: { "managed-by": "chant" } }));
    const out = await read(makeEntities([bucket("my-bucket")]));

    // floci-gcp, and the storage path the applier writes to — not a URL this
    // reader composed for itself.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4588/storage/v1/b/my-bucket");
    expect(out.resources["bucket-entity"]).toMatchObject({ type: "GCP::Storage::Bucket", physicalId: "b/my-bucket" });
  });

  test("a 404 is a real absence — reported as neither present nor a hole", async () => {
    fetchMock.mockResolvedValue(reply(404, { error: "not found" }));
    const out = await read(makeEntities([bucket("gone")]));
    expect(out.resources["bucket-entity"]).toBeUndefined();
    expect(out.unobserved?.["bucket-entity"]).toBeUndefined();
  });

  test("a 403 is a hole, not an absence (#1089)", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "denied" }));
    const out = await read(makeEntities([bucket("secret")]));
    expect(out.resources["bucket-entity"]).toBeUndefined();
    expect(out.unobserved?.["bucket-entity"]?.reason).toBe("no-credentials");
  });

  test("an unreachable endpoint is a hole", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const out = await read(makeEntities([bucket("x")]));
    expect(out.unobserved?.["bucket-entity"]?.reason).toBe("read-failed");
  });

  test("a kind the applier has no mapper for is unsupported-kind, not absent", async () => {
    const out = await read(
      makeEntities([{ name: "e", entityType: "GCP::Compute::Address", props: { metadata: { name: "addr" } } }]),
    );
    expect(out.unobserved?.e?.reason).toBe("unsupported-kind");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an entity with no metadata.name has nothing to query by", async () => {
    const out = await read(makeEntities([{ name: "e", entityType: "GCP::Storage::Bucket", props: {} }]));
    expect(out.unobserved?.e?.reason).toBe("read-failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("kinds resolve through the serializer's GVK map, not naive recasing", async () => {
    // The real entity type is `GCP::Pubsub::Topic` (the generated barrel's
    // casing); a naive `${service}${shortKind}` derives `PubsubTopic`, which
    // matches no mapper — 4 of the 6 appliable kinds were invisible this way.
    fetchMock.mockResolvedValue(reply(200, { name: "projects/my-project/topics/t" }));
    const out = await read(
      makeEntities([{ name: "t", entityType: "GCP::Pubsub::Topic", props: { metadata: { name: "t" } } }]),
    );
    expect(out.unobserved?.t).toBeUndefined();
    expect(out.resources.t).toBeDefined();
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4588/v1/projects/my-project/topics/t");
  });

  test("the project falls back to the built manifest's merged annotation", async () => {
    // `defaultAnnotations` is a separate declarable the serializer merges at
    // synthesis — the entity's own props never carry it.
    delete process.env.GOOGLE_CLOUD_PROJECT;
    fetchMock.mockResolvedValue(reply(200, { id: "b/b" }));
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
    const out = await read(
      makeEntities([{ name: "b", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "b" } } }]),
      { buildOutput },
    );
    expect(out.unobserved?.b).toBeUndefined();
    expect(out.resources.b).toBeDefined();
  });

  test("no project from any source is a no-binding hole, never a guess", async () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const out = await read(
      makeEntities([{ name: "b", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "b" } } }]),
    );
    expect(out.unobserved?.b?.reason).toBe("no-binding");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reads concurrently, where the kubectl path was one spawn after another", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    const entities = makeEntities([
      { name: "a", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "a" } } },
      { name: "b", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "b" } } },
      { name: "c", entityType: "GCP::Storage::Bucket", props: { metadata: { name: "c" } } },
    ]);
    await read(entities);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  describe("--owned", () => {
    test("withholds a resource whose labels carry no chant marker", async () => {
      fetchMock.mockResolvedValue(reply(200, { id: "b/theirs", labels: { team: "other" } }));
      const out = await read(makeEntities([bucket("theirs")]), { owned: true });
      expect(out.unobserved?.["bucket-entity"]?.reason).toBe("filtered");
    });

    test("keeps one carrying the marker the APPLIER stamps, not the CNRM label", async () => {
      // gcp-apply stamps `managed-by: chant` — GCP label keys cannot hold the
      // k8s `app.kubernetes.io/managed-by` form the kubectl path looked for.
      fetchMock.mockResolvedValue(reply(200, { id: "b/ours", labels: { "managed-by": "chant" } }));
      const out = await read(makeEntities([bucket("ours")]), { owned: true });
      expect(out.resources["bucket-entity"]?.ownership).toBe("owned");
    });

    test("degrades to detect-only for a kind whose payload has no labels at all", async () => {
      // A Pub/Sub topic carries none. Withholding everything it cannot prove
      // would report a live estate as empty; the AWS thin path takes the same
      // posture when describe-stack-resources returns no tags.
      fetchMock.mockResolvedValue(reply(200, { name: "projects/my-project/topics/t" }));
      const out = await read(
        makeEntities([{ name: "t", entityType: "GCP::PubSub::Topic", props: { metadata: { name: "t" } } }]),
        { owned: true },
      );
      expect(out.unobserved?.t).toBeUndefined();
      expect(out.resources.t?.ownership).toBe("unknown");
    });
  });
});

describe("statusFromRest", () => {
  test("PRESENT when the payload carries no state — the common case", () => {
    // A bucket that answers a GET simply exists. Same sentinel the Azure
    // reader emits for a resource with no provisioningState.
    expect(statusFromRest({})).toBe("PRESENT");
  });

  test("an explicit state wins", () => {
    expect(statusFromRest({ state: "ACTIVE" })).toBe("ACTIVE");
  });

  test("a Ready condition reads like the CNRM path did", () => {
    expect(statusFromRest({ status: { conditions: [{ type: "Ready", status: "True" }] } })).toBe("READY");
    expect(statusFromRest({ status: { conditions: [{ type: "Ready", status: "False", reason: "Failed" }] } })).toBe("Failed");
    expect(statusFromRest({ status: { conditions: [{ type: "Ready", status: "False" }] } })).toBe("NOT_READY");
  });

  test("falls back to listing conditions when there is no Ready", () => {
    expect(statusFromRest({ status: { conditions: [{ type: "Synced", status: "True" }] } })).toBe("Synced=True");
  });
});
