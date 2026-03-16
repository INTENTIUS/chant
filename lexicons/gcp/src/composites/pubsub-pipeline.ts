/**
 * PubSubPipeline composite — Topic + Subscription + optional DLQ topic + subscriber IAM binding.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { PubSubTopic, PubSubSubscription, IAMPolicyMember } from "../generated";

export interface PubSubPipelineProps {
  /** Pipeline name. */
  name: string;
  /** Subscription ack deadline in seconds (default: 10). */
  ackDeadlineSeconds?: number;
  /** Message retention duration (default: "604800s" = 7 days). */
  messageRetentionDuration?: string;
  /** Enable dead-letter queue (default: false). */
  enableDeadLetterQueue?: boolean;
  /** Max delivery attempts before sending to DLQ (default: 5). */
  maxDeliveryAttempts?: number;
  /** Service account email for subscriber IAM binding. */
  subscriberServiceAccount?: string;
  /** Additional labels. */
  labels?: Record<string, string>;
  /** Namespace for all resources. */
  namespace?: string;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    topic?: Partial<ConstructorParameters<typeof PubSubTopic>[0]>;
    subscription?: Partial<ConstructorParameters<typeof PubSubSubscription>[0]>;
    deadLetterTopic?: Partial<ConstructorParameters<typeof PubSubTopic>[0]>;
    subscriberIam?: Partial<ConstructorParameters<typeof IAMPolicyMember>[0]>;
  };
}

export const PubSubPipeline = Composite<PubSubPipelineProps>((props) => {
  const {
    name,
    ackDeadlineSeconds = 10,
    messageRetentionDuration = "604800s",
    enableDeadLetterQueue = false,
    maxDeliveryAttempts = 5,
    subscriberServiceAccount,
    labels: extraLabels = {},
    namespace,
    defaults: defs,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const topic = new PubSubTopic(mergeDefaults({
    metadata: {
      name: `${name}-topic`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "topic" },
    },
  } as Record<string, unknown>, defs?.topic));

  const subscriptionProps: Record<string, unknown> = {
    metadata: {
      name: `${name}-subscription`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "subscription" },
    },
    topicRef: { name: `${name}-topic` },
    ackDeadlineSeconds,
    messageRetentionDuration,
  };

  const result: Record<string, any> = { topic };

  if (enableDeadLetterQueue) {
    result.deadLetterTopic = new PubSubTopic(mergeDefaults({
      metadata: {
        name: `${name}-dlq`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "dead-letter" },
      },
    } as Record<string, unknown>, defs?.deadLetterTopic));

    subscriptionProps.deadLetterPolicy = {
      deadLetterTopicRef: { name: `${name}-dlq` },
      maxDeliveryAttempts,
    };
  }

  const subscription = new PubSubSubscription(mergeDefaults(
    subscriptionProps,
    defs?.subscription,
  ));

  result.subscription = subscription;

  if (subscriberServiceAccount) {
    result.subscriberIam = new IAMPolicyMember(mergeDefaults({
      metadata: {
        name: `${name}-subscriber`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "iam" },
      },
      member: `serviceAccount:${subscriberServiceAccount}`,
      role: "roles/pubsub.subscriber",
      resourceRef: {
        apiVersion: "pubsub.cnrm.cloud.google.com/v1beta1",
        kind: "PubSubSubscription",
        name: `${name}-subscription`,
      },
    } as Record<string, unknown>, defs?.subscriberIam));
  }

  return result;
}, "PubSubPipeline");
