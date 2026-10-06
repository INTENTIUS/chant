/**
 * `TailSamplingTier`: the sampling collector's config, its default
 * policies, the switches, and the load-balancing exporter for the agents in
 * front of it.
 */
import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { TailSamplingTier, tailSamplingLoadBalancer, tailSamplingTierPropsProblem, type TailSamplingTierProps } from "./index";
import { OtlpExporter } from "../components/exporters";
import { collectorYaml } from "../collector";
import { validateCollectorConfig } from "../validate-config";
import type { CollectorConfig } from "../model";

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function configOf(props: TailSamplingTierProps = {}): CollectorConfig {
  return load(collectorYaml(Object.values(TailSamplingTier(props).members) as Declarable[])) as CollectorConfig;
}

const tempo = new OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });

describe("TailSamplingTier defaults", () => {
  const config = configOf();

  test("the config passes every config check", () => {
    expect(validateCollectorConfig(config)).toEqual([]);
  });

  test("otlp in, memory_limiter, tail_sampling, batch, debug out", () => {
    expect(config.service?.pipelines).toEqual({
      traces: { receivers: ["otlp"], processors: ["memory_limiter", "tail_sampling", "batch"], exporters: ["debug"] },
    });
    expect(config.service?.extensions).toEqual(["health_check"]);
  });

  test("keeps errors, traces of a second or more, and 10% of the rest, after 10s", () => {
    const ts = config.processors?.tail_sampling as Loose;
    expect(ts.decision_wait).toBe("10s");
    expect(ts.policies).toEqual([
      { name: "errors", type: "status_code", status_code: { status_codes: ["ERROR"] } },
      { name: "slow", type: "latency", latency: { threshold_ms: 1000 } },
      { name: "baseline", type: "probabilistic", probabilistic: { sampling_percentage: 10 } },
    ]);
    expect(ts.num_traces).toBeUndefined();
  });
});

describe("TailSamplingTier options", () => {
  test("exporters, thresholds and extra policies", () => {
    const config = configOf({
      exporters: [tempo],
      slowerThanMs: 500,
      percentage: 5,
      decisionWait: "5s",
      numTraces: 100000,
      policies: [{ name: "checkout", type: "string_attribute", string_attribute: { key: "service.name", values: ["checkout"] } }],
    });
    expect(validateCollectorConfig(config)).toEqual([]);
    const ts = config.processors?.tail_sampling as Loose;
    expect(ts.decision_wait).toBe("5s");
    expect(ts.num_traces).toBe(100000);
    expect(ts.policies.map((p: Loose) => p.name)).toEqual(["errors", "slow", "baseline", "checkout"]);
    expect(ts.policies[1].latency).toEqual({ threshold_ms: 500 });
    expect(config.service?.pipelines?.traces.exporters).toEqual(["otlp/tempo"]);
    expect(config.exporters?.debug).toBeUndefined();
  });

  test("each default policy can be turned off", () => {
    const ts = configOf({ errors: false, percentage: false }).processors?.tail_sampling as Loose;
    expect(ts.policies.map((p: Loose) => p.name)).toEqual(["slow"]);
  });

  test("members leave out what is off", () => {
    const tier = TailSamplingTier({ exporters: [tempo], healthCheck: false });
    expect(Object.keys(tier.members).sort()).toEqual(["batch", "memoryLimiter", "otlp", "tailSampling", "traces"]);
  });

  test("bad props are refused", () => {
    expect(tailSamplingTierPropsProblem({})).toBeUndefined();
    expect(() => TailSamplingTier({ errors: false, slowerThanMs: false, percentage: false })).toThrow(/TailSamplingTier: every policy is off/);
    expect(() => TailSamplingTier({ percentage: 0 })).toThrow(/percentage/);
    expect(() => TailSamplingTier({ percentage: 101 })).toThrow(/percentage/);
    expect(() => TailSamplingTier({ slowerThanMs: 1.5 })).toThrow(/slowerThanMs/);
    expect(() => TailSamplingTier({ decisionWait: "soon" })).toThrow(/decisionWait/);
    expect(() => TailSamplingTier({ exporters: [] })).toThrow(/exporters/);
  });
});

describe("tailSamplingLoadBalancer", () => {
  test("routes by trace id to the resolver's backends", () => {
    const lb = tailSamplingLoadBalancer({ dns: { hostname: "sampler.internal" } }, "sampler");
    expect(lb.componentId).toBe("loadbalancing/sampler");
    expect(lb.props).toMatchObject({ routing_key: "traceID", resolver: { dns: { hostname: "sampler.internal" } } });
    expect((lb.props as Loose).protocol).toBeUndefined();
    const insecure = tailSamplingLoadBalancer({ static: { hostnames: ["a:4317", "b:4317"] } }, undefined, { otlp: { tls: { insecure: true } } });
    expect(insecure.componentId).toBe("loadbalancing");
    expect((insecure.props as Loose).protocol).toEqual({ otlp: { tls: { insecure: true } } });
  });
});
