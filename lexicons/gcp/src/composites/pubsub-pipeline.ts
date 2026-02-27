/**
 * PubSubPipeline composite — Topic + Subscription + optional DLQ topic + subscriber IAM binding.
 */

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
}

export interface PubSubPipelineResult {
  topic: Record<string, unknown>;
  subscription: Record<string, unknown>;
  deadLetterTopic?: Record<string, unknown>;
  subscriberIam?: Record<string, unknown>;
}

export function PubSubPipeline(props: PubSubPipelineProps): PubSubPipelineResult {
  const {
    name,
    ackDeadlineSeconds = 10,
    messageRetentionDuration = "604800s",
    enableDeadLetterQueue = false,
    maxDeliveryAttempts = 5,
    subscriberServiceAccount,
    labels: extraLabels = {},
    namespace,
  } = props;

  const commonLabels: Record<string, string> = {
    "app.kubernetes.io/name": name,
    "app.kubernetes.io/managed-by": "chant",
    ...extraLabels,
  };

  const topic: Record<string, unknown> = {
    metadata: {
      name: `${name}-topic`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "topic" },
    },
  };

  const subscription: Record<string, unknown> = {
    metadata: {
      name: `${name}-subscription`,
      ...(namespace && { namespace }),
      labels: { ...commonLabels, "app.kubernetes.io/component": "subscription" },
    },
    topicRef: { name: `${name}-topic` },
    ackDeadlineSeconds,
    messageRetentionDuration,
  };

  const result: PubSubPipelineResult = { topic, subscription };

  if (enableDeadLetterQueue) {
    result.deadLetterTopic = {
      metadata: {
        name: `${name}-dlq`,
        ...(namespace && { namespace }),
        labels: { ...commonLabels, "app.kubernetes.io/component": "dead-letter" },
      },
    };
    subscription.deadLetterPolicy = {
      deadLetterTopicRef: { name: `${name}-dlq` },
      maxDeliveryAttempts,
    };
  }

  if (subscriberServiceAccount) {
    result.subscriberIam = {
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
    };
  }

  return result;
}
