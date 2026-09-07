/**
 * The watch (chant #1981): frame decoding on its own, then the whole watch
 * driven against the fake cluster, on the same request layer every other client
 * test uses, so kubeconfig parsing, discovery, auth and URL construction all
 * run for real and only the socket is fake. No cluster, no k3d, no timer past
 * a few milliseconds.
 */

import { describe, test, expect } from "vitest";
import { createK8sClient } from "./client";
import { isExpiredFrame, parseWatchFrames, resourceVersionOf, streamLines } from "./watch";
import {
  apiResourceList,
  expiredWatchFrame,
  fakeKubeconfig,
  fakeRequestLayer,
  fakeWatchStream,
  statusBody,
  watchFrame,
} from "./testing";
import type { RecordedRequest } from "./testing";

const CORE_V1 = apiResourceList("v1", [
  { name: "configmaps", kind: "ConfigMap" },
  { name: "namespaces", kind: "Namespace", namespaced: false },
]);
const APPS_V1 = apiResourceList("apps/v1", [{ name: "deployments", kind: "Deployment" }]);

const DISCOVERY: Record<string, unknown> = {
  "/api": { kind: "APIVersions", versions: ["v1"] },
  "/apis": {
    kind: "APIGroupList",
    groups: [{ name: "apps", preferredVersion: { groupVersion: "apps/v1", version: "v1" }, versions: [{ groupVersion: "apps/v1" }] }],
  },
  "/api/v1": CORE_V1,
  "/apis/apps/v1": APPS_V1,
};

function deployment(name: string, resourceVersion: string): Record<string, unknown> {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: "prod", resourceVersion },
  };
}

/** Wait for `predicate`, or give up. Never a bare sleep. */
async function waitFor(predicate: () => boolean, maxWaitMs = 3_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A fake cluster that answers discovery, one LIST per call (with an
 * incrementing `resourceVersion`), and hands each watch request the next
 * stream the test queued.
 */
function watchableCluster(streams: Array<ReturnType<typeof fakeWatchStream>>) {
  const state = { lists: 0, watches: [] as RecordedRequest[] };
  const layer = fakeRequestLayer((req) => {
    if (req.path in DISCOVERY) return { body: DISCOVERY[req.path] };
    if (req.query.watch === "1") {
      state.watches.push(req);
      const stream = streams.shift();
      if (!stream) return { status: 500, body: statusBody(500, "InternalError", "no stream queued") };
      return { stream };
    }
    if (req.path.endsWith("/deployments") || req.path.endsWith("/configmaps")) {
      state.lists++;
      return { body: { kind: "List", metadata: { resourceVersion: `rv-${state.lists}` }, items: [] } };
    }
    return { status: 404, body: statusBody(404, "NotFound", `${req.path} not found`) };
  });
  return { layer, state };
}

async function watchingClient(layer: ReturnType<typeof fakeRequestLayer>) {
  return createK8sClient({ kubeconfig: fakeKubeconfig(), requestLayer: layer });
}

describe("parseWatchFrames", () => {
  test("decodes whole NDJSON lines and carries the partial one over", () => {
    const first = parseWatchFrames('{"type":"ADDED","object":{"kind":"Pod"}}\n{"type":"MODI');
    expect(first.frames).toHaveLength(1);
    expect(first.frames[0].type).toBe("ADDED");
    expect(first.carry).toBe('{"type":"MODI');

    const second = parseWatchFrames('FIED","object":{"kind":"Pod"}}\n', first.carry);
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0].type).toBe("MODIFIED");
    expect(second.carry).toBe("");
  });

  test("drops a line that is not JSON, or JSON without a known type, and keeps going", () => {
    const { frames } = parseWatchFrames(
      ['not json at all', '{"type":"WAT","object":{}}', '{"nope":1}', '{"type":"DELETED","object":{}}', ""].join("\n"),
    );
    expect(frames.map((f) => f.type)).toEqual(["DELETED"]);
  });

  test("a frame with no object still decodes, rather than throwing", () => {
    const { frames } = parseWatchFrames('{"type":"BOOKMARK"}\n');
    expect(frames).toEqual([{ type: "BOOKMARK", object: {} }]);
  });
});

describe("isExpiredFrame / resourceVersionOf", () => {
  test("410 by code, and by reason for a cluster that sends only one", () => {
    expect(isExpiredFrame({ type: "ERROR", object: statusBody(410, "Expired", "too old") })).toBe(true);
    expect(isExpiredFrame({ type: "ERROR", object: { reason: "Gone" } })).toBe(true);
    expect(isExpiredFrame({ type: "ERROR", object: statusBody(500, "InternalError", "boom") })).toBe(false);
    // An ordinary event is never the expiry signal, whatever it carries.
    expect(isExpiredFrame({ type: "MODIFIED", object: { code: 410 } as never })).toBe(false);
  });

  test("reads the resumable resourceVersion, and nothing when there is none", () => {
    expect(resourceVersionOf({ type: "ADDED", object: deployment("api", "77") })).toBe("77");
    expect(resourceVersionOf({ type: "ADDED", object: { metadata: {} } })).toBeUndefined();
  });
});

describe("streamLines", () => {
  test("reassembles lines split across chunks, from bytes or strings", async () => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"a":'), encoder.encode("1}\n{\"b\":2}\n"), "tail-without-newline"];
    const source = (async function* () {
      yield* chunks;
    })();
    const lines: string[] = [];
    for await (const line of streamLines(source)) lines.push(line);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "tail-without-newline"]);
  });

  test("a web ReadableStream reads the same way", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("one\ntw"));
        controller.enqueue(encoder.encode("o\n"));
        controller.close();
      },
    });
    const lines: string[] = [];
    for await (const line of streamLines(stream)) lines.push(line);
    expect(lines).toEqual(["one", "two"]);
  });

  test("no stream at all yields nothing rather than throwing", async () => {
    const lines: string[] = [];
    for await (const line of streamLines(undefined)) lines.push(line);
    expect(lines).toEqual([]);
  });
});

describe("K8sClient.watch, against the fake cluster", () => {
  test("LISTs first for a resourceVersion, then opens the watch from it", async () => {
    const stream = fakeWatchStream();
    const { layer, state } = watchableCluster([stream]);
    const c = await watchingClient(layer);

    const seen: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", onEvent: (f) => seen.push(f.type) },
    );

    await waitFor(() => state.watches.length > 0);
    const request = state.watches[0];
    expect(request.path).toBe("/apis/apps/v1/namespaces/prod/deployments");
    expect(request.query.watch).toBe("1");
    expect(request.query.resourceVersion).toBe("rv-1");
    expect(request.query.allowWatchBookmarks).toBe("true");
    // The auth path ran for real, above the seam.
    expect(request.headers.Authorization).toBe("Bearer test-token");

    stream.push(watchFrame("ADDED", deployment("api", "43")));
    stream.push(watchFrame("MODIFIED", deployment("api", "44")));
    await waitFor(() => seen.length >= 2);
    expect(seen).toEqual(["ADDED", "MODIFIED"]);

    await handle.close();
  });

  test("no namespace watches across all of them, and a label selector rides along", async () => {
    const stream = fakeWatchStream();
    const { layer, state } = watchableCluster([stream]);
    const c = await watchingClient(layer);
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { labelSelector: "app.kubernetes.io/managed-by=chant" },
    );
    await waitFor(() => state.watches.length > 0);
    expect(state.watches[0].path).toBe("/apis/apps/v1/deployments");
    expect(state.watches[0].query.labelSelector).toBe("app.kubernetes.io/managed-by=chant");
    await handle.close();
  });

  test("a 410 Gone re-LISTs and resumes from the new resourceVersion, never retrying the stale one", async () => {
    const first = fakeWatchStream();
    const second = fakeWatchStream();
    const { layer, state } = watchableCluster([first, second]);
    const c = await watchingClient(layer);

    const seen: string[] = [];
    const errors: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", reopenDelayMs: 0, onEvent: (f) => seen.push(f.type), onError: (m) => errors.push(m) },
    );

    await waitFor(() => state.watches.length >= 1);
    first.push(expiredWatchFrame());

    await waitFor(() => state.watches.length >= 2);
    expect(state.watches[1].query.resourceVersion).toBe("rv-2"); // a fresh list, not "rv-1"
    expect(state.lists).toBe(2);

    // And the watch is still live: the expiry was a re-list, not an ending.
    second.push(watchFrame("ADDED", deployment("api", "99")));
    await waitFor(() => seen.length >= 1);
    expect(seen).toEqual(["ADDED"]);
    expect(errors).toEqual([]);

    await handle.close();
  });

  test("a stream the server closes cleanly is reopened from the last version seen", async () => {
    const first = fakeWatchStream();
    const second = fakeWatchStream();
    const { layer, state } = watchableCluster([first, second]);
    const c = await watchingClient(layer);

    const errors: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", reopenDelayMs: 0, onError: (m) => errors.push(m) },
    );

    await waitFor(() => state.watches.length >= 1);
    first.push(watchFrame("MODIFIED", deployment("api", "555")));
    await waitFor(() => first.delivered >= 1);
    first.close();

    await waitFor(() => state.watches.length >= 2);
    // Resumed from the frame, without paying for another LIST.
    expect(state.watches[1].query.resourceVersion).toBe("555");
    expect(state.lists).toBe(1);
    expect(errors).toEqual([]);

    await handle.close();
  });

  test("a watch that cannot be opened reports once through onError and ends, never throwing into the caller", async () => {
    const layer = fakeRequestLayer((req) => {
      if (req.path in DISCOVERY) return { body: DISCOVERY[req.path] };
      if (req.query.watch === "1") return { status: 403, body: statusBody(403, "Forbidden", "watch denied") };
      return { body: { kind: "List", metadata: { resourceVersion: "rv-1" }, items: [] } };
    });
    const c = await watchingClient(layer);

    const errors: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", onError: (m) => errors.push(m) },
    );

    await handle.done;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("watch denied");
    await handle.close(); // idempotent
    expect(errors).toHaveLength(1);
  });

  test("close() stops the watch, reports nothing, and is safe to call twice", async () => {
    const stream = fakeWatchStream();
    const { layer, state } = watchableCluster([stream]);
    const c = await watchingClient(layer);

    const errors: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", reopenDelayMs: 0, onError: (m) => errors.push(m) },
    );
    await waitFor(() => state.watches.length >= 1);

    await handle.close();
    await handle.close();
    await handle.done;
    // A closed watch is not a failed watch.
    expect(errors).toEqual([]);

    // And nothing reopens after the close.
    const watchesAtClose = state.watches.length;
    stream.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(state.watches.length).toBe(watchesAtClose);
  });

  test("an aborted caller signal closes the watch without reporting a failure", async () => {
    const stream = fakeWatchStream();
    const { layer, state } = watchableCluster([stream]);
    const c = await watchingClient(layer);
    const controller = new AbortController();

    const errors: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", reopenDelayMs: 0, signal: controller.signal, onError: (m) => errors.push(m) },
    );
    await waitFor(() => state.watches.length >= 1);

    controller.abort();
    await handle.done;
    expect(errors).toEqual([]);
  });

  test("a kind the cluster's discovery does not serve refuses by name, before any stream", async () => {
    const { layer } = watchableCluster([]);
    const c = await watchingClient(layer);
    await expect(c.watch({ apiVersion: "ray.io/v1", kind: "RayCluster" })).rejects.toThrow(/ray.io\/v1 RayCluster/);
  });

  test("a cluster-scoped kind watches without a namespace segment", async () => {
    const stream = fakeWatchStream();
    const layer = fakeRequestLayer((req) => {
      if (req.path in DISCOVERY) return { body: DISCOVERY[req.path] };
      if (req.query.watch === "1") return { stream };
      return { body: { kind: "List", metadata: { resourceVersion: "rv-1" }, items: [] } };
    });
    const c = await watchingClient(layer);
    const handle = await c.watch({ apiVersion: "v1", kind: "Namespace" }, { namespace: "ignored" });
    await waitFor(() => layer.requests.some((r) => r.query.watch === "1"));
    expect(layer.requests.find((r) => r.query.watch === "1")!.path).toBe("/api/v1/namespaces");
    await handle.close();
  });

  test("a transport with no streaming seam falls back to the complete body", async () => {
    // What a fixture returning a canned NDJSON document looks like: no
    // `stream`, just text. The watch reads it as frames and then ends the
    // stream, exactly as a server closing the connection would.
    const ndjson =
      [JSON.stringify(watchFrame("ADDED", deployment("api", "43"))), JSON.stringify(watchFrame("DELETED", deployment("api", "44")))].join("\n") + "\n";
    const held = fakeWatchStream(); // keeps the reopened watch open, as a server does
    let watches = 0;
    const layer = fakeRequestLayer((req) => {
      if (req.path in DISCOVERY) return { body: DISCOVERY[req.path] };
      if (req.query.watch === "1") {
        watches++;
        return watches === 1 ? { body: ndjson } : { stream: held };
      }
      return { body: { kind: "List", metadata: { resourceVersion: "rv-1" }, items: [] } };
    });
    const c = await watchingClient(layer);

    const seen: string[] = [];
    const handle = await c.watch(
      { apiVersion: "apps/v1", kind: "Deployment" },
      { namespace: "prod", reopenDelayMs: 0, onEvent: (f) => seen.push(f.type) },
    );
    await waitFor(() => seen.length >= 2);
    expect(seen).toEqual(["ADDED", "DELETED"]);
    await handle.close();
  });
});
