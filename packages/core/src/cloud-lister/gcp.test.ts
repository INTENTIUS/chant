/**
 * behold#1029: the GCP lister against a fake Cloud Asset Inventory. Shapes
 * follow the pinned floci-gcp (source 641e6e8): `GET
 * /cloudasset/v1/projects/{p}:searchAllResources`, `{ results, nextPageToken }`,
 * and SERVICE_DISABLED as ServiceUsageGate writes it.
 */
import { describe, expect, it } from "vitest";
import { listCloud } from "./index";
import { enableCommand, labelQuery } from "./gcp";
import { fakeFetcher, json, refusingChains, steppingClock } from "./fakes";

const PROJECT = "plc-corpus";
const ENDPOINT = "http://localhost:4588/cloudasset";
const BUCKET = "//storage.googleapis.com/projects/_/buckets/plc-assets";
const TOPIC = `//pubsub.googleapis.com/projects/${PROJECT}/topics/events`;

const serviceDisabled = json(403, {
  error: {
    code: 403,
    message: `Cloud Asset API has not been used in project ${PROJECT} before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudasset.googleapis.com/overview?project=${PROJECT} then retry.`,
    status: "PERMISSION_DENIED",
    errors: [{ message: "x", domain: "usageLimits", reason: "accessNotConfigured" }],
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "cloudasset.googleapis.com", consumer: `projects/${PROJECT}` } }],
  },
});

describe("listing gcp", () => {
  it("searches the project, pages, and fills the listing-result shape", async () => {
    const fake = fakeFetcher((call) => {
      const url = new URL(call.url);
      if (!url.searchParams.get("pageToken")) {
        return json(200, {
          results: [
            { name: BUCKET, assetType: "storage.googleapis.com/Bucket", project: "projects/123", location: "US", labels: { "plunge-stack": "0123456789abcdef", "plunge-urn": "fedcba9876543210fedcba9876543210" } },
          ],
          nextPageToken: "t2",
        });
      }
      return json(200, { results: [{ name: TOPIC, assetType: "pubsub.googleapis.com/Topic", project: "projects/123", additionalAttributes: { secretValue: "s" } }] });
    });
    const result = await listCloud(
      { substrate: "gcp", scopeId: PROJECT, types: "*", locations: "*" },
      { substrate: "gcp", gcp: { endpoint: ENDPOINT, token: null } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(fake.calls.length).toBe(2);
    const first = new URL(fake.calls[0].url);
    expect(first.origin + first.pathname).toBe(`${ENDPOINT}/v1/projects/${PROJECT}:searchAllResources`);
    expect(first.searchParams.get("pageSize")).toBe("500");
    expect(fake.calls[0].headers.authorization).toBeUndefined();
    expect(new URL(fake.calls[1].url).searchParams.get("pageToken")).toBe("t2");

    const bucket = result.resources.find((r) => r.nativeId === BUCKET)!;
    expect(bucket.id).toBe(`gcp/${PROJECT}/us/storage.googleapis.com%2FBucket/${BUCKET}`);
    expect(bucket.location).toBe("us");
    expect(bucket.cloudIds).toEqual([{ kind: "provider-id", value: BUCKET }]);
    expect(bucket.facts.markers).toEqual({ owner: "0123456789abcdef", address: "fedcba9876543210fedcba9876543210", encoding: "digest", source: "live" });

    const topic = result.resources.find((r) => r.nativeId === TOPIC)!;
    expect(topic.location).toBe("global");
    expect((topic.properties.additionalAttributes as Record<string, unknown>).secretValue).toBe("<masked>");
    expect(result.coverage).toEqual([{ listedType: "*", location: "*", verdict: "listed" }]);
  });

  it("filters locations after the search and puts types and labels in the request", async () => {
    const fake = fakeFetcher(() =>
      json(200, {
        results: [
          { name: "//compute.googleapis.com/projects/p/zones/us-central1-a/instances/a", assetType: "compute.googleapis.com/Instance", location: "us-central1-a" },
          { name: "//compute.googleapis.com/projects/p/zones/europe-west1-b/instances/b", assetType: "compute.googleapis.com/Instance", location: "europe-west1-b" },
        ],
      }),
    );
    const result = await listCloud(
      { substrate: "gcp", scopeId: PROJECT, types: ["compute.googleapis.com/Instance"], locations: ["us-central1-a"], tagFilter: { env: "prod" } },
      { substrate: "gcp", gcp: { endpoint: ENDPOINT, token: "static" } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    const url = new URL(fake.calls[0].url);
    expect(url.searchParams.getAll("assetTypes")).toEqual(["compute.googleapis.com/Instance"]);
    expect(url.searchParams.get("query")).toBe("labels.env=prod");
    expect(fake.calls[0].headers.authorization).toBe("Bearer static");
    expect(result.resources.map((r) => r.location)).toEqual(["us-central1-a"]);
    expect(result.coverage).toEqual([{ listedType: "compute.googleapis.com/Instance", location: "us-central1-a", verdict: "filtered", detail: 'tag filter {"env":"prod"}' }]);
  });

  it("never enables the Cloud Asset API: says so, prints the command, lists nothing", async () => {
    const fake = fakeFetcher(() => serviceDisabled);
    const result = await listCloud(
      { substrate: "gcp", scopeId: PROJECT, types: ["storage.googleapis.com/Bucket"], locations: "*" },
      { substrate: "gcp", gcp: { endpoint: ENDPOINT, token: null } },
      { fetcher: fake.fetcher, chains: refusingChains(), now: steppingClock(), retryDelays: [] },
    );
    expect(result.resources).toEqual([]);
    expect(result.coverage).toEqual([{ listedType: "storage.googleapis.com/Bucket", location: "*", verdict: "read-failed", detail: `Cloud Asset API is disabled on project ${PROJECT}` }]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].code).toBe("api-disabled");
    expect(result.notes[0].command).toBe(enableCommand(PROJECT));
    expect(result.notes[0].command).toBe("gcloud services enable cloudasset.googleapis.com --project=plc-corpus");
    // One call, the search; nothing went to Service Usage.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].method).toBe("GET");
    expect(fake.calls[0].url).toContain(":searchAllResources");
    expect(fake.calls.some((c) => /serviceusage|:enable|batchEnable/.test(c.url))).toBe(false);
  });

  it("never asks application-default credentials when an endpoint is given", async () => {
    const chains = refusingChains();
    const fake = fakeFetcher(() => undefined);
    await expect(
      listCloud({ substrate: "gcp", scopeId: PROJECT, types: "*", locations: "*" }, { substrate: "gcp", gcp: { endpoint: ENDPOINT } }, { fetcher: fake.fetcher, chains }),
    ).rejects.toThrow(/application-default credentials are never used/);
    expect(chains.count.gcp).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("joins label terms with AND and refuses anything else", () => {
    expect(labelQuery({ a: "1", b: "2" })).toBe("labels.a=1 AND labels.b=2");
    expect(() => labelQuery({ "a OR x": "1" })).toThrow();
  });
});
