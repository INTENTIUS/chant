/**
 * Cloud Function with Pub/Sub trigger — event-driven function processing messages from a topic.
 */

import {
  CloudFunction, StorageBucket, PubSubTopic, PubSubSubscription,
  GCP, defaultAnnotations,
} from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const eventsTopic = new PubSubTopic({
  metadata: {
    name: "events-topic",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
});

export const eventsSubscription = new PubSubSubscription({
  metadata: {
    name: "events-subscription",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  topicRef: { name: "events-topic" },
  ackDeadlineSeconds: 30,
  messageRetentionDuration: "604800s",
});

export const sourceBucket = new StorageBucket({
  metadata: {
    name: "event-processor-source",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  location: "US",
  uniformBucketLevelAccess: true,
});

export const eventProcessor = new CloudFunction({
  metadata: {
    name: "event-processor",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  region: "us-central1",
  runtime: "nodejs20",
  entryPoint: "handleEvent",
  availableMemoryMb: 512,
  timeout: "120s",
  eventTrigger: {
    eventType: "providers/cloud.pubsub/eventTypes/topic.publish",
    resourceRef: {
      name: "events-topic",
      kind: "PubSubTopic",
    },
  },
  environmentVariables: {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
  },
});
