/**
 * Cloud Function with Pub/Sub trigger — event-driven function processing messages from a topic.
 */

import { CloudFunctionWithTrigger, PubSubPipeline, GCP } from "@intentius/chant-lexicon-gcp";
import { defaultAnnotations } from "@intentius/chant-lexicon-gcp";

export const annotations = defaultAnnotations({
  "cnrm.cloud.google.com/project-id": GCP.ProjectId,
});

export const { topic, subscription } = PubSubPipeline({
  name: "events",
  ackDeadlineSeconds: 30,
  messageRetentionDuration: "604800s",
  enableDeadLetterQueue: true,
  maxDeliveryAttempts: 5,
});

export const { function: eventProcessor, sourceBucket } = CloudFunctionWithTrigger({
  name: "event-processor",
  runtime: "nodejs20",
  entryPoint: "handleEvent",
  triggerType: "pubsub",
  triggerTopic: "events-topic",
  availableMemoryMb: "512M",
  timeout: 120,
  environmentVariables: {
    NODE_ENV: "production",
    LOG_LEVEL: "info",
  },
});
