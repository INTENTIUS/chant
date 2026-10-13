import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { otelSerializer } from "../serializer";
import { collectorYaml } from "../collector";
import { validateCollectorEntities } from "../validate-config";
import { COLLECTOR_PIN } from "../define";
import { DebugExporter } from "./exporters";
import { OtlpReceiver } from "./receivers";
import { FilterProcessor, RedactionProcessor, TransformProcessor } from "./filtering";
import { Pipeline } from "../pipeline";

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

function primary(out: ReturnType<typeof otelSerializer.serialize>): string {
  return typeof out === "string" ? out : out.primary;
}

function problems(component: Declarable): string[] {
  return validateCollectorEntities([component])
    .filter((i) => i.code === "OTEL107")
    .map((i) => i.message.replace(/^\w+ "[^"]+": /, ""));
}

describe("filter, transform and redaction are built-ins pinned to the collector release", () => {
  test.each([
    [FilterProcessor, "filter"],
    [TransformProcessor, "transform"],
    [RedactionProcessor, "redaction"],
  ] as const)("%o", (Cls, type) => {
    expect(Cls.definition.kind).toBe("processor");
    expect(Cls.definition.type).toBe(type);
    expect(Cls.definition.builtin).toBe(true);
    expect(Cls.definition.pin).toBe(COLLECTOR_PIN);
  });
});

describe("filter processor", () => {
  test("serializes OTTL conditions per signal and context as strings", () => {
    const filter = new FilterProcessor({
      error_mode: "ignore",
      traces: { span: ['attributes["http.route"] == "/healthz"'], spanevent: ['name == "debug"'] },
      metrics: { datapoint: ['metric.name == "rpc.duration" and value_double < 0'] },
      logs: { log_record: ["severity_number < SEVERITY_NUMBER_WARN"] },
    });
    expect(primary(otelSerializer.serialize(entities({ filter })))).toBe(`processors:
  filter:
    error_mode: ignore
    traces:
      span: ["attributes[\\"http.route\\"] == \\"/healthz\\""]
      spanevent: [name == "debug"]
    metrics:
      datapoint: [metric.name == "rpc.duration" and value_double < 0]
    logs:
      log_record: [severity_number < SEVERITY_NUMBER_WARN]
`);
    const parsed = load(primary(otelSerializer.serialize(entities({ filter })))) as any;
    expect(parsed.processors.filter.traces.spanevent).toEqual(['name == "debug"']);
    expect(parsed.processors.filter.metrics.datapoint).toEqual(['metric.name == "rpc.duration" and value_double < 0']);
  });

  test("a named instance renders under filter/name in a pipeline, conditions intact", () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: {} } });
    const drop = new FilterProcessor({ name: "health", traces: { span: ['attributes["http.route"] == "/healthz"'] } });
    const debug = new DebugExporter({});
    const parsed = load(
      collectorYaml([otlp, drop, debug, new Pipeline({ signal: "traces", receivers: [otlp], processors: [drop], exporters: [debug] })]),
    ) as any;
    expect(parsed.processors["filter/health"]).toEqual({ traces: { span: ['attributes["http.route"] == "/healthz"'] } });
    expect(parsed.service.pipelines.traces.processors).toEqual(["filter/health"]);
  });

  test("a filter with no condition drops nothing, and says so", () => {
    expect(problems(new FilterProcessor({}))).toEqual([
      "no condition is set for any signal, so the processor drops nothing",
    ]);
    expect(problems(new FilterProcessor({ logs: { log_record: [" "] } }))).toContain(
      "logs.log_record[0] is an empty condition",
    );
    expect(problems(new FilterProcessor({ logs: { log_record: ["true"] } }))).toEqual([]);
  });

  test("the legacy include/exclude match blocks serialize as written and count as conditions", () => {
    const filter = new FilterProcessor({
      metrics: { exclude: { match_type: "strict", metric_names: ["up", "scrape_duration_seconds"] } },
      logs: { include: { match_type: "regexp", severity_number: { min: "WARN", match_undefined: true }, bodies: ["^panic"] } },
      spans: { exclude: { match_type: "strict", services: ["healthcheck"], span_kinds: ["SPAN_KIND_INTERNAL"] } },
    });
    expect(problems(filter)).toEqual([]);
    const parsed = load(primary(otelSerializer.serialize(entities({ filter })))) as any;
    expect(parsed.processors.filter.metrics.exclude.metric_names).toEqual(["up", "scrape_duration_seconds"]);
    expect(parsed.processors.filter.logs.include.severity_number).toEqual({ min: "WARN", match_undefined: true });
    expect(parsed.processors.filter.spans.exclude.span_kinds).toEqual(["SPAN_KIND_INTERNAL"]);
  });

  test("a signal that mixes OTTL conditions with include/exclude is reported, as the collector rejects it", () => {
    const mixed = new FilterProcessor({
      traces: { span: ["true"] },
      spans: { include: { match_type: "strict", services: ["a"] } },
      metrics: { metric: ["true"], exclude: { match_type: "expr", expressions: ["MetricName == 'up'"] } },
      logs: { log_record: ["true"], exclude: { match_type: "strict", bodies: ["x"] } },
    });
    expect(problems(mixed)).toEqual([
      "traces mixes OTTL conditions with include/exclude, which the collector rejects",
      "metrics mixes OTTL conditions with include/exclude, which the collector rejects",
      "logs mixes OTTL conditions with include/exclude, which the collector rejects",
    ]);
  });
});

describe("transform processor", () => {
  test("serializes statement groups per context, and bare statements", () => {
    const transform = new TransformProcessor({
      error_mode: "ignore",
      trace_statements: [
        {
          context: "span",
          conditions: ["kind == SPAN_KIND_SERVER"],
          statements: ['set(attributes["tier"], "edge")'],
          error_mode: "propagate",
        },
        'delete_key(span.attributes, "http.request.header.cookie")',
      ],
      metric_statements: [{ context: "datapoint", statements: ['delete_key(attributes, "pod_ip")'] }],
      log_statements: [{ statements: ['set(log.severity_text, "WARN") where log.severity_number == 13'] }],
    });
    const parsed = load(primary(otelSerializer.serialize(entities({ transform })))) as any;
    expect(parsed.processors.transform).toEqual({
      error_mode: "ignore",
      trace_statements: [
        {
          context: "span",
          conditions: ["kind == SPAN_KIND_SERVER"],
          statements: ['set(attributes["tier"], "edge")'],
          error_mode: "propagate",
        },
        'delete_key(span.attributes, "http.request.header.cookie")',
      ],
      metric_statements: [{ context: "datapoint", statements: ['delete_key(attributes, "pod_ip")'] }],
      log_statements: [{ statements: ['set(log.severity_text, "WARN") where log.severity_number == 13'] }],
    });
  });

  test("the rendered text keeps each statement as one quoted string", () => {
    const transform = new TransformProcessor({
      log_statements: [{ context: "log", statements: ['set(attributes["a"], "b")'] }],
    });
    expect(collectorYaml([transform])).toBe(`processors:
  transform:
    log_statements:
      - context: log
        statements: ["set(attributes[\\"a\\"], \\"b\\")"]
`);
  });

  test("a context from another signal, an empty group and no statements are reported", () => {
    const wrong = new TransformProcessor({
      // @ts-expect-error: "log" is not a trace context; the check catches it for untyped callers too
      trace_statements: [{ context: "log", statements: ["set(attributes[\"a\"], 1)"] }, { context: "span", statements: [] }],
    });
    expect(problems(wrong)).toEqual([
      'trace_statements[0] has context "log"; trace_statements runs in resource, scope, span, spanevent',
      "trace_statements[1] has no statements",
    ]);
    expect(problems(new TransformProcessor({}))).toEqual([
      "no statement is set for any signal, so the processor changes nothing",
    ]);
  });
});

describe("redaction processor", () => {
  test("serializes allow and block lists and the hash function", () => {
    const redaction = new RedactionProcessor({
      allow_all_keys: false,
      allowed_keys: ["http.method", "http.route"],
      ignored_keys: ["service.name"],
      blocked_key_patterns: [".*token.*"],
      blocked_values: ["4[0-9]{12}(?:[0-9]{3})?"],
      allowed_values: [".+@example\\.com"],
      hash_function: "sha3",
      summary: "debug",
    });
    expect(collectorYaml([redaction])).toBe(`processors:
  redaction:
    allow_all_keys: false
    allowed_keys: [http.method, http.route]
    ignored_keys: [service.name]
    blocked_key_patterns: [.*token.*]
    blocked_values: ["4[0-9]{12}(?:[0-9]{3})?"]
    allowed_values: [.+@example\\.com]
    hash_function: sha3
    summary: debug
`);
    const parsed = load(collectorYaml([redaction])) as any;
    expect(parsed.processors.redaction.blocked_values).toEqual(["4[0-9]{12}(?:[0-9]{3})?"]);
    expect(parsed.processors.redaction.allowed_values).toEqual([".+@example\\.com"]);
    expect(problems(redaction)).toEqual([]);
  });

  test("with neither allow_all_keys nor allowed_keys every attribute would be deleted", () => {
    expect(problems(new RedactionProcessor({ blocked_values: ["secret"] }))).toEqual([
      "neither allow_all_keys nor allowed_keys is set, so every attribute is deleted; set allow_all_keys: true to keep keys, or allowed_keys: [] if deleting all is intended",
    ]);
    expect(problems(new RedactionProcessor({ allowed_keys: [] }))).toEqual([]);
    expect(problems(new RedactionProcessor({ allow_all_keys: true, blocked_values: ["secret"] }))).toEqual([]);
  });

  test("contradictions and no-ops are reported", () => {
    expect(problems(new RedactionProcessor({ allow_all_keys: true, allowed_keys: ["a"], hash_function: "md5" }))).toEqual([
      "allowed_keys has no effect while allow_all_keys is true",
      "hash_function is set but nothing is blocked, so nothing is hashed",
    ]);
    expect(problems(new RedactionProcessor({ allow_all_keys: true, blocked_values: [""] }))).toEqual([
      "blocked_values[0] is an empty pattern",
    ]);
  });
});
