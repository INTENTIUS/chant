/**
 * CloudFunctionWithTrigger composite — CloudFunction + source bucket + optional PubSub/HTTP trigger + invoker IAM.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import {
  CloudFunction as CloudFunctionResource,
  StorageBucket,
  IAMPolicyMember,
} from "../generated";

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
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    function?: Partial<ConstructorParameters<typeof CloudFunctionResource>[0]>;
    sourceBucket?: Partial<ConstructorParameters<typeof StorageBucket>[0]>;
    invokerIam?: Partial<ConstructorParameters<typeof IAMPolicyMember>[0]>;
  };
}

export const CloudFunctionWithTrigger = Composite<CloudFunctionWithTriggerProps>((props) => {
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
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const sourceBucket = new StorageBucket(mergeDefaults({
    metadata: {
      name: `${name}-source`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "source" },
    },
    location: region ?? "US",
    uniformBucketLevelAccess: true,
  } as Record<string, unknown>, defs?.sourceBucket));

  const eventTrigger = triggerType === "pubsub" && triggerTopic
    ? { eventType: "google.cloud.pubsub.topic.v1.messagePublished", pubsubTopic: triggerTopic }
    : undefined;

  const fn = new CloudFunctionResource(mergeDefaults({
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
  } as Record<string, unknown>, defs?.function));

  const result: Record<string, any> = {
    function: fn,
    sourceBucket,
  };

  if (publicAccess && triggerType === "http") {
    result.invokerIam = new IAMPolicyMember(mergeDefaults({
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
    } as Record<string, unknown>, defs?.invokerIam));
  }

  return result;
}, "CloudFunctionWithTrigger");
