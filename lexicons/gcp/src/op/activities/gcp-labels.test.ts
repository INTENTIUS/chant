import { describe, test, expect } from "vitest";
import { pubSubTopicMapper, secretManagerSecretMapper, storageBucketMapper, type GcpResource } from "./gcp-apply";
import { addressBody } from "./gcp-compute";
import { gcpResourceLabels } from "../../ownership";

const LABELS = {
  team: "data",
  "app.kubernetes.io/managed-by": "chant",
  "app.kubernetes.io/component": "queue",
  "chant.intentius.io/stack": "Web_App",
  "chant.intentius.io/env": "prod",
  Upper: "x",
  "9lives": "x",
};
const ctx = { base: "http://gcp", project: "p" };
const GCP_KEY = /^[a-z][a-z0-9_-]{0,62}$/;
const manifest = (kind: string): GcpResource => ({
  apiVersion: "x/v1",
  kind,
  metadata: { name: "r1", labels: LABELS },
  spec: {},
});
const ownership = { "managed-by": "chant", "chant-stack": "web_app", "chant-env": "prod" };
const expected = { team: "data", "managed-by": "chant", "chant-stack": "web_app", "chant-env": "prod" };

describe("manifest labels in GCP request bodies", () => {
  test("gcpResourceLabels keeps ownership as GCP forms and drops unrepresentable keys", () => {
    expect(gcpResourceLabels(LABELS)).toEqual(expected);
  });

  test("Pub/Sub create body and update envelope", () => {
    const plan = pubSubTopicMapper.plan(manifest("PubSubTopic"), ctx);
    expect((plan.create.body as { labels: object }).labels).toEqual(expected);
    const topic = (plan.update!.body as { topic: { labels: object } }).topic;
    expect(topic.labels).toEqual(expected);
  });

  test("Secret Manager (ownership only; user labels are not forwarded) create and update bodies", () => {
    const plan = secretManagerSecretMapper.plan(manifest("SecretManagerSecret"), ctx);
    expect((plan.create.body as { labels: object }).labels).toEqual(ownership);
    expect((plan.update!.body as { labels: object }).labels).toEqual(ownership);
  });

  test("Storage bucket body", () => {
    const plan = storageBucketMapper.plan(manifest("StorageBucket"), ctx);
    expect((plan.create.body as { labels: object }).labels).toEqual(ownership);
  });

  test("Compute body also carries chant-stack and chant-env", () => {
    const body = addressBody(manifest("ComputeAddress"), { base: "http://gcp", project: "p", manifest: [] } as never) as { labels: object };
    expect(body.labels).toEqual(expected);
  });

  test("every key sent is a legal GCP label key", () => {
    for (const k of Object.keys(gcpResourceLabels(LABELS))) expect(k).toMatch(GCP_KEY);
  });
});
