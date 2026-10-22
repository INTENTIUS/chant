import { describe, test, expect } from "vitest";
import { PrivateEgressNetwork } from "./private-egress-network";
import { PublicCloudRun } from "./public-cloud-run";

/** Helper to extract props from a Declarable member. */
function p(member: unknown): Record<string, any> {
  return (member as any).props;
}

/** The metadata.name a `{ name }` reference resolves to: a literal, or another member's name attribute. */
function refName(ref: { name: unknown }): unknown {
  const value = ref.name as any;
  return value?.parent?.deref ? p(value.parent.deref()).metadata.name : value;
}

const net = { vpc: { name: "web-vpc" }, subnet: { name: "web-apps" } };
const base = { name: "web", projectId: "proj", region: "us-central1", image: "img:1", ...net };

describe("PrivateEgressNetwork (#4263)", () => {
  test("a custom-mode VPC and one subnet in the region", () => {
    const { vpc, subnet } = PrivateEgressNetwork({ name: "web", region: "us-central1", subnetCidr: "10.10.0.0/24" });
    expect(p(vpc).metadata.name).toBe("web-vpc");
    expect(p(vpc).autoCreateSubnetworks).toBe(false);
    expect(p(vpc).routingMode).toBe("REGIONAL");
    expect(p(subnet).metadata.name).toBe("web-apps");
    expect(p(subnet).region).toBe("us-central1");
    expect(p(subnet).ipCidrRange).toBe("10.10.0.0/24");
    expect(p(subnet).privateIpGoogleAccess).toBe(true);
  });
});

describe("PublicCloudRun (#4263)", () => {
  test("creates its own service account and runs the service as it", () => {
    const r = PublicCloudRun(base);
    expect(p(r.runtime).metadata.name).toBe("web-run");
    expect(p(r.service).metadata.name).toBe("web-site");
    expect(refName(p(r.service).template.serviceAccountRef)).toBe("web-run");
    expect(p(r.service).projectRef).toEqual({ external: "proj" });
    expect(p(r.publicAccess).member).toBe("allUsers");
  });

  test("an existing serviceAccount creates no account", () => {
    const r = PublicCloudRun({ ...base, serviceAccount: "x@o.iam.gserviceaccount.com" });
    expect(r.runtime).toBeUndefined();
    expect(p(r.service).template.serviceAccountRef).toEqual({ external: "x@o.iam.gserviceaccount.com" });
  });

  test("Direct VPC egress into the subnet for private ranges", () => {
    const r = PublicCloudRun(base);
    expect(p(r.service).template.vpcAccess).toEqual({
      egress: "PRIVATE_RANGES_ONLY",
      networkInterfaces: [{ networkRef: { name: "web-vpc" }, subnetworkRef: { name: "web-apps" } }],
    });
  });

  test("the load balancer chain: NEG, backend, URL map, HTTP proxy, address, rule", () => {
    const r = PublicCloudRun(base);
    expect(p(r.neg).networkEndpointType).toBe("SERVERLESS");
    expect(refName(p(r.neg).cloudRun.serviceRef)).toBe("web-site");
    expect(p(r.backend).loadBalancingScheme).toBe("EXTERNAL_MANAGED");
    expect(p(r.backend).healthChecks).toBeUndefined();
    expect(refName(p(r.backend).backend[0].group.networkEndpointGroupRef)).toBe("web-neg");
    expect(refName(p(r.urlMap).defaultService.backendServiceRef)).toBe("web-backend");
    expect(refName(p(r.proxy).urlMapRef)).toBe("web-map");
    expect(p(r.address).location).toBe("global");
    expect(p(r.rule).portRange).toBe("80");
    expect(refName(p(r.rule).ipAddress.addressRef)).toBe("web-ip");
    expect(refName(p(r.rule).target.targetHTTPProxyRef)).toBe("web-proxy");
    expect(r.certificate).toBeUndefined();
  });

  test("port sets the container, frontendPort the HTTP rule", () => {
    const r = PublicCloudRun({ ...base, port: 3000, frontendPort: 8080 });
    expect(p(r.service).template.containers[0].ports[0].containerPort).toBe(3000);
    expect(p(r.rule).portRange).toBe("8080");
  });

  test("domains add a managed certificate and HTTPS, and HTTP redirects", () => {
    const r = PublicCloudRun({ ...base, domains: ["example.com"] });
    expect(p(r.certificate).managed.domains).toEqual(["example.com"]);
    expect(refName(p(r.httpsProxy).urlMapRef)).toBe("web-map");
    expect(refName(p(r.httpsProxy).sslCertificates[0])).toBe("web-cert");
    expect(p(r.httpsRule).portRange).toBe("443");
    expect(refName(p(r.httpsRule).target.targetHTTPSProxyRef)).toBe("web-https-proxy");
    expect(p(r.redirectMap).defaultUrlRedirect.httpsRedirect).toBe(true);
    expect(refName(p(r.proxy).urlMapRef)).toBe("web-redirect");
  });

  test("securityPolicy attaches to the backend service", () => {
    const r = PublicCloudRun({ ...base, securityPolicy: "edge" });
    expect(refName(p(r.backend).securityPolicyRef)).toBe("edge");
  });
});
