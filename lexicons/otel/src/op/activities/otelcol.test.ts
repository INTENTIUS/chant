import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECTOR_PIN } from "../../define";
import type { ExecRunner } from "./exec";
import {
  configComponents,
  missingComponents,
  otelcolBin,
  otelcolComponents,
  otelcolValidate,
  parseComponentsOutput,
  parseOtelcolVersion,
} from "./otelcol";

const FIXTURE = readFileSync(join(import.meta.dirname, "..", "testdata", "otelcol-components-v0.130.0.yaml"), "utf8");

const CONFIG = `receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
processors:
  batch: {}
exporters:
  debug: {}
  otlp/tempo:
    endpoint: tempo:4317
connectors:
  spanmetrics: {}
extensions:
  health_check: {}
service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [debug, otlp/tempo, spanmetrics]
    metrics:
      receivers: [spanmetrics]
      exporters: [debug]
`;

function configFile(text = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-otelcol-op-"));
  const file = join(dir, "collector.yaml");
  writeFileSync(file, text);
  return file;
}

/** A runner that answers `--version` with `version`, and records the calls. */
function fakeExec(version: string, rest: Partial<Record<string, { code: number; stdout?: string; stderr?: string }>> = {}) {
  const calls: string[][] = [];
  const exec: ExecRunner = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "--version") return { code: 0, stdout: `otelcol-contrib version ${version}\n`, stderr: "" };
    const r = rest[args[0]] ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

const PIN = COLLECTOR_PIN.version.replace(/^v/, "");

describe("otelcolValidate", () => {
  test("parses the version line the binary prints", () => {
    expect(parseOtelcolVersion("otelcol-contrib version 0.130.0")).toBe("v0.130.0");
    expect(parseOtelcolVersion("otelcol version v0.131.1-dev\n")).toBe("v0.131.1-dev");
    expect(parseOtelcolVersion("no version here")).toBeUndefined();
  });

  test("the binary is bin, then $OTELCOL_BIN, then otelcol-contrib", () => {
    expect(otelcolBin("/opt/otelcol", { OTELCOL_BIN: "x" })).toBe("/opt/otelcol");
    expect(otelcolBin(undefined, { OTELCOL_BIN: "x" })).toBe("x");
    expect(otelcolBin(undefined, {})).toBe("otelcol-contrib");
  });

  test("at the pinned version, runs validate over the config and passes", async () => {
    const file = configFile();
    const { exec, calls } = fakeExec(PIN, { validate: { code: 0, stdout: "" } });
    const r = await otelcolValidate({ config: file, bin: "otelcol-contrib", _exec: exec });
    expect(r).toMatchObject({ ok: true, version: COLLECTOR_PIN.version, bin: "otelcol-contrib" });
    expect(calls[1]).toEqual(["otelcol-contrib", "validate", `--config=${file}`]);
  });

  test("refuses a binary at another version, before validating", async () => {
    const { exec, calls } = fakeExec("0.140.0");
    await expect(otelcolValidate({ config: configFile(), _exec: exec })).rejects.toThrow(/is v0\.140\.0.*COLLECTOR_PIN/);
    expect(calls).toHaveLength(1);
  });

  test("with a version given, checks the binary against that one instead", async () => {
    const ok = fakeExec("0.140.0", { validate: { code: 0 } });
    await expect(otelcolValidate({ config: configFile(), version: "v0.140.0", _exec: ok.exec })).resolves.toMatchObject({ version: "v0.140.0" });
    const off = fakeExec(PIN);
    await expect(otelcolValidate({ config: configFile(), version: "0.140.0", _exec: off.exec })).rejects.toThrow(/the step asks for v0\.140\.0/);
  });

  test("a config the binary rejects fails the step with its output", async () => {
    const { exec } = fakeExec(PIN, { validate: { code: 1, stderr: "Error: invalid configuration: receivers::otlp: unknown field" } });
    await expect(otelcolValidate({ config: configFile(), _exec: exec })).rejects.toThrow(/rejected .*unknown field/s);
  });

  test("a binary that will not start says so", async () => {
    const exec: ExecRunner = async () => ({ code: null, stdout: "", stderr: "", error: "spawn otelcol-contrib ENOENT" });
    await expect(otelcolValidate({ config: configFile(), _exec: exec })).rejects.toThrow(/could not run otelcol-contrib: spawn otelcol-contrib ENOENT/);
  });
});

describe("otelcolComponents", () => {
  test("parses the v0.130.0 components output (pins the unstable format)", () => {
    const list = parseComponentsOutput(FIXTURE);
    expect(list.version).toBe("v0.130.0");
    expect([...list.components.receiver].sort()).toEqual(["k8s_cluster", "otlp", "prometheus"]);
    expect([...list.components.processor].sort()).toEqual(["batch", "memory_limiter", "tail_sampling"]);
    expect([...list.components.exporter].sort()).toEqual(["debug", "otlp", "prometheus"]);
    expect([...list.components.connector].sort()).toEqual(["forward", "spanmetrics"]);
    expect([...list.components.extension].sort()).toEqual(["health_check", "zpages"]);
  });

  test("reads the older forms too: plain name lists and mappings", () => {
    const list = parseComponentsOutput("receivers: [otlp, jaeger]\nexporters:\n  debug: {}\n  otlp: {}\n");
    expect([...list.components.receiver]).toEqual(["otlp", "jaeger"]);
    expect([...list.components.exporter]).toEqual(["debug", "otlp"]);
    expect(list.version).toBeUndefined();
  });

  test("output with no component sections is an error, not an empty list", () => {
    expect(() => parseComponentsOutput("buildinfo:\n  version: 0.130.0\n")).toThrow(/listed no receivers/);
    expect(() => parseComponentsOutput("::: not yaml")).toThrow();
  });

  test("the config's components by kind, and the ones the binary lacks", () => {
    const used = configComponents({ receivers: { otlp: {} }, exporters: { "otlp/tempo": {}, "loki/x": {} }, connectors: { spanmetrics: {} } });
    expect(used.exporter).toEqual(["otlp/tempo", "loki/x"]);
    const missing = missingComponents(used, parseComponentsOutput(FIXTURE));
    expect(missing).toEqual([{ kind: "exporter", id: "loki/x", type: "loki" }]);
  });

  test("a renamed built-in counts under either name", () => {
    const list = parseComponentsOutput("exporters:\n  - name: otlp_grpc\nreceivers:\n  - name: otlp\n");
    expect(missingComponents(configComponents({ exporters: { otlp: {} } }), list)).toEqual([]);
    const old = parseComponentsOutput("exporters:\n  - name: otlp\nreceivers:\n  - name: otlp\n");
    expect(missingComponents(configComponents({ exporters: { otlp_grpc: {} } }), old)).toEqual([]);
  });

  test("passes a config the binary was built for", async () => {
    const { exec } = fakeExec(PIN, { components: { code: 0, stdout: FIXTURE } });
    const r = await otelcolComponents({ config: configFile(), _exec: exec });
    expect(r.missing).toEqual([]);
    expect(r.used.connector).toEqual(["spanmetrics"]);
    expect(r.version).toBe("v0.130.0");
  });

  test("refuses a config with a component the binary was not built with", async () => {
    const { exec } = fakeExec(PIN, { components: { code: 0, stdout: FIXTURE } });
    const config = configFile(CONFIG.replace("  debug: {}", "  debug: {}\n  datadog: {}"));
    await expect(otelcolComponents({ config, _exec: exec })).rejects.toThrow(/1 component\(s\).*exporter datadog/s);
  });
});
