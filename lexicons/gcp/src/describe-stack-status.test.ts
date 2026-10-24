import { describe, test, expect } from "vitest";
import { describeStackStatus } from "./describe-stack-status";
import { pubSubTopicMapper, type GcpResource } from "./op/activities/gcp-apply";

/** Mocked read transport: topics list returns what the applier would have stamped. */
function httpWith(topics: Array<{ name: string; labels?: Record<string, string> }>) {
  return async (_method: string, url: string) =>
    url.includes("pubsub")
      ? { status: 200, text: JSON.stringify({ topics }) }
      : { status: 200, text: JSON.stringify({ items: [] }) };
}

describe("describeStackStatus with gcp-apply stamped labels (#3143)", () => {
  const manifest: GcpResource = {
    apiVersion: "pubsub.cnrm.cloud.google.com/v1beta1",
    kind: "PubSubTopic",
    metadata: {
      name: "events",
      labels: {
        "app.kubernetes.io/managed-by": "chant",
        "chant.intentius.io/stack": "Shop Front",
      },
    },
    spec: {},
  };
  const stamped = (pubSubTopicMapper.plan(manifest, { base: "http://x", project: "p" }).create.body as {
    labels: Record<string, string>;
  }).labels;

  test("a unit applied with no hand-written chant-stack label is attributed", async () => {
    const status = await describeStackStatus(
      { environment: "prod", stack: "Shop Front" },
      { project: "p", http: httpWith([{ name: "projects/p/topics/events", labels: stamped }]) },
    );
    expect(status).toMatchObject({ stack: "Shop Front", present: true, healthy: true });
  });

  test("another stack's resource does not count", async () => {
    const status = await describeStackStatus(
      { environment: "prod", stack: "other" },
      { project: "p", http: httpWith([{ name: "projects/p/topics/events", labels: stamped }]) },
    );
    expect(status).toEqual({ stack: "other", present: false });
  });
});
