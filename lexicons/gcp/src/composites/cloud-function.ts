/**
 * CloudFunctionWithTrigger composite — CloudFunction + source bucket + optional PubSub/HTTP trigger + invoker IAM.
 */

export interface CloudFunctionWithTriggerProps {
  /** Function name. */
  name: string;
  /** Runtime (e.g., "nodejs20", "python312"). */
  runtime: string;
  /** Entry point function name. */
  entryPoint: string;
  /** GCP region. */
  region?: string;
  /** Available memory (default: "256M"). */
  availableMemoryMb?: string;
  /** Timeout in seconds (default: 60). */
  timeout?: number;
  /** Trigger type (default: "http"). */
  triggerType?: "http" | "pubsub";
  /** PubSub topic name (required if triggerType is "pubsub"). */
  triggerTopic?: string;
  /** Allow unauthenticated HTTP invocations (default: false). */
  publicAccess?: boolean;
  /** Environment variables. */
  environmentVariables?: Record<string, string>;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
}

export interface CloudFunctionWithTriggerResult {
  function: Record<string, unknown>;
  sourceBucket: Record<string, unknown>;
  invokerIam?: Record<string, unknown>;
}

export function CloudFunctionWithTrigger(props: CloudFunctionWithTriggerProps): CloudFunctionWithTriggerResult {
  const {
    name,
    runtime,
    entryPoint,
    region,
    availableMemoryMb = "256M",
    timeout = 60,
    triggerType = "http",
    triggerTopic,
    publicAccess = false,
    environmentVariables,
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const sourceBucket: Record<string, unknown> = {
    metadata: {
      name: `${name}-source`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "source" },
    },
    location: region ?? "US",
    uniformBucketLevelAccess: true,
  };

  const eventTrigger = triggerType === "pubsub" && triggerTopic
    ? { eventType: "google.cloud.pubsub.topic.v1.messagePublished", pubsubTopic: triggerTopic }
    : undefined;

  const fn: Record<string, unknown> = {
    metadata: {
      name,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "function" },
    },
    ...(region && { location: region }),
    runtime,
    entryPoint,
    availableMemoryMb,
    timeout: `${timeout}s`,
    buildConfig: {
      sourceRef: {
        storageBucketRef: { name: `${name}-source` },
      },
    },
    ...(eventTrigger && { eventTrigger }),
    ...(environmentVariables && { environmentVariables }),
  };

  const result: CloudFunctionWithTriggerResult = {
    function: fn,
    sourceBucket,
  };

  if (publicAccess && triggerType === "http") {
    result.invokerIam = {
      metadata: {
        name: `${name}-invoker`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "iam" },
      },
      member: "allUsers",
      role: "roles/cloudfunctions.invoker",
      resourceRef: {
        apiVersion: "cloudfunctions.cnrm.cloud.google.com/v1beta1",
        kind: "CloudFunctionsFunction",
        name,
      },
    };
  }

  return result;
}
