import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appRunningStatusEntry, containerAppEntry, observeHealthAzure } from "./health";
import type { AzHttp } from "./op/activities/az-apply";

const AT = "2026-10-20T21:00:00.000Z";
const now = () => new Date(AT);
const entities = new Map([["web", { entityType: "Microsoft.App/containerApps", props: { name: "web-app" } }]]);

describe("azure health (#4177)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.AZURE_ENDPOINT_URL;
    process.env.AZURE_ENDPOINT_URL = "http://localhost:4577";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AZURE_ENDPOINT_URL;
    else process.env.AZURE_ENDPOINT_URL = saved;
  });

  test("judges the active revisions", () => {
    const rev = (runningState: string, extra: Record<string, unknown> = {}) => ({
      name: "web-app--r1",
      properties: { active: true, runningState, replicas: 2, trafficWeight: 100, ...extra },
    });
    expect(containerAppEntry([rev("Running")], AT)).toMatchObject({ state: "healthy", detail: "web-app--r1 Running, 2 replica(s), 100% traffic" });
    expect(containerAppEntry([rev("Running", { healthState: "Unhealthy" })], AT).state).toBe("unhealthy");
    expect(containerAppEntry([rev("Failed")], AT).state).toBe("unhealthy");
    expect(containerAppEntry([rev("Processing")], AT).state).toBe("unknown");
    expect(containerAppEntry([{ name: "old", properties: { active: false, runningState: "Running" } }], AT)).toMatchObject({
      state: "unhealthy",
      detail: "no active revision (1 revision(s))",
    });
  });

  test("the app's runningStatus answers when revisions cannot be listed", () => {
    expect(appRunningStatusEntry("Running", AT).state).toBe("healthy");
    expect(appRunningStatusEntry("Stopped", AT).state).toBe("unhealthy");
  });

  test("reads the app, then its revisions, at the endpoint override", async () => {
    const urls: string[] = [];
    const http: AzHttp = async (_method, url) => {
      urls.push(url);
      if (url.includes("/revisions")) {
        return { status: 200, text: JSON.stringify({ value: [{ name: "web-app--r1", properties: { active: true, runningState: "Running", replicas: 1 } }] }) };
      }
      return { status: 200, text: JSON.stringify({ id: "/x", properties: {} }) };
    };
    const r = await observeHealthAzure({ environment: "rg", buildOutput: "", entities, http, now });
    expect(r.entities.web).toMatchObject({ state: "healthy", observedAt: AT });
    expect(urls[1]).toBe(
      "http://localhost:4577/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.App/containerApps/web-app/revisions?api-version=2024-03-01",
    );
  });

  test("a 404 app is absent; an unreadable revisions list with no runningStatus is a hole", async () => {
    const notFound: AzHttp = async () => ({ status: 404, text: JSON.stringify({ error: { code: "ResourceNotFound", message: "gone" } }) });
    expect((await observeHealthAzure({ environment: "rg", buildOutput: "", entities, http: notFound })).absent).toEqual(["web"]);

    const noRevisions: AzHttp = async (_m, url) =>
      url.includes("/revisions") ? { status: 404, text: "" } : { status: 200, text: JSON.stringify({ id: "/x", properties: {} }) };
    const r = await observeHealthAzure({ environment: "rg", buildOutput: "", entities, http: noRevisions });
    expect(r.entities).toEqual({});
    expect(r.unobserved.web?.reason).toBe("read-failed");
  });
});
