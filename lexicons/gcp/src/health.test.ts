import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cloudRunEntry, observeHealthGcp } from "./health";
import type { GcpReadHttp } from "./api/read-client";

const AT = "2026-10-20T21:00:00.000Z";
const now = () => new Date(AT);
const entities = new Map([
  [
    "api",
    {
      entityType: "GCP::Run::Service",
      props: { metadata: { name: "api", annotations: { "cnrm.cloud.google.com/project-id": "demo" } }, spec: { location: "us-central1" } },
    },
  ],
]);

describe("gcp health (#4177)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GCP_ENDPOINT_URL;
    process.env.GCP_ENDPOINT_URL = "http://localhost:4588";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GCP_ENDPOINT_URL;
    else process.env.GCP_ENDPOINT_URL = saved;
  });

  test("reads the v2 terminalCondition and the v1 status conditions", () => {
    expect(
      cloudRunEntry({ terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED", lastTransitionTime: "2026-10-20T20:00:00Z" }, latestReadyRevision: "projects/demo/locations/us-central1/services/api/revisions/api-00002" }, AT),
    ).toMatchObject({ state: "healthy", detail: "Ready CONDITION_SUCCEEDED, latest ready api-00002", checkedAt: "2026-10-20T20:00:00Z" });
    expect(cloudRunEntry({ terminalCondition: { type: "Ready", state: "CONDITION_FAILED", message: "image not found" } }, AT)).toMatchObject({
      state: "unhealthy",
      detail: "Ready CONDITION_FAILED: image not found",
    });
    expect(cloudRunEntry({ terminalCondition: { type: "Ready", state: "CONDITION_RECONCILING" } }, AT).state).toBe("unknown");
    expect(cloudRunEntry({ status: { conditions: [{ type: "Ready", status: "False", reason: "RevisionFailed" }] } }, AT).state).toBe("unhealthy");
    expect(cloudRunEntry({}, AT).state).toBe("unknown");
  });

  test("reads at the endpoint override in the declared project and location", async () => {
    const urls: string[] = [];
    const http: GcpReadHttp = async (_m, url) => {
      urls.push(url);
      return { status: 200, text: JSON.stringify({ terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" } }) };
    };
    const r = await observeHealthGcp({ environment: "dev", buildOutput: "", entities, http, now });
    expect(r.entities.api).toMatchObject({ state: "healthy", observedAt: AT });
    expect(urls).toEqual(["http://localhost:4588/v2/projects/demo/locations/us-central1/services/api"]);
  });

  test("a 404 is absent; a 403 is a no-credentials hole", async () => {
    const notFound: GcpReadHttp = async () => ({ status: 404, text: "" });
    expect((await observeHealthGcp({ environment: "dev", buildOutput: "", entities, http: notFound })).absent).toEqual(["api"]);
    const denied: GcpReadHttp = async () => ({ status: 403, text: "denied" });
    const r = await observeHealthGcp({ environment: "dev", buildOutput: "", entities, http: denied });
    expect(r.unobserved.api?.reason).toBe("no-credentials");
  });
});
