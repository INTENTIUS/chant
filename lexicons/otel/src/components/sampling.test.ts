import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import { otelSerializer } from "../serializer";
import { collectorTopology } from "../topology";
import { validateCollectorEntities } from "../validate-config";
import { otel107 } from "../lint/post-synth/otel107";
import {
  BatchProcessor,
  DebugExporter,
  LoadBalancingExporter,
  MemoryLimiterProcessor,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
  ProbabilisticSamplerProcessor,
  TailSamplingProcessor,
  loadBalancingEndpoints,
  type TailSamplingPolicy,
} from "../index";

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

function yamlOf(record: Record<string, unknown>): string {
  const out = otelSerializer.serialize(entities(record));
  return typeof out === "string" ? out : out.primary;
}

function problems(e: Declarable): string[] {
  return otel107.check(makePostSynthCtx("otel", "", new Map([["x", e]]))).map((d) => d.message);
}

const POLICIES: TailSamplingPolicy[] = [
  {
    name: "errors",
    type: "status_code",
    status_code: { status_codes: ["ERROR"] },
  },
  { name: "slow", type: "latency", latency: { threshold_ms: 2000 } },
  {
    name: "agent-failed",
    type: "string_attribute",
    string_attribute: { key: "gen_ai.outcome", values: ["failed"] },
  },
  {
    name: "big-response",
    type: "numeric_attribute",
    numeric_attribute: { key: "gen_ai.usage.output_tokens", min_value: 4000 },
  },
  {
    name: "rate",
    type: "rate_limiting",
    rate_limiting: { spans_per_second: 500 },
  },
  {
    name: "checkout-sampled",
    type: "and",
    and: {
      and_sub_policy: [
        {
          name: "checkout",
          type: "string_attribute",
          string_attribute: { key: "service.name", values: ["checkout"] },
        },
        {
          name: "tenth",
          type: "probabilistic",
          probabilistic: { sampling_percentage: 10 },
        },
      ],
    },
  },
  {
    name: "budget",
    type: "composite",
    composite: {
      max_total_spans_per_second: 1000,
      policy_order: ["c-errors", "c-rest"],
      composite_sub_policy: [
        {
          name: "c-errors",
          type: "status_code",
          status_code: { status_codes: ["ERROR"] },
        },
        { name: "c-rest", type: "always_sample" },
      ],
      rate_allocation: [
        { policy: "c-errors", percent: 60 },
        { policy: "c-rest", percent: 40 },
      ],
    },
  },
  {
    name: "rest",
    type: "probabilistic",
    probabilistic: { sampling_percentage: 5 },
  },
];

/** The gateway side: receive OTLP, head-sample, tail-sample whole traces, export. */
function gateway(): Record<string, unknown> {
  const otlp = new OtlpReceiver({
    protocols: { grpc: { endpoint: "0.0.0.0:4317" } },
  });
  const limiter = new MemoryLimiterProcessor({
    check_interval: "1s",
    limit_percentage: 80,
    spike_limit_percentage: 20,
  });
  const head = new ProbabilisticSamplerProcessor({
    sampling_percentage: 50,
    mode: "proportional",
  });
  const tail = new TailSamplingProcessor({
    decision_wait: "10s",
    num_traces: 50000,
    policies: POLICIES,
  });
  const batch = new BatchProcessor({});
  const tempo = new OtlpExporter({
    name: "tempo",
    endpoint: "tempo:4317",
    tls: { insecure: true },
  });
  const traces = new Pipeline({
    signal: "traces",
    receivers: [otlp],
    processors: [limiter, head, tail, batch],
    exporters: [tempo],
  });
  return { otlp, limiter, head, tail, batch, tempo, traces };
}

/** The agent side: route every span of a trace to one gateway replica. */
function agent(): Record<string, unknown> {
  const otlp = new OtlpReceiver({
    protocols: { grpc: { endpoint: "0.0.0.0:4317" } },
  });
  const k8s = new LoadBalancingExporter({
    name: "gateway",
    routing_key: "traceID",
    protocol: { otlp: { tls: { insecure: true }, timeout: "5s" } },
    resolver: {
      k8s: { service: "otel-gateway-headless.observability", ports: [4317] },
    },
  });
  const fixed = new LoadBalancingExporter({
    name: "fixed",
    resolver: { static: { hostnames: ["gw-0.gw:4317", "gw-1.gw:4317"] } },
  });
  const debug = new DebugExporter({});
  const traces = new Pipeline({
    signal: "traces",
    receivers: [otlp],
    exporters: [k8s],
  });
  const logs = new Pipeline({
    signal: "logs",
    receivers: [otlp],
    exporters: [fixed, debug],
  });
  return { otlp, k8s, fixed, debug, traces, logs };
}

describe("tail_sampling", () => {
  test("serializes policies under the key their type names", () => {
    const parsed = load(yamlOf(gateway())) as any;
    const ts = parsed.processors.tail_sampling;
    expect(ts.decision_wait).toBe("10s");
    expect(ts.num_traces).toBe(50000);
    expect(ts.policies.map((p: any) => p.type)).toEqual([
      "status_code",
      "latency",
      "string_attribute",
      "numeric_attribute",
      "rate_limiting",
      "and",
      "composite",
      "probabilistic",
    ]);
    expect(ts.policies[0]).toEqual({
      name: "errors",
      type: "status_code",
      status_code: { status_codes: ["ERROR"] },
    });
    expect(ts.policies[5].and.and_sub_policy[1]).toEqual({
      name: "tenth",
      type: "probabilistic",
      probabilistic: { sampling_percentage: 10 },
    });
    expect(ts.policies[6].composite.rate_allocation).toEqual([
      { policy: "c-errors", percent: 60 },
      { policy: "c-rest", percent: 40 },
    ]);
    expect(parsed.service.pipelines.traces.processors).toEqual([
      "memory_limiter",
      "probabilistic_sampler",
      "tail_sampling",
      "batch",
    ]);
  });

  test("renders the policy list in block style", () => {
    const yaml = yamlOf({
      tail: new TailSamplingProcessor({
        decision_wait: "5s",
        policies: POLICIES.slice(0, 1),
      }),
    });
    expect(yaml).toBe(`processors:
  tail_sampling:
    decision_wait: 5s
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]
`);
  });

  test("a valid gateway config has nothing to report", () => {
    expect(validateCollectorEntities(entities(gateway()))).toEqual([]);
  });

  test("no decision_wait fails the per-component check", () => {
    const tail = new TailSamplingProcessor({ policies: POLICIES } as never);
    expect(problems(tail)).toEqual([expect.stringContaining("decision_wait is not set")]);
  });

  test("an empty policy list fails the per-component check", () => {
    expect(problems(new TailSamplingProcessor({ decision_wait: "10s", policies: [] }))).toEqual([
      expect.stringContaining("policies is empty"),
    ]);
    expect(problems(new TailSamplingProcessor({ decision_wait: "10s" } as never))).toEqual([
      expect.stringContaining("policies is empty"),
    ]);
  });

  test("policy-level problems", () => {
    const bad = new TailSamplingProcessor({
      decision_wait: "10s",
      policies: [
        {
          name: "a",
          type: "status_code",
          status_code: { status_codes: ["FAILED" as never] },
        },
        { name: "a", type: "latency", latency: { threshold_ms: 0 } },
        {
          name: "",
          type: "probabilistic",
          probabilistic: { sampling_percentage: 150 },
        },
        { name: "b", type: "string_attribute" } as never,
        { name: "c", type: "and", and: { and_sub_policy: [] } },
        {
          name: "d",
          type: "composite",
          composite: {
            max_total_spans_per_second: 100,
            policy_order: ["x"],
            composite_sub_policy: [{ name: "y", type: "always_sample" }],
            rate_allocation: [{ policy: "z", percent: 120 }],
          },
        },
      ],
    });
    const msgs = problems(bad);
    expect(msgs).toEqual([
      expect.stringContaining('status code "FAILED" is not OK, ERROR or UNSET'),
      expect.stringContaining('policy name "a" is repeated'),
      expect.stringContaining("latency needs threshold_ms or upper_threshold_ms above 0"),
      expect.stringContaining("policies[2] has no name"),
      expect.stringContaining("sampling_percentage must be above 0 and at most 100"),
      expect.stringContaining("type string_attribute needs a string_attribute block"),
      expect.stringContaining("and.and_sub_policy is empty"),
      expect.stringContaining('policy_order names "x"'),
      expect.stringContaining('rate_allocation names "z"'),
      expect.stringContaining("add up to 120"),
    ]);
  });
});

describe("probabilistic_sampler", () => {
  test("serializes as given", () => {
    const parsed = load(
      yamlOf({
        p: new ProbabilisticSamplerProcessor({
          sampling_percentage: 15.3,
          mode: "hash_seed",
          hash_seed: 22,
        }),
      }),
    ) as any;
    expect(parsed.processors.probabilistic_sampler).toEqual({
      sampling_percentage: 15.3,
      mode: "hash_seed",
      hash_seed: 22,
    });
  });

  test("checks", () => {
    expect(problems(new ProbabilisticSamplerProcessor({ sampling_percentage: 25 }))).toEqual([]);
    expect(problems(new ProbabilisticSamplerProcessor({} as never))).toEqual([expect.stringContaining("keeps nothing")]);
    expect(
      problems(
        new ProbabilisticSamplerProcessor({
          sampling_percentage: 101,
          sampling_precision: 15,
          attribute_source: "record",
          mode: "proportional",
          hash_seed: 1,
        }),
      ),
    ).toEqual([
      expect.stringContaining("between 0 and 100"),
      expect.stringContaining("sampling_precision (15)"),
      expect.stringContaining("from_attribute is not set"),
      expect.stringContaining("only read in hash_seed mode"),
    ]);
  });
});

describe("loadbalancing", () => {
  test("serializes the resolver, routing key and nested otlp protocol", () => {
    const parsed = load(yamlOf(agent())) as any;
    expect(parsed.exporters["loadbalancing/gateway"]).toEqual({
      routing_key: "traceID",
      protocol: { otlp: { tls: { insecure: true }, timeout: "5s" } },
      resolver: {
        k8s: { service: "otel-gateway-headless.observability", ports: [4317] },
      },
    });
    expect(parsed.exporters["loadbalancing/fixed"]).toEqual({
      resolver: { static: { hostnames: ["gw-0.gw:4317", "gw-1.gw:4317"] } },
    });
    expect(validateCollectorEntities(entities(agent()))).toEqual([]);
  });

  test("topology reports the resolver's backends", () => {
    const topo = collectorTopology(load(yamlOf(agent())) as never);
    const byId = Object.fromEntries(topo.exporters.map((e) => [e.id, e]));
    expect(byId["loadbalancing/gateway"].endpoints).toEqual(["otel-gateway-headless.observability:4317"]);
    expect(byId["loadbalancing/gateway"].signals).toEqual(["traces"]);
    expect(byId["loadbalancing/fixed"].endpoints).toEqual(["gw-0.gw:4317", "gw-1.gw:4317"]);
  });

  test("loadBalancingEndpoints covers every resolver", () => {
    expect(loadBalancingEndpoints({ k8s: { service: "gw.obs" } })).toEqual(["gw.obs:4317"]);
    expect(loadBalancingEndpoints({ k8s: { service: "gw", ports: [4317, 55690] } })).toEqual(["gw:4317", "gw:55690"]);
    expect(loadBalancingEndpoints({ dns: { hostname: "gw-headless" } })).toEqual(["gw-headless:4317"]);
    expect(
      loadBalancingEndpoints({
        aws_cloud_map: { namespace: "ns", service_name: "gw" },
      }),
    ).toEqual(["aws-cloud-map://ns/gw"]);
    expect(loadBalancingEndpoints(undefined)).toEqual([]);
  });

  test("checks", () => {
    expect(problems(new LoadBalancingExporter({ resolver: {} as never }))).toEqual([
      expect.stringContaining("resolver has none of"),
    ]);
    expect(
      problems(
        new LoadBalancingExporter({
          resolver: {
            static: { hostnames: [] },
            k8s: { service: "" },
          } as never,
          routing_key: "attributes",
          protocol: { otlp: { endpoint: "x:4317" } as never },
        }),
      ),
    ).toEqual([
      expect.stringContaining("sets static and k8s"),
      expect.stringContaining("hostnames is empty"),
      expect.stringContaining("k8s.service is empty"),
      expect.stringContaining("routing_attributes is empty"),
      expect.stringContaining("protocol.otlp.endpoint is ignored"),
    ]);
  });
});

// ── otelcol validate ─────────────────────────────────────────────────
//
// The acceptance test is the collector itself: write the rendered config and
// run `otelcol-contrib validate --config` on it. The binary must be a contrib
// build (the core `otelcol` distribution ships none of these components), so
// the test looks for OTELCOL_BIN, then otelcol-contrib, then an otelcol that
// lists tail_sampling among its components, and skips with the reason when
// none is on PATH. CI does not install one.

function findCollector(): string | undefined {
  const candidates = [process.env.OTELCOL_BIN, "otelcol-contrib", "otelcol"].filter((c): c is string => !!c);
  for (const bin of candidates) {
    try {
      const components = execFileSync(bin, ["components"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (components.includes("tail_sampling") && components.includes("loadbalancing")) return bin;
    } catch {
      // not installed, or not a contrib build
    }
  }
  return undefined;
}

const collector = findCollector();

describe.skipIf(!collector)(
  `otelcol validate accepts the rendered config${collector ? "" : " (skipped: no otelcol-contrib on PATH)"}`,
  () => {
    let dir = "";
    let kubeconfig = "";

    // `validate` builds every component, and the k8s resolver builds a
    // Kubernetes client while it does, so it needs some kubeconfig. A stub one
    // is enough: nothing connects until the collector starts.
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "chant-otel-sampling-"));
      kubeconfig = join(dir, "kubeconfig");
      writeFileSync(
        kubeconfig,
        [
          "apiVersion: v1",
          "kind: Config",
          "clusters: [{ name: stub, cluster: { server: 'https://127.0.0.1:1' } }]",
          "users: [{ name: stub, user: { token: stub } }]",
          "contexts: [{ name: stub, context: { cluster: stub, user: stub } }]",
          "current-context: stub",
          "",
        ].join("\n"),
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    function validate(name: string, yaml: string): void {
      const file = join(dir, `${name}.yaml`);
      writeFileSync(file, yaml);
      execFileSync(collector!, ["validate", `--config=${file}`], {
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, KUBECONFIG: kubeconfig },
      });
    }

    test("gateway: probabilistic_sampler and tail_sampling with every policy kind", () => {
      expect(() => validate("gateway", yamlOf(gateway()))).not.toThrow();
    });

    test("agent: loadbalancing with the k8s and static resolvers", () => {
      expect(() => validate("agent", yamlOf(agent()))).not.toThrow();
    });
  },
);
