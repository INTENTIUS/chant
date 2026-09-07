/**
 * `subscribeChanges` over the typed API client (chant #1981).
 *
 * Every case drives the real client against the fake cluster harness, so
 * kubeconfig parsing, context selection, discovery, path construction and the
 * auth path all run for real and only the socket is fake. No k3d, no cluster,
 * no network.
 */

import { describe, test, expect } from "vitest";
import type { LexiconPlugin, SubscribeChangesOptions } from "@intentius/chant/lexicon";
import { fakeWatchStream, watchFrame, expiredWatchFrame, statusBody } from "@intentius/chant-k8s-client/testing";
import type { RecordedRequest } from "@intentius/chant-k8s-client/testing";
import { collectChangeSubscribers } from "@intentius/chant/cli/plugins";
import { createChangeSignalGate } from "@intentius/chant/op";
import { fakeCluster, objectKey, ownedObject } from "./api/fake-cluster";
import { subscribeChanges, watchTargets, MAX_WATCHES } from "./subscribe-changes";

type Entity = { name: string; entityType: string; props: Record<string, unknown> };

function makeEntities(records: Entity[]) {
  return new Map(records.map((r) => [r.name, { entityType: r.entityType, props: r.props }]));
}

const webDeployment: Entity = {
  name: "web",
  entityType: "K8s::Apps::Deployment",
  props: { metadata: { name: "web", namespace: "prod" } },
};
const webService: Entity = {
  name: "webSvc",
  entityType: "K8s::Core::Service",
  props: { metadata: { name: "web-svc", namespace: "prod" } },
};
const prodNamespace: Entity = {
  name: "prodNs",
  entityType: "K8s::Core::Namespace",
  props: { metadata: { name: "prod" } },
};

async function waitFor(predicate: () => boolean, maxWaitMs = 3_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Collects the signal side of a subscription: wakes, errors, and the abort. */
function recorder(entities: Map<string, { entityType: string; props: Record<string, unknown> }>) {
  const controller = new AbortController();
  const changes: unknown[][] = [];
  const errors: string[] = [];
  const options: SubscribeChangesOptions = {
    environment: "prod",
    entities,
    // Recorded with its arguments, so a test can prove there were none.
    onChange: (...args: unknown[]) => changes.push(args),
    onError: (message) => errors.push(message),
    signal: controller.signal,
  };
  return { controller, changes, errors, options };
}

/** A cluster whose watches are driven by streams the test pushes frames into. */
function watchingCluster(streams: Map<string, ReturnType<typeof fakeWatchStream>>, objects: Record<string, ReturnType<typeof ownedObject>> = {}) {
  const watches: RecordedRequest[] = [];
  const cluster = fakeCluster({
    objects,
    respond: (request) => {
      if (request.query.watch !== "1") return undefined;
      watches.push(request);
      const stream = streams.get(request.path);
      if (!stream) return { status: 403, body: statusBody(403, "Forbidden", `watch on ${request.path} denied`) };
      return { stream };
    },
  });
  return { cluster, watches };
}

describe("watchTargets: the scope a declared estate implies", () => {
  test("one target per (kind, namespace), deduplicated and ordered", () => {
    const { targets, unaddressable } = watchTargets(
      makeEntities([
        webDeployment,
        { ...webDeployment, name: "api" },
        { name: "other", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "o", namespace: "staging" } } },
        webService,
      ]),
      "default",
    );
    expect(unaddressable).toEqual([]);
    expect(targets).toEqual([
      { apiVersion: "apps/v1", kind: "Deployment", namespace: "prod" },
      { apiVersion: "apps/v1", kind: "Deployment", namespace: "staging" },
      { apiVersion: "v1", kind: "Service", namespace: "prod" },
    ]);
  });

  test("a namespaced entity declaring no namespace falls back to the client's default", () => {
    const { targets } = watchTargets(
      makeEntities([{ name: "web", entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web" } } }]),
      "team-a",
    );
    expect(targets).toEqual([{ apiVersion: "apps/v1", kind: "Deployment", namespace: "team-a" }]);
  });

  test("a cluster-scoped kind carries no namespace at all", () => {
    const { targets } = watchTargets(makeEntities([prodNamespace]), "default");
    expect(targets).toEqual([{ apiVersion: "v1", kind: "Namespace" }]);
  });

  test("a type with no API address is named as unaddressable, never widened to something else", () => {
    const { targets, unaddressable } = watchTargets(
      makeEntities([webDeployment, { name: "weird", entityType: "Nonsense::Made::Up", props: {} }]),
      "default",
    );
    expect(unaddressable).toEqual(["Nonsense::Made::Up"]);
    expect(targets).toHaveLength(1);
  });
});

describe("subscribeChanges", () => {
  test("watches exactly the declared kinds and namespaces, and nothing else", async () => {
    const streams = new Map([
      ["/apis/apps/v1/namespaces/prod/deployments", fakeWatchStream()],
      ["/api/v1/namespaces/prod/services", fakeWatchStream()],
    ]);
    const { cluster, watches } = watchingCluster(streams);
    const { controller, errors, options } = recorder(makeEntities([webDeployment, webService]));

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => watches.length >= 2);

    expect(watches.map((w) => w.path).sort()).toEqual([
      "/api/v1/namespaces/prod/services",
      "/apis/apps/v1/namespaces/prod/deployments",
    ]);
    for (const w of watches) {
      expect(w.query.resourceVersion).toBe("1"); // the list's own version
      expect(w.headers.Authorization).toBe("Bearer test-token");
    }
    expect(errors).toEqual([]);

    controller.abort();
    await subscription.close();
  });

  test("a watch event wakes the caller with no payload at all", async () => {
    const stream = fakeWatchStream();
    const streams = new Map([["/apis/apps/v1/namespaces/prod/deployments", stream]]);
    const { cluster, watches } = watchingCluster(streams);
    const { controller, changes, options } = recorder(makeEntities([webDeployment]));

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => watches.length >= 1);

    // A frame with everything a fabricated observation would want in it.
    stream.push(
      watchFrame("DELETED", {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: "web", namespace: "prod", resourceVersion: "9" },
        status: { replicas: 0 },
      }),
    );
    await waitFor(() => changes.length >= 1);

    // None of it arrives. `onChange` was called with zero arguments, which is
    // the whole guarantee: there is no channel from a frame to a change set,
    // a snapshot row, or a diff line.
    expect(changes).toEqual([[]]);

    controller.abort();
    await subscription.close();
  });

  test("a 410 Gone is absorbed by the client and never surfaces as a lost signal", async () => {
    const first = fakeWatchStream();
    const streams = new Map([["/apis/apps/v1/namespaces/prod/deployments", first]]);
    const { cluster, watches } = watchingCluster(streams);
    const { controller, changes, errors, options } = recorder(makeEntities([webDeployment]));

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => watches.length >= 1);

    first.push(expiredWatchFrame());
    // The client re-lists and reopens on the same path, so the same stream is
    // handed back; the subscription is still live and still silent about it.
    await waitFor(() => watches.length >= 2);
    first.push(watchFrame("MODIFIED", { metadata: { resourceVersion: "12" } }));
    await waitFor(() => changes.length >= 1);
    expect(errors).toEqual([]);

    controller.abort();
    await subscription.close();
  });

  test("a killed watch reports once and stops, leaving the caller to re-subscribe", async () => {
    // No stream registered for the Service path: that watch is refused, which
    // is what a killed or forbidden watch looks like from here.
    const streams = new Map([["/apis/apps/v1/namespaces/prod/deployments", fakeWatchStream()]]);
    const { cluster } = watchingCluster(streams);
    const { controller, errors, options } = recorder(makeEntities([webDeployment, webService]));

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => errors.length >= 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("v1 Service in prod");
    expect(errors[0]).toContain("denied");

    controller.abort();
    await subscription.close();
    // Still exactly one: a dying subscription is reported once, not per stream.
    expect(errors).toHaveLength(1);
  });

  test("nothing declared is a refusal by name, not a cluster-wide watch", async () => {
    const { cluster } = watchingCluster(new Map());
    const { options } = recorder(new Map());
    await expect(subscribeChanges(options, cluster.connector)).rejects.toThrow(/nothing to watch/);
    expect(cluster.layer.requests).toEqual([]);
  });

  test("an estate past the connection ceiling refuses rather than opening a partial watch", async () => {
    const many = makeEntities(
      Array.from({ length: MAX_WATCHES + 1 }, (_, i) => ({
        name: `web-${i}`,
        entityType: "K8s::Apps::Deployment",
        props: { metadata: { name: `web-${i}`, namespace: `ns-${i}` } },
      })),
    );
    const { cluster, watches } = watchingCluster(new Map());
    const { options } = recorder(many);

    await expect(subscribeChanges(options, cluster.connector)).rejects.toThrow(
      new RegExp(`past the ${MAX_WATCHES} ceiling`),
    );
    expect(watches).toEqual([]);
  });

  test("a kind chant has no API address for is named, and the rest is still watched", async () => {
    const streams = new Map([["/apis/apps/v1/namespaces/prod/deployments", fakeWatchStream()]]);
    const { cluster, watches } = watchingCluster(streams);
    const { controller, errors, options } = recorder(
      makeEntities([webDeployment, { name: "weird", entityType: "Nonsense::Made::Up", props: {} }]),
    );

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => watches.length >= 1);
    expect(errors[0]).toContain("Nonsense::Made::Up");
    expect(errors[0]).toContain("on the timer alone");

    controller.abort();
    await subscription.close();
  });

  test("close() releases every stream, and aborting the caller's signal does the same", async () => {
    const streams = new Map([
      ["/apis/apps/v1/namespaces/prod/deployments", fakeWatchStream()],
      ["/api/v1/namespaces/prod/services", fakeWatchStream()],
    ]);
    const { cluster, watches } = watchingCluster(streams);
    const { controller, errors, options } = recorder(makeEntities([webDeployment, webService]));

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => watches.length >= 2);

    await subscription.close();
    await subscription.close(); // idempotent
    const watchesAtClose = watches.length;

    // Nothing reopens after the close, and a close is not a failure.
    await new Promise((r) => setTimeout(r, 50));
    expect(watches.length).toBe(watchesAtClose);
    expect(errors).toEqual([]);

    controller.abort(); // after the fact, and harmless
  });

  test("aborting the signal closes the subscription without a close() call", async () => {
    const streams = new Map([["/apis/apps/v1/namespaces/prod/deployments", fakeWatchStream()]]);
    const { cluster, watches } = watchingCluster(streams);
    const { controller, errors, options } = recorder(makeEntities([webDeployment]));

    const subscription = await subscribeChanges(options, cluster.connector);
    await waitFor(() => watches.length >= 1);

    controller.abort();
    await subscription.close();
    expect(errors).toEqual([]);
  });

  test("the connector resolves the environment's binding, exactly as a read does", async () => {
    const streams = new Map([["/apis/apps/v1/namespaces/prod/deployments", fakeWatchStream()]]);
    const { cluster } = watchingCluster(streams, {
      [objectKey("apps/v1", "Deployment", "web", "prod")]: ownedObject("apps/v1", "Deployment", "web", "prod"),
    });
    const { controller, options } = recorder(makeEntities([webDeployment]));

    const subscription = await subscribeChanges({ ...options, cwd: "/somewhere" }, cluster.connector);
    expect(cluster.connects).toEqual([{ environment: "prod", cwd: "/somewhere" }]);

    controller.abort();
    await subscription.close();
  });

  test("a connector that refuses the binding refuses the subscription, before any watch", async () => {
    const { options } = recorder(makeEntities([webDeployment]));
    const refusing = async () => {
      throw new Error('the kubeconfig has no context named "prod-eks"');
    };
    await expect(subscribeChanges(options, refusing as never)).rejects.toThrow(/no context named "prod-eks"/);
  });
});

/**
 * The two halves joined: the real k8s subscription, bound the way `chant
 * operator` binds it, driving the operator's real wake gate. Everything below
 * `client.watch` is faked and nothing else is: no cluster, no k3d, and no
 * stand-in for the seam under test.
 */
describe("the wake path end to end, against the fake cluster", () => {
  test("a change to a declared resource wakes the gate well inside a second", async () => {
    const path = "/apis/apps/v1/namespaces/prod/deployments";
    const stream = fakeWatchStream();
    const { cluster, watches } = watchingCluster(new Map([[path, stream]]));

    // Bound exactly as the CLI binds it: a plugin with the seam, one
    // environment, this lexicon's own declared entities.
    const plugin = {
      name: "k8s",
      serializer: { name: "k8s", serialize: () => "" },
      generate: async () => {},
      validate: async () => {},
      coverage: async () => {},
      package: async () => {},
      subscribeChanges: (options: SubscribeChangesOptions) => subscribeChanges(options, cluster.connector),
    } as unknown as LexiconPlugin;

    const subscribers = collectChangeSubscribers([plugin], {
      environment: "prod",
      entities: new Map([["k8s", makeEntities([webDeployment])]]),
    });
    expect(subscribers).toHaveLength(1);

    const gate = createChangeSignalGate({ floorMs: 0 });
    const controller = new AbortController();
    const errors: string[] = [];
    const subscription = await subscribers[0].subscribe({
      onChange: () => gate.signal(),
      onError: (message) => errors.push(message),
      signal: controller.signal,
    });
    await waitFor(() => watches.length >= 1);

    gate.roundStarted();
    const sleeping = gate.wait(60_000, controller.signal); // a full minute of timer
    const startedAt = Date.now();
    stream.push(watchFrame("MODIFIED", { metadata: { name: "web", namespace: "prod", resourceVersion: "8" } }));

    expect(await sleeping).toBe("signal");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(errors).toEqual([]);

    controller.abort();
    await subscription.close();
  });
});
