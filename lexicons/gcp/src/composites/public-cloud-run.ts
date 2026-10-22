/**
 * PublicCloudRun composite: a Cloud Run service behind a global external
 * Application Load Balancer, running as its own service account with Direct
 * VPC egress into a subnet.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  BackendService,
  ComputeAddress,
  ForwardingRule,
  GCPServiceAccount,
  ManagedSSLCertificate,
  RegionNetworkEndpointGroup,
  TargetHTTPProxy,
  TargetHTTPSProxy,
  URLMap,
} from "../generated";
import { GCP } from "../pseudo";
import { CloudRunServiceComposite } from "./cloud-run-service";

export interface PublicCloudRunProps {
  /** Name prefix every resource is named with. */
  name: string;
  /** Container image. */
  image: string;
  /** GCP region of the service and its network endpoint group. */
  region: string;
  /** GCP project, as `projectRef.external` (default: GCP.ProjectId, resolved from GCP_PROJECT_ID at build). */
  projectId?: string;
  /** VPC the service's egress goes into, such as a PrivateEgressNetwork's `vpc`. */
  vpc: { name: string };
  /** Subnet the service's egress goes into, such as a PrivateEgressNetwork's `subnet`. */
  subnet: { name: string };
  /** Egress sent through the VPC: "PRIVATE_RANGES_ONLY" or "ALL_TRAFFIC" (default: "PRIVATE_RANGES_ONLY"). */
  vpcEgress?: string;
  /** Port the container listens on (default: 8080). */
  port?: number;
  /** Port the HTTP forwarding rule listens on (default: 80). */
  frontendPort?: number;
  /** Minimum instances (default: 0). */
  minInstanceCount?: number;
  /** Maximum instances (default: 100). */
  maxInstanceCount?: number;
  /** Environment variables. */
  env?: Array<{ name: string; value: string }>;
  /** An existing service account to run as: an email, or the account id of an IAMServiceAccount in the project. When unset, the composite creates `<name>-run`. */
  serviceAccount?: string;
  /** Domains for a Google-managed certificate. When set, the composite adds an HTTPS proxy and a rule on 443, and the HTTP rule redirects to HTTPS. */
  domains?: string[];
  /** Name of a ComputeSecurityPolicy (Cloud Armor) attached to the backend service. */
  securityPolicy?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    runtime?: Partial<ConstructorParameters<typeof GCPServiceAccount>[0]>;
    service?: Record<string, unknown>;
    publicAccess?: Record<string, unknown>;
    neg?: Partial<ConstructorParameters<typeof RegionNetworkEndpointGroup>[0]>;
    backend?: Partial<ConstructorParameters<typeof BackendService>[0]>;
    urlMap?: Partial<ConstructorParameters<typeof URLMap>[0]>;
    proxy?: Partial<ConstructorParameters<typeof TargetHTTPProxy>[0]>;
    address?: Partial<ConstructorParameters<typeof ComputeAddress>[0]>;
    rule?: Partial<ConstructorParameters<typeof ForwardingRule>[0]>;
    certificate?: Partial<ConstructorParameters<typeof ManagedSSLCertificate>[0]>;
    httpsProxy?: Partial<ConstructorParameters<typeof TargetHTTPSProxy>[0]>;
    httpsRule?: Partial<ConstructorParameters<typeof ForwardingRule>[0]>;
    redirectMap?: Partial<ConstructorParameters<typeof URLMap>[0]>;
  };
}

/**
 * Create a PublicCloudRun composite.
 *
 * @example
 * ```ts
 * import { PrivateEgressNetwork, PublicCloudRun } from "@intentius/chant-lexicon-gcp";
 *
 * const network = PrivateEgressNetwork({ name: "web", region: "us-central1", subnetCidr: "10.10.0.0/24" });
 * const web = PublicCloudRun({
 *   name: "web",
 *   projectId: "my-project",
 *   region: "us-central1",
 *   vpc: network.vpc,
 *   subnet: network.subnet,
 *   image: "us-docker.pkg.dev/my-project/web/site:1",
 * });
 * ```
 */
export const PublicCloudRun = Composite((props: PublicCloudRunProps) => {
  const {
    name,
    image,
    region,
    projectId,
    vpc,
    subnet,
    vpcEgress = "PRIVATE_RANGES_ONLY",
    port = 8080,
    frontendPort = 80,
    minInstanceCount = 0,
    maxInstanceCount = 100,
    env,
    serviceAccount,
    domains,
    securityPolicy,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };
  const meta = (suffix: string, component: string) => ({
    name: `${name}-${suffix}`,
    ...(namespace && { namespace }),
    labels: { ...commonLabels, "app.kubernetes.io/component": component },
  });

  const result: Record<string, any> = {};

  if (!serviceAccount) {
    result.runtime = new GCPServiceAccount(mergeDefaults({
      metadata: meta("run", "service-account"),
      displayName: `${name} Cloud Run runtime`,
    } as Record<string, unknown>, defs?.runtime));
  }

  const run = CloudRunServiceComposite({
    name: `${name}-site`,
    image,
    projectId,
    location: region,
    port,
    minInstanceCount,
    maxInstanceCount,
    env,
    publicAccess: true,
    serviceAccount: serviceAccount ?? `${name}-run`,
    labels: extraLabels,
    namespace,
    defaults: {
      service: mergeDefaults({
        template: {
          vpcAccess: {
            egress: vpcEgress,
            networkInterfaces: [{ networkRef: { name: vpc.name }, subnetworkRef: { name: subnet.name } }],
          },
        },
      } as Record<string, unknown>, defs?.service) as any,
      publicIam: defs?.publicAccess as any,
    },
  });
  result.service = run.service;
  result.publicAccess = run.publicIam;

  const neg = new RegionNetworkEndpointGroup(mergeDefaults({
    metadata: meta("neg", "neg"),
    region,
    networkEndpointType: "SERVERLESS",
    cloudRun: { serviceRef: { name: run.service.name } },
  } as Record<string, unknown>, defs?.neg));

  // A backend service over a serverless NEG takes no health check: Cloud Run
  // reports its own readiness.
  const backend = new BackendService(mergeDefaults({
    metadata: meta("backend", "backend"),
    location: "global",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    protocol: "HTTP",
    backend: [{ group: { networkEndpointGroupRef: { name: neg.name } } }],
    ...(securityPolicy && { securityPolicyRef: { name: securityPolicy } }),
  } as Record<string, unknown>, defs?.backend));

  const urlMap = new URLMap(mergeDefaults({
    metadata: meta("map", "url-map"),
    location: "global",
    defaultService: { backendServiceRef: { name: backend.name } },
  } as Record<string, unknown>, defs?.urlMap));

  const address = new ComputeAddress(mergeDefaults({
    metadata: meta("ip", "address"),
    location: "global",
  } as Record<string, unknown>, defs?.address));

  Object.assign(result, { neg, backend, urlMap, address });

  // With domains, HTTPS serves the URL map and HTTP serves a redirect to it.
  let httpMapName: string = urlMap.name;
  if (domains && domains.length > 0) {
    const certificate = new ManagedSSLCertificate(mergeDefaults({
      metadata: meta("cert", "certificate"),
      projectRef: { external: projectId ?? GCP.ProjectId },
      managed: { domains },
    } as Record<string, unknown>, defs?.certificate));

    const httpsProxy = new TargetHTTPSProxy(mergeDefaults({
      metadata: meta("https-proxy", "proxy"),
      location: "global",
      urlMapRef: { name: urlMap.name },
      sslCertificates: [{ name: certificate.name }],
    } as Record<string, unknown>, defs?.httpsProxy));

    const httpsRule = new ForwardingRule(mergeDefaults({
      metadata: meta("https-rule", "forwarding-rule"),
      location: "global",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      portRange: "443",
      ipAddress: { addressRef: { name: address.name } },
      target: { targetHTTPSProxyRef: { name: httpsProxy.name } },
    } as Record<string, unknown>, defs?.httpsRule));

    const redirectMap = new URLMap(mergeDefaults({
      metadata: meta("redirect", "url-map"),
      location: "global",
      defaultUrlRedirect: { httpsRedirect: true, stripQuery: false },
    } as Record<string, unknown>, defs?.redirectMap));
    httpMapName = redirectMap.name;

    Object.assign(result, { certificate, httpsProxy, httpsRule, redirectMap });
  }

  result.proxy = new TargetHTTPProxy(mergeDefaults({
    metadata: meta("proxy", "proxy"),
    location: "global",
    urlMapRef: { name: httpMapName },
  } as Record<string, unknown>, defs?.proxy));

  result.rule = new ForwardingRule(mergeDefaults({
    metadata: meta("rule", "forwarding-rule"),
    location: "global",
    loadBalancingScheme: "EXTERNAL_MANAGED",
    portRange: String(frontendPort),
    ipAddress: { addressRef: { name: address.name } },
    target: { targetHTTPProxyRef: { name: result.proxy.name } },
  } as Record<string, unknown>, defs?.rule));

  return result;
}, "PublicCloudRun");
