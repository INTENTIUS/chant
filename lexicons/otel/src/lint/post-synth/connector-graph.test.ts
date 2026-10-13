/**
 * OTEL113-OTEL115 against the fixtures in testdata/: each failing fixture
 * trips its own rule and nothing else, each passing fixture trips nothing.
 *
 * Where `otelcol-contrib` is on PATH (or `OTELCOL_BIN` names a contrib build),
 * `otelcol validate` confirms the collector refuses each failing fixture and
 * accepts each passing one. Without it those tests skip; CI does not install it.
 */

import { describe, expect, test } from "vitest";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { validateCollectorConfig } from "../../validate-config";
import type { CollectorConfig } from "../../model";
import { otel113 } from "./otel113";
import { otel114 } from "./otel114";
import { otel115 } from "./otel115";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "testdata", name), "utf-8");

const RULES: Array<[string, PostSynthCheck]> = [
  ["OTEL113", otel113],
  ["OTEL114", otel114],
  ["OTEL115", otel115],
];

function findOtelcol(): string | undefined {
  const candidates = [process.env.OTELCOL_BIN, "otelcol-contrib"].filter((c): c is string => !!c);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return bin;
  }
  return undefined;
}

const OTELCOL = findOtelcol();

function otelcolValidate(file: string): { ok: boolean; output: string } {
  const r = spawnSync(OTELCOL!, ["validate", `--config=${join(import.meta.dirname, "testdata", file)}`], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.each(RULES)("%s fixtures", (id, check) => {
  const lower = id.toLowerCase();

  test("the failing fixture trips this rule and no other", () => {
    const yaml = fixture(`${lower}-fail.yaml`);
    const diags = check.check(makePostSynthCtx("otel", yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ checkId: id, severity: "error", lexicon: "otel" });
    expect(validateCollectorConfig(load(yaml) as CollectorConfig).map((i) => i.code)).toEqual([id]);
  });

  test("the passing fixture trips nothing", () => {
    const yaml = fixture(`${lower}-pass.yaml`);
    expect(check.check(makePostSynthCtx("otel", yaml))).toEqual([]);
    expect(validateCollectorConfig(load(yaml) as CollectorConfig)).toEqual([]);
  });

  test.skipIf(!OTELCOL)("otelcol validate refuses the failing fixture", () => {
    const { ok, output } = otelcolValidate(`${lower}-fail.yaml`);
    expect(ok, output).toBe(false);
  });

  test.skipIf(!OTELCOL)("otelcol validate accepts the passing fixture", () => {
    const { ok, output } = otelcolValidate(`${lower}-pass.yaml`);
    expect(ok, output).toBe(true);
  });
});

describe("OTEL113 connector cycles", () => {
  const config = (pipelines: string): CollectorConfig =>
    load(`receivers: {otlp: {protocols: {grpc: {}}}}
exporters: {debug: {}}
connectors: {forward: {}, forward/2: {}, spanmetrics: {}}
service:
  pipelines:
${pipelines}`) as CollectorConfig;
  const cycles = (c: CollectorConfig) => validateCollectorConfig(c).filter((i) => i.code === "OTEL113");

  test("names the cycle hop by hop", () => {
    const [issue] = cycles(load(fixture("otel113-fail.yaml")) as CollectorConfig);
    expect(issue.pipeline).toBe("traces/a");
    expect(issue.message).toContain("traces/a -> forward/ab -> traces/b -> forward/ba -> traces/a");
  });

  test("flags a pipeline that feeds itself through one connector", () => {
    const issues = cycles(
      config(`    traces:
      receivers: [otlp, forward]
      exporters: [forward, debug]`),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("traces -> forward -> traces");
  });

  test("reports one cycle per group of pipelines, however many paths it holds", () => {
    const issues = cycles(
      config(`    traces/a:
      receivers: [otlp, forward/2]
      exporters: [forward]
    traces/b:
      receivers: [forward]
      exporters: [forward/2]
    traces/c:
      receivers: [forward]
      exporters: [forward/2]`),
    );
    expect(issues.map((i) => i.pipeline)).toEqual(["traces/a"]);
  });

  test("a fan-out with no way back is not a cycle", () => {
    expect(
      cycles(
        config(`    traces:
      receivers: [otlp]
      exporters: [forward, spanmetrics]
    traces/2:
      receivers: [forward]
      exporters: [debug]
    metrics:
      receivers: [spanmetrics]
      exporters: [debug]`),
      ),
    ).toEqual([]);
  });

  test("an edge the connector cannot make does not close a cycle", () => {
    // spanmetrics only goes traces to metrics, so metrics -> spanmetrics -> traces is no edge (OTEL112 reports it).
    expect(
      cycles(
        config(`    traces:
      receivers: [otlp, spanmetrics]
      exporters: [spanmetrics]
    metrics:
      receivers: [spanmetrics]
      exporters: [debug]`),
      ),
    ).toEqual([]);
  });
});

describe("OTEL114 connector id collisions", () => {
  test("flags a connector that shares its id with an exporter", () => {
    const issues = validateCollectorConfig({
      receivers: { otlp: {} },
      exporters: { "forward/x": {}, debug: {} },
      connectors: { "forward/x": {} },
      service: { pipelines: { traces: { receivers: ["otlp"], exporters: ["debug"] } } },
    }).filter((i) => i.code === "OTEL114");
    expect(issues).toHaveLength(1);
    expect(issues[0].component).toBe("forward/x");
    expect(issues[0].message).toContain("declared exporter");
  });

  test("names the receiver in the message", () => {
    const [issue] = validateCollectorConfig(load(fixture("otel114-fail.yaml")) as CollectorConfig);
    expect(issue.message).toContain('connector "datadog" has the same id as a declared receiver');
  });
});

describe("OTEL115 routing targets", () => {
  const routes = (c: CollectorConfig) => validateCollectorConfig(c).filter((i) => i.code === "OTEL115");

  test("names where the target came from", () => {
    const [issue] = routes(load(fixture("otel115-fail.yaml")) as CollectorConfig);
    expect(issue).toMatchObject({ pipeline: "traces/other", component: "routing" });
    expect(issue.message).toContain("(default_pipelines)");
    expect(issue.message).toContain("does not list");
  });

  test("flags a target pipeline that does not exist, once however often it is named", () => {
    const config = load(fixture("otel115-pass.yaml")) as any;
    config.connectors.routing.table.push(
      { statement: 'route() where attributes["tenant"] == "b"', pipelines: ["traces/missing"] },
      { statement: 'route() where attributes["tenant"] == "c"', pipelines: ["traces/missing"] },
    );
    const issues = routes(config);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"traces/missing" (table[1].pipelines), which is not declared');
  });

  test("checks named routing connectors and leaves other connectors alone", () => {
    const issues = routes({
      receivers: { otlp: {} },
      exporters: { debug: {} },
      connectors: {
        "routing/tenants": { table: [{ pipelines: ["traces/nowhere"] }] },
        "forward": { table: [{ pipelines: ["traces/nowhere"] }] },
      },
      service: {
        pipelines: {
          traces: { receivers: ["otlp"], exporters: ["routing/tenants", "forward"] },
          "traces/out": { receivers: ["routing/tenants", "forward"], exporters: ["debug"] },
        },
      },
    });
    expect(issues.map((i) => i.component)).toEqual(["routing/tenants"]);
  });
});
