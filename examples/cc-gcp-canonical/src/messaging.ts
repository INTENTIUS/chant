import { PubSubTopic, PubSubSubscription } from "@intentius/chant-lexicon-gcp";

export const events = new PubSubTopic({
  metadata: { name: "cc-gcp-events" },
});

// The `topicRef` is the estate's one reference edge — the applier orders the
// topic before the subscription from it, and the deep reader maps the live
// topic path back onto this spelling.
export const worker = new PubSubSubscription({
  metadata: { name: "cc-gcp-worker" },
  topicRef: { name: "cc-gcp-events" },
});
