import { beforeEach, describe, expect, test } from "vitest";
import { applyResource, deleteResource, MAPPERS, orderByReferences, type GcpHttp, type GcpResource } from "./gcp-apply";
import { computeLabels, computeOperation } from "./gcp-compute";
import { getResource } from "../../api/read-client";

beforeEach(() => {
  delete process.env.GCP_REGION;
});

/** The serverless load balancer behold's three-cloud demo declares, in the shape the serializer writes. */
const lb: GcpResource[] = [
  {
    kind: "ComputeForwardingRule",
    metadata: { name: "web-fr", labels: { "app.kubernetes.io/component": "lb", tier: "edge" } },
    spec: {
      location: "global",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      portRange: "80",
      ipProtocol: "TCP",
      ipAddress: { addressRef: { name: "web-ip" } },
      target: { targetHTTPProxyRef: { name: "web-proxy" } },
    },
  },
  { kind: "ComputeTargetHTTPProxy", metadata: { name: "web-proxy" }, spec: { location: "global", urlMapRef: { name: "web-map" } } },
  { kind: "ComputeURLMap", metadata: { name: "web-map" }, spec: { location: "global", defaultService: { backendServiceRef: { name: "web" } } } },
  {
    kind: "ComputeBackendService",
    metadata: { name: "web" },
    spec: {
      location: "global",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      protocol: "HTTPS",
      enableCdn: false,
      backend: [{ group: { networkEndpointGroupRef: { name: "web" } } }],
    },
  },
  {
    kind: "ComputeRegionNetworkEndpointGroup",
    metadata: { name: "web" },
    spec: { region: "europe-west1", networkEndpointType: "SERVERLESS", cloudRun: { serviceRef: { name: "web" } } },
  },
  { kind: "ComputeAddress", metadata: { name: "web-ip" }, spec: { location: "global" } },
  { kind: "RunService", metadata: { name: "web" }, spec: { location: "europe-west1" } },
];

const ctx = { base: "https://compute.googleapis.com", project: "p1", manifest: lb };
const byKind = (kind: string) => lb.find((r) => r.kind === kind)!;
const plan = (kind: string) => MAPPERS[kind].plan(byKind(kind), ctx);

describe("compute load balancer mappers (#4233)", () => {
  test("apply order: service, NEG and address before the backend, map, proxy and forwarding rule", () => {
    const order = orderByReferences(lb).map((r) => r.kind);
    const at = (k: string) => order.indexOf(k);
    expect(at("RunService")).toBeLessThan(at("ComputeRegionNetworkEndpointGroup"));
    expect(at("ComputeRegionNetworkEndpointGroup")).toBeLessThan(at("ComputeBackendService"));
    expect(at("ComputeBackendService")).toBeLessThan(at("ComputeURLMap"));
    expect(at("ComputeURLMap")).toBeLessThan(at("ComputeTargetHTTPProxy"));
    expect(at("ComputeTargetHTTPProxy")).toBeLessThan(at("ComputeForwardingRule"));
    expect(at("ComputeAddress")).toBeLessThan(at("ComputeForwardingRule"));
  });

  test("a serverless NEG is regional and names its Cloud Run service", () => {
    expect(plan("ComputeRegionNetworkEndpointGroup")).toEqual({
      getUrl: "https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1/networkEndpointGroups/web",
      create: {
        method: "POST",
        url: "https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1/networkEndpointGroups",
        body: { name: "web", networkEndpointType: "SERVERLESS", cloudRun: { service: "web" } },
      },
    });
  });

  test("a global backend service points at the regional NEG by the NEG's own region", () => {
    expect(plan("ComputeBackendService").create).toEqual({
      method: "POST",
      url: "https://compute.googleapis.com/compute/v1/projects/p1/global/backendServices",
      body: {
        name: "web",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        protocol: "HTTPS",
        enableCDN: false,
        backends: [{ group: "projects/p1/regions/europe-west1/networkEndpointGroups/web" }],
      },
    });
  });

  test("URL map, proxy and forwarding rule resolve their refs to partial URLs", () => {
    expect(plan("ComputeURLMap").create.body).toEqual({ name: "web-map", defaultService: "projects/p1/global/backendServices/web" });
    expect(plan("ComputeTargetHTTPProxy").create.body).toEqual({ name: "web-proxy", urlMap: "projects/p1/global/urlMaps/web-map" });
    expect(plan("ComputeForwardingRule").create.body).toEqual({
      name: "web-fr",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      portRange: "80",
      IPProtocol: "TCP",
      IPAddress: "projects/p1/global/addresses/web-ip",
      target: "projects/p1/global/targetHttpProxies/web-proxy",
      labels: { tier: "edge", "managed-by": "chant" },
    });
  });

  test("a global address goes to the global collection, with the ownership label", () => {
    expect(plan("ComputeAddress")).toMatchObject({
      getUrl: "https://compute.googleapis.com/compute/v1/projects/p1/global/addresses/web-ip",
      create: { body: { name: "web-ip", labels: { "managed-by": "chant" } } },
    });
  });

  test("labels GCP refuses are left out", () => {
    expect(computeLabels({ "app.kubernetes.io/name": "x", Bad: "y", ok: "Value", good: "v-1" })).toEqual({ good: "v-1", "managed-by": "chant" });
  });

  test("an external ref is used as given", () => {
    const proxy: GcpResource = {
      kind: "ComputeTargetHTTPProxy",
      metadata: { name: "p" },
      spec: { location: "global", urlMapRef: { external: "projects/shared/global/urlMaps/m" } },
    };
    expect(MAPPERS.ComputeTargetHTTPProxy.plan(proxy, { base: "b", project: "p1" }).create.body).toEqual({
      name: "p",
      urlMap: "projects/shared/global/urlMaps/m",
    });
  });
});

describe("compute operations (#4233)", () => {
  test("the selfLink is rebased onto an endpoint override, and DONE ends the poll", () => {
    const op = { kind: "compute#operation", selfLink: "https://compute.googleapis.com/compute/v1/projects/p1/global/operations/op-1", status: "RUNNING" };
    expect(computeOperation.pollUrl(op, { base: "http://localhost:4588", project: "p1" })).toBe(
      "http://localhost:4588/compute/v1/projects/p1/global/operations/op-1",
    );
    expect(computeOperation.isDone({ status: "DONE" })).toBe(true);
    expect(computeOperation.error({ status: "DONE", error: { errors: [{ message: "quota" }] } })).toBe("quota");
    expect(computeOperation.pollUrl({ name: "web" }, { base: "b", project: "p1" })).toBeUndefined();
  });

  test("apply inserts, polls the operation, and leaves an existing resource alone", async () => {
    const calls: string[] = [];
    let exists = false;
    const http: GcpHttp = async (method, url) => {
      calls.push(`${method} ${url}`);
      if (method === "GET" && url.endsWith("/addresses/web-ip")) return exists ? { status: 200, text: "{}" } : { status: 404, text: "" };
      if (method === "POST") {
        exists = true;
        return { status: 200, text: JSON.stringify({ kind: "compute#operation", selfLink: "https://compute.googleapis.com/compute/v1/projects/p1/global/operations/op-1", status: "PENDING" }) };
      }
      if (url.includes("/operations/")) return { status: 200, text: JSON.stringify({ status: "DONE" }) };
      return { status: 500, text: "" };
    };
    const created = await applyResource(MAPPERS.ComputeAddress, byKind("ComputeAddress"), ctx, http);
    expect(created.created).toBe(true);
    expect(calls).toContain("GET https://compute.googleapis.com/compute/v1/projects/p1/global/operations/op-1");
    const again = await applyResource(MAPPERS.ComputeAddress, byKind("ComputeAddress"), ctx, http);
    expect(again).toMatchObject({ created: false, updated: false });
  });

  test("delete removes the resource at its scoped URL", async () => {
    const calls: string[] = [];
    const http: GcpHttp = async (method, url) => {
      calls.push(`${method} ${url}`);
      return { status: 200, text: JSON.stringify({ status: "DONE" }) };
    };
    await deleteResource(MAPPERS.ComputeRegionNetworkEndpointGroup, byKind("ComputeRegionNetworkEndpointGroup"), ctx, http);
    expect(calls[0]).toBe("DELETE https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1/networkEndpointGroups/web");
  });

  test("the reader reads a load balancer kind through the same URL", async () => {
    const http = async (_m: string, url: string) =>
      url.endsWith("/global/urlMaps/web-map") ? { status: 200, text: JSON.stringify({ name: "web-map" }) } : { status: 404, text: "" };
    const body = await getResource({ project: "p1", http }, "ComputeURLMap", "web-map", byKind("ComputeURLMap").spec);
    expect(body).toEqual({ name: "web-map" });
  });
});

describe("deep observe reads a load balancer back in the declared vocabulary (#4233)", () => {
  test("refs, renamed fields and the scope invert the body builders", async () => {
    const { toCnrmTree } = await import("../../deep-observe");
    const c = { project: "p1" };
    expect(
      toCnrmTree(
        "ComputeBackendService",
        {
          name: "web",
          selfLink: "https://compute.googleapis.com/compute/v1/projects/p1/global/backendServices/web",
          enableCDN: false,
          protocol: "HTTPS",
          backends: [{ group: "https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1/networkEndpointGroups/web" }],
        },
        c,
      ),
    ).toEqual({
      metadata: { name: "web" },
      selfLink: "https://compute.googleapis.com/compute/v1/projects/p1/global/backendServices/web",
      enableCdn: false,
      protocol: "HTTPS",
      location: "global",
      backend: [{ group: { networkEndpointGroupRef: { name: "web" } } }],
    });
    expect(
      toCnrmTree(
        "ComputeRegionNetworkEndpointGroup",
        { name: "web", region: "https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1", cloudRun: { service: "web" } },
        c,
      ),
    ).toMatchObject({ region: "europe-west1", cloudRun: { serviceRef: { name: "web" } } });
    expect(
      toCnrmTree("ComputeForwardingRule", { name: "fr", IPProtocol: "TCP", target: "projects/p1/global/targetHttpProxies/web-proxy" }, c),
    ).toMatchObject({ ipProtocol: "TCP", location: "global", target: { targetHTTPProxyRef: { name: "web-proxy" } } });
    expect(toCnrmTree("ComputeURLMap", { name: "m", defaultService: "projects/p1/global/backendServices/web" }, c)).toMatchObject({
      defaultService: { backendServiceRef: { name: "web" } },
    });
  });
});

describe("network and subnetwork mappers (#4248)", () => {
  const net: GcpResource[] = [
    {
      kind: "ComputeSubnetwork",
      metadata: { name: "apps" },
      spec: {
        region: "europe-west1",
        ipCidrRange: "10.0.0.0/24",
        networkRef: { name: "vpc" },
        privateIpGoogleAccess: true,
        secondaryIpRange: [{ rangeName: "pods", ipCidrRange: "10.4.0.0/14" }],
      },
    },
    { kind: "ComputeNetwork", metadata: { name: "vpc" }, spec: { routingMode: "REGIONAL" } },
    {
      kind: "RunService",
      metadata: { name: "web" },
      spec: { location: "europe-west1", template: { vpcAccess: { networkInterfaces: [{ networkRef: { name: "vpc" }, subnetworkRef: { name: "apps" } }] } } },
    },
  ];
  const nctx = { base: "https://compute.googleapis.com", project: "p1", manifest: net };
  const find = (kind: string) => net.find((r) => r.kind === kind)!;

  test("a network is global, with autoCreateSubnetworks false unless declared and the routing mode nested", () => {
    process.env.GCP_REGION = "us-east1";
    const plan = MAPPERS.ComputeNetwork.plan(find("ComputeNetwork"), nctx);
    expect(plan.create.url).toBe("https://compute.googleapis.com/compute/v1/projects/p1/global/networks");
    expect(plan.getUrl).toBe("https://compute.googleapis.com/compute/v1/projects/p1/global/networks/vpc");
    expect(plan.create.body).toEqual({ name: "vpc", autoCreateSubnetworks: false, routingConfig: { routingMode: "REGIONAL" } });
  });

  test("a subnetwork is regional and names its network by partial URL", () => {
    const plan = MAPPERS.ComputeSubnetwork.plan(find("ComputeSubnetwork"), nctx);
    expect(plan.create.url).toBe("https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1/subnetworks");
    expect(plan.create.body).toEqual({
      name: "apps",
      ipCidrRange: "10.0.0.0/24",
      privateIpGoogleAccess: true,
      network: "projects/p1/global/networks/vpc",
      secondaryIpRanges: [{ rangeName: "pods", ipCidrRange: "10.4.0.0/14" }],
    });
  });

  test("apply order: network, then subnetwork, then the Cloud Run service that egresses into them", () => {
    const order = orderByReferences(net).map((r) => r.kind);
    expect(order.indexOf("ComputeNetwork")).toBeLessThan(order.indexOf("ComputeSubnetwork"));
    expect(order.indexOf("ComputeSubnetwork")).toBeLessThan(order.indexOf("RunService"));
  });

  test("the reader reads a network at its global URL", async () => {
    const http = async (_m: string, url: string) =>
      url.endsWith("/global/networks/vpc") ? { status: 200, text: JSON.stringify({ name: "vpc" }) } : { status: 404, text: "" };
    expect(await getResource({ project: "p1", http }, "ComputeNetwork", "vpc", {})).toEqual({ name: "vpc" });
  });

  test("deep observe inverts both body builders", async () => {
    const { toCnrmTree } = await import("../../deep-observe");
    const c = { project: "p1" };
    expect(
      toCnrmTree(
        "ComputeNetwork",
        {
          name: "vpc",
          autoCreateSubnetworks: false,
          routingConfig: { routingMode: "REGIONAL" },
          subnetworks: ["https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1/subnetworks/apps"],
        },
        c,
      ),
    ).toEqual({ metadata: { name: "vpc" }, autoCreateSubnetworks: false, routingMode: "REGIONAL" });
    expect(
      toCnrmTree(
        "ComputeSubnetwork",
        {
          name: "apps",
          region: "https://compute.googleapis.com/compute/v1/projects/p1/regions/europe-west1",
          network: "https://compute.googleapis.com/compute/v1/projects/p1/global/networks/vpc",
          ipCidrRange: "10.0.0.0/24",
          gatewayAddress: "10.0.0.1",
          fingerprint: "abc",
          secondaryIpRanges: [{ rangeName: "pods", ipCidrRange: "10.4.0.0/14" }],
        },
        c,
      ),
    ).toEqual({
      metadata: { name: "apps" },
      region: "europe-west1",
      networkRef: { name: "vpc" },
      ipCidrRange: "10.0.0.0/24",
      secondaryIpRange: [{ rangeName: "pods", ipCidrRange: "10.4.0.0/14" }],
    });
  });
});
