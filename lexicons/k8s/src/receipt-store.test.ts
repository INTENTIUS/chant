/**
 * The k8s ConfigMap receipt row, end to end (#2074, epic #1703).
 *
 * Every leg runs against ./api/fake-cluster.ts, a real
 * `@intentius/chant-k8s-client` with only the HTTP send replaced, so no
 * ambient kubeconfig is read and no cluster is contacted. The three legs the
 * row has to close:
 *
 * 1. the `effect()` step materializes the receipt (the store's `write`);
 * 2. the k8s observation reads it back (`describeResources` and the deep
 *    read), with the stored value on `attributes.value` where core's
 *    `readReceiptValue` looks for it;
 * 3. WatchOp's staleness phase (`receiptStaleness`, #1834) fires on it.
 *
 * Plus the two things a receipt must NOT do: show up as property drift or as
 * an unclaimed field, and be swept by the owned-only prune.
 */

import { describe, test, expect } from "vitest";
import type { K8sObject } from "@intentius/chant-k8s-client";

const { k8sReceiptStore, observeReceiptRows, observeReceiptRowsDeep, receiptRowsFor, receiptValueOf } =
  await import("./receipt-store");
const { describeResources } = await import("./describe-resources");
const { observeResourcesDeepK8s } = await import("./deep-observe");
const { k8sDeepNormalizationHooks } = await import("./deep-observe-hooks");
const { fakeCluster, objectKey } = await import("./api/fake-cluster");
const {
  EffectReceipt,
  receiptConfigMapRef,
  renderReceiptComment,
  K8S_EFFECT_RECEIPT_ENTITY_TYPE,
  RECEIPT_DATA_KEY,
  RECEIPT_LABEL_KEY,
} = await import("./effect-receipt-row");
const { receiptActivities, receiptCheckInput } = await import("@intentius/chant/op/receipt-store");
const { receiptExpectation, EXISTENCE_EXPECTATION } = await import("@intentius/chant/effect-receipt");
const { readReceiptValue, planReceipts, observedValueResolver } = await import(
  "@intentius/chant/lifecycle/receipt-plan"
);
const { diffDeepObservation } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation } = await import("@intentius/chant/deep-observation");
const { statusBody } = await import("@intentius/chant-k8s-client/testing");

const IDENTITY = { stack: "demo", environment: "dev", namespace: "default" } as const;
const REF = receiptConfigMapRef("demo", "dev", "db-seed");

const seeded = EffectReceipt("seeded", { effect: "db-seed", flavor: "hash", inputs: { version: "0042" } });
const EXPECTED = receiptExpectation(seeded);

/** The build output the serializer produces for a project declaring `seeded`. */
function buildOutput(namespace = "default"): string {
  return `${renderReceiptComment({
    seeded: {
      kind: "ConfigMap",
      namespace,
      name: REF.name,
      data: { [RECEIPT_DATA_KEY]: EXPECTED },
    },
  })}\n`;
}

/** A live receipt ConfigMap holding `value`. */
function liveReceipt(value: string, namespace = "default"): K8sObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: REF.name,
      namespace,
      uid: "uid-receipt",
      resourceVersion: "3",
      labels: {
        "app.kubernetes.io/managed-by": "chant",
        "chant.intentius.io/stack": "demo",
        "chant.intentius.io/env": "dev",
        [RECEIPT_LABEL_KEY]: "db-seed",
      },
    },
    data: { [RECEIPT_DATA_KEY]: value },
  } as K8sObject;
}

/** Echo an applied object back, the way an API server does. */
const echoApplies = (req: { method: string; body?: unknown }) =>
  req.method === "PATCH" ? { body: JSON.parse(String(req.body)) } : undefined;

const store = (cluster: { connector: unknown }, namespace = "default") =>
  k8sReceiptStore({
    ...IDENTITY,
    namespace,
    connect: cluster.connector as never,
  });

// ── Leg 1: the effect step materializes the receipt ─────────────────────────

describe("k8sReceiptStore: the effect() step's sole write", () => {
  test("read answers undefined for a receipt that is not there", async () => {
    const cluster = fakeCluster();
    expect(await store(cluster).read({ name: "seeded", effect: "db-seed", flavor: "hash", inputs: {} })).toBeUndefined();
  });

  test("write applies a ConfigMap at the derived address, ownership-marked and receipt-labelled", async () => {
    const cluster = fakeCluster({ respond: echoApplies });
    await store(cluster).write({ name: "seeded", effect: "db-seed", flavor: "hash", inputs: {} }, EXPECTED);

    const patch = cluster.layer.requests.find((r) => r.method === "PATCH");
    expect(patch?.path).toBe(`/api/v1/namespaces/default/configmaps/${REF.name}`);
    const applied = JSON.parse(String(patch?.body)) as K8sObject;
    expect(applied.kind).toBe("ConfigMap");
    expect(applied.metadata?.name).toBe("chant-receipt.demo.dev.db-seed");
    expect(applied.metadata?.namespace).toBe("default");
    expect((applied as { data?: Record<string, string> }).data).toEqual({ [RECEIPT_DATA_KEY]: EXPECTED });
    expect(applied.metadata?.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "chant",
      "chant.intentius.io/stack": "demo",
      "chant.intentius.io/env": "dev",
      [RECEIPT_LABEL_KEY]: "db-seed",
    });
    expect(patch?.path).not.toContain("secrets");
  });

  test("write lands in the configured receipt namespace", async () => {
    const cluster = fakeCluster({ respond: echoApplies });
    await store(cluster, "chant-system").write(
      { name: "seeded", effect: "db-seed", flavor: "existence", inputs: {} },
      EXISTENCE_EXPECTATION,
    );
    const patch = cluster.layer.requests.find((r) => r.method === "PATCH");
    expect(patch?.path).toBe(`/api/v1/namespaces/chant-system/configmaps/${REF.name}`);
  });

  test("read gets back exactly what write stored, the round trip the effect step compares on", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt(EXPECTED) },
    });
    const activities = receiptActivities(store(cluster));
    const result = await activities.receiptRead(receiptCheckInput(seeded));
    expect(result.current).toBe(EXPECTED);
    expect(result.expectation).toBe(EXPECTED);
    expect(result.applied).toBe(true);
  });

  test("receiptValueOf reads only the expectation key, and nothing from an unrelated ConfigMap", () => {
    expect(receiptValueOf(liveReceipt("x"))).toBe("x");
    expect(receiptValueOf({ apiVersion: "v1", kind: "ConfigMap", data: { other: "x" } } as K8sObject)).toBeUndefined();
    expect(receiptValueOf(undefined)).toBeUndefined();
  });
});

// ── Leg 2: the observation reads it back ────────────────────────────────────

describe("the k8s observation reads the receipt back", () => {
  const entities = new Map([["seeded", { entityType: K8S_EFFECT_RECEIPT_ENTITY_TYPE, props: {} }]]);

  test("describeResources maps the stored value onto attributes.value, where the plan reads it", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt(EXPECTED) },
    });
    const result = await describeResources(
      { environment: "dev", buildOutput: buildOutput(), entityNames: ["seeded"], entities },
      cluster.connector,
    );

    expect(result.resources.seeded.type).toBe(K8S_EFFECT_RECEIPT_ENTITY_TYPE);
    expect(result.resources.seeded.status).toBe("EXTERNAL");
    expect(result.resources.seeded.ownership).toBe("owned");
    expect(readReceiptValue(result.resources.seeded.attributes)).toBe(EXPECTED);
    expect(result.unobserved?.seeded).toBeUndefined();
  });

  test("a receipt that is not there is a real absence, in neither map", async () => {
    const cluster = fakeCluster();
    const result = await describeResources(
      { environment: "dev", buildOutput: buildOutput(), entityNames: ["seeded"], entities },
      cluster.connector,
    );
    expect(result.resources.seeded).toBeUndefined();
    expect(result.unobserved?.seeded).toBeUndefined();
  });

  test("a failed read is a hole with a reason, never 'the effect never ran'", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path.includes("/configmaps/")
          ? { status: 403, body: statusBody(403, "Forbidden", "configmaps is forbidden") }
          : undefined,
    });
    const result = await describeResources(
      { environment: "dev", buildOutput: buildOutput(), entityNames: ["seeded"], entities },
      cluster.connector,
    );
    expect(result.resources.seeded).toBeUndefined();
    expect(result.unobserved?.seeded.reason).toBeDefined();
    expect(result.unobserved?.seeded.detail).toContain(REF.name);
  });

  test("without a receipt block in the build output nothing is read, and the entity is not invented", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt(EXPECTED) },
    });
    expect(receiptRowsFor(["seeded"], "")).toEqual(new Map());
    const result = await describeResources(
      { environment: "dev", buildOutput: "", entityNames: ["seeded"], entities },
      cluster.connector,
    );
    expect(result.resources.seeded).toBeUndefined();
  });

  test("the plan turns the reading into an effect row when stale and a noop when applied (#1832)", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt("sha256:something-else") },
    });
    const observed = await describeResources(
      { environment: "dev", buildOutput: buildOutput(), entityNames: ["seeded"], entities },
      cluster.connector,
    );
    const reading = {
      observed: true,
      present: true,
      value: readReceiptValue(observed.resources.seeded.attributes),
      lexicon: "k8s",
    };
    const stale = planReceipts(
      new Map([["seeded", seeded]]),
      new Map([["seeded", reading]]),
      observedValueResolver(observed.resources),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].action).toBe("effect");

    const applied = planReceipts(
      new Map([["seeded", seeded]]),
      new Map([["seeded", { ...reading, value: EXPECTED }]]),
      observedValueResolver(observed.resources),
    );
    expect(applied[0].action).toBe("noop");
  });
});

// ── The receipt is neither drift nor an unclaimed field ─────────────────────

describe("a receipt is never drift and never an unclaimed field (#2160)", () => {
  const entities = new Map([["seeded", { entityType: K8S_EFFECT_RECEIPT_ENTITY_TYPE, props: {} }]]);

  test("the deep read reports the receipt observed, with no property paths at all", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt(EXPECTED) },
    });
    const deep = await observeResourcesDeepK8s(
      { environment: "dev", buildOutput: buildOutput(), entityNames: ["seeded"], entities },
      cluster.connector,
    );
    expect(deep.resources.seeded.properties).toEqual({});
    expect(deep.resources.seeded.physicalId).toBe("uid-receipt");
    expect(deep.unobserved?.seeded).toBeUndefined();
  });

  test("the deep diff proposes nothing for it: no field drift, no unclaimed path", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt("sha256:stale") },
    });
    const deep = await observeResourcesDeepK8s(
      { environment: "dev", buildOutput: buildOutput(), entityNames: ["seeded"], entities },
      cluster.connector,
    );
    const diff = diffDeepObservation(entities, normalizeDeepObservation(deep), k8sDeepNormalizationHooks);
    expect(diff.drifted).toEqual([]);
    expect(diff.unclaimed).toEqual([]);
    expect(diff.held).toEqual([]);
    expect(diff.unobserved).toEqual([]);
    expect(diff.undeclaredEntities).toEqual([]);
    expect(diff.unchanged).toEqual(["seeded"]);
  });

  test("the receipt ConfigMap is not swept into any other entity's observation", async () => {
    const cluster = fakeCluster({
      objects: {
        [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt(EXPECTED),
        [objectKey("v1", "ConfigMap", "app-config", "default")]: {
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: "app-config", namespace: "default", uid: "uid-app" },
          data: { a: "1" },
        } as K8sObject,
      },
    });
    const result = await describeResources(
      {
        environment: "dev",
        buildOutput: buildOutput(),
        entityNames: ["seeded", "appConfig"],
        entities: new Map([
          ["seeded", { entityType: K8S_EFFECT_RECEIPT_ENTITY_TYPE, props: {} }],
          [
            "appConfig",
            { entityType: "K8s::Core::ConfigMap", props: { metadata: { name: "app-config", namespace: "default" } } },
          ],
        ]),
      },
      cluster.connector,
    );
    expect(Object.keys(result.resources).sort()).toEqual(["appConfig", "seeded"]);
    expect(result.resources.appConfig.physicalId).toBe("uid-app");
  });
});

// ── Leg 3: WatchOp staleness ────────────────────────────────────────────────

describe("WatchOp stale-receipt reporting over the k8s row (#1834)", () => {
  const inputs = [receiptCheckInput(seeded)];

  test("an absent receipt is reported stale, and nothing is written", async () => {
    const cluster = fakeCluster();
    const { receiptStaleness } = receiptActivities(store(cluster));
    const result = await receiptStaleness({ receipts: inputs });
    expect(result.stale).toBe(true);
    expect(result.findings).toEqual([
      { receipt: "seeded", effect: "db-seed", kind: "absent", expected: EXPECTED },
    ]);
    expect(cluster.layer.requests.some((r) => r.method === "PATCH" || r.method === "DELETE")).toBe(false);
  });

  test("a receipt holding a different value is reported stale with both values", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt("sha256:old") },
    });
    const { receiptStaleness } = receiptActivities(store(cluster));
    const result = await receiptStaleness({ receipts: inputs });
    expect(result.stale).toBe(true);
    expect(result.findings[0]).toEqual({
      receipt: "seeded",
      effect: "db-seed",
      kind: "differs",
      expected: EXPECTED,
      current: "sha256:old",
    });
  });

  test("a receipt that matches is not stale", async () => {
    const cluster = fakeCluster({
      objects: { [objectKey("v1", "ConfigMap", REF.name, "default")]: liveReceipt(EXPECTED) },
    });
    const { receiptStaleness } = receiptActivities(store(cluster));
    expect(await receiptStaleness({ receipts: inputs })).toEqual({ stale: false, findings: [] });
  });

  test("the activities barrel exports the three receipt activities by the names the registry resolves", async () => {
    const barrel = await import("./op/activities/index");
    expect(typeof barrel.receiptRead).toBe("function");
    expect(typeof barrel.receiptWrite).toBe("function");
    expect(typeof barrel.receiptStaleness).toBe("function");
  });
});

// ── The observation leg's own contract ──────────────────────────────────────

describe("observeReceiptRows", () => {
  test("reads only the entities the caller asked about", () => {
    const rows = receiptRowsFor(["seeded"], `${buildOutput()}`);
    expect([...rows.keys()]).toEqual(["seeded"]);
    expect(receiptRowsFor(["other"], buildOutput()).size).toBe(0);
  });

  test("the deep leg reports the same holes the thin leg does", async () => {
    const cluster = fakeCluster({
      respond: (req) =>
        req.path.includes("/configmaps/")
          ? { status: 500, body: statusBody(500, "InternalError", "boom") }
          : undefined,
    });
    const { client } = await cluster.connector({ environment: "dev" });
    const rows = receiptRowsFor(["seeded"], buildOutput());
    const thin = await observeReceiptRows(client, rows);
    const deep = await observeReceiptRowsDeep(client, rows);
    expect(Object.keys(thin.unobserved)).toEqual(["seeded"]);
    expect(Object.keys(deep.unobserved)).toEqual(["seeded"]);
    expect(deep.resources.seeded).toBeUndefined();
  });
});
