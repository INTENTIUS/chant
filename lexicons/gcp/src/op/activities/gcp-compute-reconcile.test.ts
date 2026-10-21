import { beforeEach, describe, expect, test } from "vitest";
import { applyResource, MAPPERS, type GcpHttp, type GcpResource } from "./gcp-apply";
import { changedFields, computeLabels, holds } from "./gcp-compute";

beforeEach(() => {
  delete process.env.GCP_REGION;
});

const base = "https://compute.googleapis.com";
const lb: GcpResource[] = [
  {
    kind: "ComputeForwardingRule",
    metadata: { name: "web-fr" },
    spec: {
      location: "global",
      portRange: "80",
      ipAddress: { addressRef: { name: "web-ip" } },
      target: { targetHTTPProxyRef: { name: "web-proxy" } },
    },
  },
  { kind: "ComputeTargetHTTPProxy", metadata: { name: "web-proxy" }, spec: { location: "global", urlMapRef: { name: "web-map" } } },
  { kind: "ComputeURLMap", metadata: { name: "web-map" }, spec: { location: "global", defaultService: { backendServiceRef: { name: "web" } } } },
  {
    kind: "ComputeBackendService",
    metadata: { name: "web" },
    spec: { location: "global", protocol: "HTTPS", timeoutSec: 30, backend: [{ group: { networkEndpointGroupRef: { name: "web" } } }] },
  },
  {
    kind: "ComputeRegionNetworkEndpointGroup",
    metadata: { name: "web" },
    spec: { region: "europe-west1", networkEndpointType: "SERVERLESS", cloudRun: { serviceRef: { name: "web" } } },
  },
  { kind: "ComputeAddress", metadata: { name: "web-ip" }, spec: { location: "global" } },
];
const ctx = { base, project: "p1", manifest: lb };
const byKind = (kind: string) => lb.find((r) => r.kind === kind)!;
const url = (path: string) => `${base}/compute/v1/projects/p1/${path}`;
const OP = JSON.stringify({ kind: "compute#operation", selfLink: url("global/operations/op-1"), status: "DONE" });

/** A fake compute API: GETs answer from `live`, every write is recorded and returns a finished operation. */
function fakeCompute(live: Record<string, unknown>) {
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  const http: GcpHttp = async (method, u, body) => {
    if (method === "GET") {
      const hit = live[u];
      if (hit !== undefined) return { status: 200, text: JSON.stringify(hit) };
      if (u.includes("/operations/")) return { status: 200, text: OP };
      return { status: 404, text: "" };
    }
    writes.push({ method, url: u, body });
    return { status: 200, text: OP };
  };
  return { http, writes };
}

describe("compute reconcile against the live resource (#4238)", () => {
  test("holds: a full compute URL holds its partial form, and live-only fields don't count", () => {
    expect(holds("projects/p1/global/urlMaps/m", url("global/urlMaps/m"))).toBe(true);
    expect(holds({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(holds([{ group: "projects/p1/x" }], [{ group: `${base}/compute/v1/projects/p1/x`, balancingMode: "UTILIZATION" }])).toBe(true);
    expect(holds([1], [1, 2])).toBe(false);
    expect(changedFields({ name: "n", a: 1, b: 2 }, { name: "other", a: 1, b: 3 })).toEqual(["b"]);
  });

  test("a backend service that matches is left alone; a change is a PATCH carrying the live fingerprint", async () => {
    const liveBody = {
      name: "web",
      fingerprint: "fp-1",
      protocol: "HTTPS",
      timeoutSec: 30,
      backends: [{ group: url("regions/europe-west1/networkEndpointGroups/web"), balancingMode: "UTILIZATION" }],
    };
    const same = fakeCompute({ [url("global/backendServices/web")]: liveBody });
    await expect(applyResource(MAPPERS.ComputeBackendService, byKind("ComputeBackendService"), ctx, same.http)).resolves.toMatchObject({ updated: false });
    expect(same.writes).toEqual([]);

    const drifted = fakeCompute({ [url("global/backendServices/web")]: { ...liveBody, timeoutSec: 10 } });
    await expect(applyResource(MAPPERS.ComputeBackendService, byKind("ComputeBackendService"), ctx, drifted.http)).resolves.toMatchObject({ updated: true });
    expect(drifted.writes).toHaveLength(1);
    expect(drifted.writes[0]).toMatchObject({ method: "PATCH", url: url("global/backendServices/web"), body: { timeoutSec: 30, fingerprint: "fp-1" } });
  });

  test("a URL map's new default service is a PATCH with the fingerprint", async () => {
    const f = fakeCompute({ [url("global/urlMaps/web-map")]: { name: "web-map", fingerprint: "fp-m", defaultService: url("global/backendServices/old") } });
    await applyResource(MAPPERS.ComputeURLMap, byKind("ComputeURLMap"), ctx, f.http);
    expect(f.writes).toEqual([
      { method: "PATCH", url: url("global/urlMaps/web-map"), body: expect.objectContaining({ defaultService: "projects/p1/global/backendServices/web", fingerprint: "fp-m" }) },
    ]);
  });

  test("a proxy's URL map changes through setUrlMap", async () => {
    const f = fakeCompute({ [url("global/targetHttpProxies/web-proxy")]: { name: "web-proxy", urlMap: url("global/urlMaps/old") } });
    await applyResource(MAPPERS.ComputeTargetHTTPProxy, byKind("ComputeTargetHTTPProxy"), ctx, f.http);
    expect(f.writes).toEqual([{ method: "POST", url: url("global/targetHttpProxies/web-proxy/setUrlMap"), body: { urlMap: "projects/p1/global/urlMaps/web-map" } }]);
  });

  test("a forwarding rule: the declared address's IP holds, the target changes by setTarget, labels by setLabels", async () => {
    const f = fakeCompute({
      [url("global/forwardingRules/web-fr")]: {
        name: "web-fr",
        portRange: "80",
        IPAddress: "34.1.2.3",
        target: url("global/targetHttpProxies/old"),
        labels: {},
        labelFingerprint: "lf-1",
      },
      [url("global/addresses/web-ip")]: { name: "web-ip", address: "34.1.2.3" },
    });
    await applyResource(MAPPERS.ComputeForwardingRule, byKind("ComputeForwardingRule"), ctx, f.http);
    expect(f.writes).toEqual([
      { method: "POST", url: url("global/forwardingRules/web-fr/setTarget"), body: { target: "projects/p1/global/targetHttpProxies/web-proxy" } },
      { method: "POST", url: url("global/forwardingRules/web-fr/setLabels"), body: { labels: computeLabels(undefined), labelFingerprint: "lf-1" } },
    ]);
  });

  test("a forwarding rule on another IP, a changed address and a changed NEG are reported for replacement, not written", async () => {
    const fr = fakeCompute({
      [url("global/forwardingRules/web-fr")]: {
        name: "web-fr",
        portRange: "80",
        IPAddress: "10.0.0.9",
        target: url("global/targetHttpProxies/web-proxy"),
        labels: computeLabels(undefined),
      },
      [url("global/addresses/web-ip")]: { name: "web-ip", address: "34.1.2.3" },
    });
    const r = await applyResource(MAPPERS.ComputeForwardingRule, byKind("ComputeForwardingRule"), ctx, fr.http);
    expect(r).toMatchObject({ updated: false, replaceRequired: expect.stringContaining("IPAddress") });
    expect(fr.writes).toEqual([]);

    const neg = fakeCompute({
      [url("regions/europe-west1/networkEndpointGroups/web")]: { name: "web", networkEndpointType: "SERVERLESS", cloudRun: { service: "other" } },
    });
    const n = await applyResource(MAPPERS.ComputeRegionNetworkEndpointGroup, byKind("ComputeRegionNetworkEndpointGroup"), ctx, neg.http);
    expect(n.replaceRequired).toMatch(/cloudRun/);
    expect(neg.writes).toEqual([]);

    const addr = fakeCompute({ [url("global/addresses/web-ip")]: { name: "web-ip", address: "34.1.2.3", labels: computeLabels(undefined), addressType: "INTERNAL" } });
    const changed = { ...byKind("ComputeAddress"), spec: { location: "global", addressType: "EXTERNAL" } };
    const a = await applyResource(MAPPERS.ComputeAddress, changed, ctx, addr.http);
    expect(a.replaceRequired).toMatch(/addressType/);
    expect(addr.writes).toEqual([]);
  });

  test("an address's labels change through setLabels", async () => {
    const f = fakeCompute({ [url("global/addresses/web-ip")]: { name: "web-ip", address: "34.1.2.3", labels: {}, labelFingerprint: "lf-a" } });
    await applyResource(MAPPERS.ComputeAddress, byKind("ComputeAddress"), ctx, f.http);
    expect(f.writes).toEqual([{ method: "POST", url: url("global/addresses/web-ip/setLabels"), body: { labels: computeLabels(undefined), labelFingerprint: "lf-a" } }]);
  });
});
