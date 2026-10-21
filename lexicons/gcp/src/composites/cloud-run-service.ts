/**
 * CloudRunServiceComposite composite — RunService + optional IAMPolicyMember for public access.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  CloudRunService as CloudRunServiceResource,
  IAMPolicyMember,
} from "../generated";
import { GCP } from "../pseudo";

export interface CloudRunServiceProps {
  /** Service name. */
  name: string;
  /** Container image. */
  image: string;
  /** GCP region (default: GCP.Region, resolved from GCP_REGION at build). */
  location?: string;
  /** GCP project the service runs in, as `projectRef.external` (default: GCP.ProjectId, resolved from GCP_PROJECT_ID at build). */
  projectId?: string;
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
  /** Service account the service runs as: an email, or the account id of an IAMServiceAccount in the project. */
  serviceAccount?: string;
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
 * import { CloudRunServiceComposite } from "@intentius/chant-lexicon-gcp";
 *
 * const { service, publicIam } = CloudRunServiceComposite({
 *   name: "my-api",
 *   projectId: "my-project",
 *   location: "us-central1",
 *   image: "gcr.io/my-project/my-api:latest",
 *   publicAccess: true,
 * });
 * ```
 */
export const CloudRunServiceComposite = Composite((props: CloudRunServiceProps) => {
  const {
    name,
    image,
    location,
    projectId,
    port = 8080,
    cpuLimit = "1000m",
    memoryLimit = "512Mi",
    maxInstanceRequestConcurrency = 80,
    minInstanceCount = 0,
    maxInstanceCount = 100,
    publicAccess = false,
    env,
    serviceAccount,
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
    location: location ?? GCP.Region,
    projectRef: { external: projectId ?? GCP.ProjectId },
    template: {
      maxInstanceRequestConcurrency,
      scaling: {
        minInstanceCount,
        maxInstanceCount,
      },
      containers,
      ...(serviceAccount && {
        serviceAccountRef: serviceAccount.includes("@") ? { external: serviceAccount } : { name: serviceAccount },
      }),
    },
  }, defs?.service));

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
