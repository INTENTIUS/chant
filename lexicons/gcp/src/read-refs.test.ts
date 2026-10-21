import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { describeResources } from "./describe-resources";
import {
  BackendService,
  CloudRunService,
  ComputeAddress,
  ForwardingRule,
  IAMPolicyMember,
  RegionNetworkEndpointGroup,
  Subnetwork,
  TargetHTTPProxy,
  URLMap,
  VPCNetwork,
} from "./generated";

/**
 * #4251: behold's three-cloud gcp member, read back. Every resource here names
 * another by `.name`, an attribute reference the serializer resolves to the
 * target's metadata.name (#4245). The read path has to resolve it the same way
 * before a mapper builds a URL from the declared props.
 */
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

function estate() {
  const web = new CloudRunService({ metadata: { name: "three-cloud-site" }, location: "us-central1", template: {} } as never);
  const vpc = new VPCNetwork({ metadata: { name: "three-cloud-vpc" }, autoCreateSubnetworks: false } as never);
  const subnet = new Subnetwork({
    metadata: { name: "three-cloud-subnet" },
    region: "us-central1",
    ipCidrRange: "10.8.0.0/24",
    networkRef: { name: vpc.name },
  } as never);
  (web as unknown as { props: Record<string, unknown> }).props.template = {
    containers: [{ image: "gcr.io/p/site:1" }],
    vpcAccess: { egress: "ALL_TRAFFIC", networkInterfaces: [{ networkRef: { name: vpc.name }, subnetworkRef: { name: subnet.name } }] },
  };
  const neg = new RegionNetworkEndpointGroup({
    metadata: { name: "three-cloud-neg" },
    region: "us-central1",
    networkEndpointType: "SERVERLESS",
    cloudRun: { serviceRef: { name: web.name } },
  } as never);
  const backend = new BackendService({
    metadata: { name: "three-cloud-backend" },
    location: "global",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    backend: [{ group: { networkEndpointGroupRef: { name: neg.name } } }],
  } as never);
  const urlMap = new URLMap({
    metadata: { name: "three-cloud-urlmap" },
    location: "global",
    defaultService: { backendServiceRef: { name: backend.name } },
  } as never);
  const proxy = new TargetHTTPProxy({ metadata: { name: "three-cloud-proxy" }, location: "global", urlMapRef: { name: urlMap.name } } as never);
  const address = new ComputeAddress({ metadata: { name: "three-cloud-ip" }, location: "global" } as never);
  const rule = new ForwardingRule({
    metadata: { name: "three-cloud-rule" },
    location: "global",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    portRange: "80",
    target: { targetHTTPProxyRef: { name: proxy.name } },
    ipAddress: { addressRef: { name: address.name } },
  } as never);
  const publicIam = new IAMPolicyMember({
    metadata: { name: "three-cloud-site-public" },
    member: "allUsers",
    role: "roles/run.invoker",
    resourceRef: { apiVersion: "run.cnrm.cloud.google.com/v1beta1", kind: "RunService", name: "three-cloud-site" },
  } as never);
  const all = { web, vpc, subnet, neg, backend, urlMap, proxy, address, rule, publicIam };
  return new Map(
    Object.entries(all).map(([logical, e]) => {
      const entity = e as unknown as { entityType: string; props: Record<string, unknown> };
      return [logical, { entityType: entity.entityType, props: entity.props }];
    }),
  );
}

describe("gcp live read resolves .name references as the build does (#4251)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    process.env.GCP_ENDPOINT_URL = "http://localhost:4588";
    process.env.GOOGLE_CLOUD_PROJECT = "three-cloud";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(":getIamPolicy")) {
        return reply(200, { etag: "e1", bindings: [{ role: "roles/run.invoker", members: ["allUsers"] }] });
      }
      return reply(200, { id: url, name: url.split("/").pop() });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GCP_ENDPOINT_URL;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  test("every resource reads, by the names the build writes, and none fails on a reference", async () => {
    const entities = estate();
    const out = await describeResources({ environment: "local", buildOutput: "", entityNames: [...entities.keys()], entities });

    expect(out.unobserved ?? {}).toEqual({});
    for (const logical of entities.keys()) {
      expect(out.resources[logical]?.physicalId, logical).toBeTruthy();
    }
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    for (const name of ["three-cloud-neg", "three-cloud-backend", "three-cloud-urlmap", "three-cloud-proxy", "three-cloud-rule", "three-cloud-subnet", "three-cloud-site"]) {
      expect(urls.some((u) => u.includes(name)), name).toBe(true);
    }
    expect(urls.every((u) => !u.includes("[object"))).toBe(true);
  });

  test("the public IAMPolicyMember reads as the binding in the service's policy, with a physical id", async () => {
    const entities = estate();
    const out = await describeResources({ environment: "local", buildOutput: "", entityNames: [...entities.keys()], entities });
    expect(out.resources.publicIam?.physicalId).toBe(
      "projects/three-cloud/locations/us-central1/services/three-cloud-site#roles/run.invoker#allUsers",
    );
  });

  test("a binding missing from the policy reads as absent, not observed", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes(":getIamPolicy") ? reply(200, { etag: "e1", bindings: [] }) : reply(200, { id: url }),
    );
    const entities = estate();
    const out = await describeResources({ environment: "local", buildOutput: "", entityNames: [...entities.keys()], entities });
    expect(out.resources.publicIam).toBeUndefined();
    expect(out.unobserved?.publicIam).toBeUndefined();
  });
});
