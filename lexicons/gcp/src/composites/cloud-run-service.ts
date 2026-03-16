/**
 * CloudRunServiceComposite composite — RunService + optional IAMPolicyMember for public access.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  CloudRunService as CloudRunServiceResource,
  IAMPolicyMember,
} from "../generated";

export interface CloudRunServiceProps {
  /** Service name. */
  name: string;
  /** Container image. */
  image: string;
  /** GCP region. */
  location?: string;
  /** Port the container listens on (default: 8080). */
  port?: number;
  /** CPU limit (default: "1000m"). */
  cpuLimit?: string;
  /** Memory limit (default: "512Mi"). */
  memoryLimit?: string;
  /** Maximum concurrent requests per instance (default: 80). */
  maxInstanceRequestConcurrency?: number;
  /** Minimum instances (default: 0). */
  minInstanceCount?: number;
  /** Maximum instances (default: 100). */
  maxInstanceCount?: number;
  /** Enable public (unauthenticated) access (default: false). */
  publicAccess?: boolean;
  /** Environment variables. */
  env?: Array<{ name: string; value: string }>;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    service?: Partial<ConstructorParameters<typeof CloudRunServiceResource>[0]>;
    publicIam?: Partial<ConstructorParameters<typeof IAMPolicyMember>[0]>;
  };
}

/**
 * Create a CloudRunService composite.
 *
 * @example
 * ```ts
 * import { CloudRunService } from "@intentius/chant-lexicon-gcp";
 *
 * const { service, publicIam } = CloudRunService({
 *   name: "my-api",
 *   image: "gcr.io/my-project/my-api:latest",
 *   publicAccess: true,
 * });
 * ```
 */
export const CloudRunServiceComposite = Composite<CloudRunServiceProps>((props) => {
  const {
    name,
    image,
    location,
    port = 8080,
    cpuLimit = "1000m",
    memoryLimit = "512Mi",
    maxInstanceRequestConcurrency = 80,
    minInstanceCount = 0,
    maxInstanceCount = 100,
    publicAccess = false,
    env,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const containers: Record<string, unknown>[] = [
    {
      image,
      ports: [{ containerPort: port, name: "http1" }],
      resources: {
        limits: { cpu: cpuLimit, memory: memoryLimit },
      },
      ...(env && env.length > 0 && { env }),
    },
  ];

  const service = new CloudRunServiceResource(mergeDefaults({
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "service" },
    },
    ...(location && { location }),
    template: {
      maxInstanceRequestConcurrency,
      scaling: {
        minInstanceCount,
        maxInstanceCount,
      },
      containers,
    },
  } as Record<string, unknown>, defs?.service));

  const result: Record<string, any> = { service };

  if (publicAccess) {
    result.publicIam = new IAMPolicyMember(mergeDefaults({
      metadata: {
        name: `${name}-public`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "iam" },
      },
      member: "allUsers",
      role: "roles/run.invoker",
      resourceRef: {
        apiVersion: "run.cnrm.cloud.google.com/v1beta1",
        kind: "RunService",
        name,
      },
    } as Record<string, unknown>, defs?.publicIam));
  }

  return result;
}, "CloudRunServiceComposite");
