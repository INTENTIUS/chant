import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { backendServiceEntry, cloudRunEntry, GCP_HEALTH_TYPES, observeHealthGcp } from "./health";
import { gcpPlugin } from "./plugin";
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

  test("backend service: any unhealthy endpoint is unhealthy, all healthy is healthy, no status is unknown (#4239)", () => {
    const g = (healthState: string) => ({ group: "g", healthStatus: [{ healthState }] });
    expect(backendServiceEntry([g("HEALTHY"), g("HEALTHY")], AT)).toMatchObject({ state: "healthy", detail: "2 of 2 backends healthy" });
    expect(backendServiceEntry([g("HEALTHY"), g("UNHEALTHY")], AT)).toMatchObject({ state: "unhealthy", detail: "1 of 2 backends healthy, 1 unhealthy" });
    // A serverless NEG reports no health status; a failed call counts the same.
    expect(backendServiceEntry([{ group: "neg", healthStatus: [] }], AT)).toMatchObject({ state: "unknown", detail: "0 of 1 backend healthy, 1 with no health status" });
    expect(backendServiceEntry([{ group: "g", error: "getHealth 400" }], AT).state).toBe("unknown");
    expect(backendServiceEntry([], AT)).toMatchObject({ state: "unknown", detail: "no backends" });
  });

  test("a backend service is read, then getHealth is called for each backend group at its URL (#4239)", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const group = "https://compute.googleapis.com/compute/v1/projects/demo/zones/us-central1-a/instanceGroups/ig";
    const http: GcpReadHttp = async (method, url, body) => {
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      if (method === "GET") return { status: 200, text: JSON.stringify({ name: "web", backends: [{ group }] }) };
      return { status: 200, text: JSON.stringify({ healthStatus: [{ healthState: "HEALTHY" }, { healthState: "HEALTHY" }] }) };
    };
    const lb = new Map([
      [
        "backend",
        {
          entityType: "GCP::Compute::BackendService",
          props: { metadata: { name: "web", annotations: { "cnrm.cloud.google.com/project-id": "demo" } }, location: "global" },
        },
      ],
    ]);
    const r = await observeHealthGcp({ environment: "dev", buildOutput: "", entities: lb, http, now });
    expect(r.entities.backend).toMatchObject({ type: "GCP::Compute::BackendService", state: "healthy" });
    expect(calls[1]).toEqual({ method: "POST", url: "http://localhost:4588/compute/v1/projects/demo/global/backendServices/web/getHealth", body: { group } });
  });

  test("an IAM policy member in the target's policy is healthy; one missing from it is absent (#4239)", async () => {
    const iam = new Map<string, { entityType: string; props: Record<string, unknown> }>([
      [
        "publicIam",
        {
          entityType: "GCP::Iam::PolicyMember",
          props: {
            metadata: { name: "api-public", annotations: { "cnrm.cloud.google.com/project-id": "demo" } },
            member: "allUsers",
            role: "roles/run.invoker",
            resourceRef: { kind: "RunService", name: "api" },
          },
        },
      ],
      ...entities,
    ]);
    const policy = (members: string[]): GcpReadHttp => async (_m, url) =>
      url.includes(":getIamPolicy")
        ? { status: 200, text: JSON.stringify({ bindings: [{ role: "roles/run.invoker", members }] }) }
        : { status: 200, text: JSON.stringify({ terminalCondition: { type: "Ready", state: "CONDITION_SUCCEEDED" } }) };
    const present = await observeHealthGcp({ environment: "dev", buildOutput: "", entities: iam, http: policy(["allUsers"]), now });
    expect(present.entities.publicIam).toMatchObject({ type: "GCP::Iam::PolicyMember", state: "healthy" });
    expect(present.entities.publicIam?.detail).toMatch(/^allUsers holds roles\/run\.invoker on /);
    const missing = await observeHealthGcp({ environment: "dev", buildOutput: "", entities: iam, http: policy(["user:x@y.z"]), now });
    expect(missing.absent).toContain("publicIam");
  });

  test("the plugin's healthTypes match the reader's", () => {
    expect([...(gcpPlugin.healthTypes ?? [])]).toEqual([...GCP_HEALTH_TYPES]);
  });
});
