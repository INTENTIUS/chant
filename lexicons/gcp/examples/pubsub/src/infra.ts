/**
 * Pub/Sub topic with subscription and dead-letter topic.
 */

import {
  PubSubTopic, PubSubSubscription,
  GCP, defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const deadLetterTopic = new PubSubTopic({
  metadata: {
    name: "orders-dead-letter",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
});

export const deadLetterSubscription = new PubSubSubscription({
  metadata: {
    name: "orders-dead-letter-sub",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  topicRef: { name: "orders-dead-letter" },
  ackDeadlineSeconds: 60,
  messageRetentionDuration: "604800s",
});

export const ordersTopic = new PubSubTopic({
  metadata: {
    name: "orders-topic",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  messageRetentionDuration: "86400s",
});

export const ordersSubscription = new PubSubSubscription({
  metadata: {
    name: "orders-subscription",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  topicRef: { name: "orders-topic" },
  ackDeadlineSeconds: 30,
  messageRetentionDuration: "604800s",
  deadLetterPolicy: {
    deadLetterTopicRef: { name: "orders-dead-letter" },
    maxDeliveryAttempts: 10,
  },
  retryPolicy: {
    minimumBackoff: "10s",
    maximumBackoff: "600s",
  },
});
