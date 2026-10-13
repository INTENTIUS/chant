import { describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { collectorHealthObserve, declaredEndpoints, splitEndpoint } from "./collector-health";

function fakeFetch(answers: Record<string, number | "refused">): { f: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const a = answers[url];
    if (a === undefined || a === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response("", { status: a });
  }) as typeof fetch;
  return { f, urls };
}

const withHealth = {
  extensions: { health_check: { endpoint: "0.0.0.0:13133" }, zpages: { endpoint: "localhost:55679" } },
  service: {
    extensions: ["health_check", "zpages"],
    telemetry: { metrics: { readers: [{ pull: { exporter: { prometheus: { host: "0.0.0.0", port: 8888 } } } }] } },
    pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] } },
  },
};

describe("the endpoints a collector config declares", () => {
  test("health_check, zpages and the pull reader's metrics, with 0.0.0.0 read as localhost", () => {
    expect(declaredEndpoints(withHealth)).toEqual([
      { kind: "healthCheck", url: "http://localhost:13133/" },
      { kind: "zpages", url: "http://localhost:55679/debug/servicez" },
      { kind: "telemetry", url: "http://localhost:8888/metrics" },
    ]);
  });

  test("health_check at its v0.130.0 default (localhost:13133, /) when it sets nothing, and its own path", () => {
    expect(declaredEndpoints({ extensions: { health_check: {} }, service: { extensions: ["health_check"] } })).toEqual([
      { kind: "healthCheck", url: "http://localhost:13133/" },
    ]);
    expect(
      declaredEndpoints({ extensions: { "health_check/ready": { endpoint: "${env:POD_IP}:8080", path: "/ready" } }, service: { extensions: ["health_check/ready"] } }),
    ).toEqual([{ kind: "healthCheck", url: "http://localhost:8080/ready" }]);
  });

  test("an extension declared but not enabled in service.extensions is not an endpoint", () => {
    expect(declaredEndpoints({ extensions: { health_check: {} }, service: {} })).toEqual([]);
  });

  test("the older telemetry address, host and URL overrides", () => {
    const cfg = { extensions: { health_check: {} }, service: { extensions: ["health_check"], telemetry: { metrics: { address: ":8888" } } } };
    expect(declaredEndpoints(cfg, "otel.example")).toEqual([
      { kind: "healthCheck", url: "http://otel.example:13133/" },
      { kind: "telemetry", url: "http://otel.example:8888/metrics" },
    ]);
    expect(declaredEndpoints(cfg, undefined, { healthCheck: "http://127.0.0.1:31333/" })[0]).toEqual({ kind: "healthCheck", url: "http://127.0.0.1:31333/" });
  });

  test("splitEndpoint reads host:port, :port and URLs", () => {
    expect(splitEndpoint("0.0.0.0:13133")).toEqual({ host: "0.0.0.0", port: "13133" });
    expect(splitEndpoint(":8888")).toEqual({ host: "", port: "8888" });
    expect(splitEndpoint("http://otel:13133/x")).toEqual({ host: "otel", port: "13133" });
    expect(splitEndpoint("nope")).toBeUndefined();
  });
});

describe("collectorHealthObserve", () => {
  test("one resource per collector: in-sync when every declared endpoint answers 200", async () => {
    const { f } = fakeFetch({ "http://localhost:13133/": 200, "http://localhost:55679/debug/servicez": 200, "http://localhost:8888/metrics": 200 });
    const r = await collectorHealthObserve({ collectors: [{ name: "gateway", configObject: withHealth }], _fetch: f, probeIntervalMs: 0 });
    expect(r.resources).toEqual([{ name: "gateway", status: "in-sync", detail: "health_check ok, zpages ok, telemetry ok" }]);
  });

  test("drifted when an endpoint answers otherwise or not at all, naming each", async () => {
    const { f, urls } = fakeFetch({ "http://localhost:13133/": 503, "http://localhost:55679/debug/servicez": 200 });
    const r = await collectorHealthObserve({ collectors: [{ name: "gateway", configObject: withHealth }], _fetch: f, probes: 2, probeIntervalMs: 0 });
    expect(r.resources[0].status).toBe("drifted");
    expect(r.resources[0].detail).toBe(
      "health_check http://localhost:13133/ answered 503; telemetry http://localhost:8888/metrics did not answer (ECONNREFUSED)",
    );
    // A failing endpoint is probed `probes` times before it counts.
    expect(urls.filter((u) => u === "http://localhost:13133/")).toHaveLength(2);
  });

  test("no health_check in service.extensions is unknown, never drifted, and nothing is probed", async () => {
    const { f, urls } = fakeFetch({});
    const r = await collectorHealthObserve({
      collectors: [{ name: "agent", configObject: { extensions: { zpages: {} }, service: { extensions: ["zpages"] } } }],
      _fetch: f,
    });
    expect(r.resources).toEqual([{ name: "agent", status: "unknown", detail: "no health_check in service.extensions" }]);
    expect(urls).toEqual([]);
  });

  test("an unreadable config is unknown", async () => {
    const r = await collectorHealthObserve({ collectors: [{ name: "x", config: "/nonexistent/collector.yaml" }] });
    expect(r.resources[0]).toMatchObject({ name: "x", status: "unknown" });
    expect(r.resources[0].detail).toMatch(/config unreadable/);
  });

  test("against a real HTTP server standing in for health_check", async () => {
    const server: Server = createServer((req, res) => {
      res.statusCode = req.url === "/" ? 200 : 404;
      res.end('{"status":"Server available"}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const config = { extensions: { health_check: { endpoint: `0.0.0.0:${port}` } }, service: { extensions: ["health_check"] } };
      const up = await collectorHealthObserve({ collectors: [{ name: "c", configObject: config, host: "127.0.0.1" }] });
      expect(up.resources[0].status).toBe("in-sync");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
