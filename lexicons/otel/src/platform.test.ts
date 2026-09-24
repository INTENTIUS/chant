import { describe, expect, test } from "vitest";
import { collectorEndpoints, otlpCollector, COLLECTOR_IMAGE, COLLECTOR_CONFIG_PATH } from "./platform";
import { buildCollectorConfig } from "./collector";
import { validateCollectorConfig } from "./validate-config";
import type { CollectorConfig } from "./model";

describe("otlpCollector", () => {
  test("the default is OTLP in, memory_limiter then batch, debug out, health_check, every signal", () => {
    const { config } = buildCollectorConfig(otlpCollector());
    expect(validateCollectorConfig(config)).toEqual([]);
    expect(Object.keys(config.receivers ?? {})).toEqual(["otlp"]);
    expect(Object.keys(config.exporters ?? {})).toEqual(["debug"]);
    expect(config.service?.extensions).toEqual(["health_check"]);
    expect(Object.keys(config.service?.pipelines ?? {}).sort()).toEqual(["logs", "metrics", "traces"]);
    expect(config.service?.pipelines?.traces?.processors).toEqual(["memory_limiter", "batch"]);
  });

  test("signals and healthCheck narrow it", () => {
    const { config } = buildCollectorConfig(otlpCollector({ signals: ["traces"], healthCheck: false }));
    expect(Object.keys(config.service?.pipelines ?? {})).toEqual(["traces"]);
    expect(config.extensions).toBeUndefined();
  });
});

describe("collectorEndpoints", () => {
  test("the default config listens on otlp-grpc and otlp-http, with a health check on 13133", () => {
    const { config } = buildCollectorConfig(otlpCollector());
    expect(collectorEndpoints(config)).toEqual({
      ports: [
        { name: "otlp-grpc", port: 4317 },
        { name: "otlp-http", port: 4318 },
      ],
      healthCheck: { port: 13133, path: "/" },
    });
  });

  test("a named receiver's ports carry its name, and a repeated port is listed once", () => {
    const config: CollectorConfig = {
      receivers: {
        "otlp/edge": { protocols: { grpc: { endpoint: "0.0.0.0:14317" } } },
        "otlp/again": { protocols: { grpc: { endpoint: "0.0.0.0:14317" } } },
      },
    };
    expect(collectorEndpoints(config).ports).toEqual([{ name: "otlp-edge-grpc", port: 14317 }]);
  });

  test("port names are cut to 15 characters", () => {
    const config: CollectorConfig = {
      receivers: { "otlp/very_long_name": { protocols: { http: { endpoint: "0.0.0.0:4318" } } } },
    };
    const [port] = collectorEndpoints(config).ports;
    expect(port.name.length).toBeLessThanOrEqual(15);
    expect(port.name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  test("a health_check on localhost, or one the service does not enable, is not a health check", () => {
    const local: CollectorConfig = {
      extensions: { health_check: { endpoint: "localhost:13133" } },
      service: { extensions: ["health_check"] },
    };
    expect(collectorEndpoints(local).healthCheck).toBeUndefined();

    const disabled: CollectorConfig = { extensions: { health_check: { endpoint: "0.0.0.0:13133" } } };
    expect(collectorEndpoints(disabled).healthCheck).toBeUndefined();
  });

  test("a health_check path is carried through", () => {
    const config: CollectorConfig = {
      extensions: { "health_check/ready": { endpoint: "0.0.0.0:8080", path: "/ready" } },
      service: { extensions: ["health_check/ready"] },
    };
    expect(collectorEndpoints(config).healthCheck).toEqual({ port: 8080, path: "/ready" });
  });
});

test("the image is the contrib collector at a pinned version, and the config lives under /etc/otel", () => {
  expect(COLLECTOR_IMAGE).toMatch(/^otel\/opentelemetry-collector-contrib:\d+\.\d+\.\d+$/);
  expect(COLLECTOR_CONFIG_PATH).toBe("/etc/otel/config.yaml");
});
