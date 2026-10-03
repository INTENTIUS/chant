/**
 * Round trips through `chant import`.
 *
 * YAML -> TypeScript -> `chant build` -> YAML must give back the same config
 * (key order and quoting aside) for every fixture: the otel examples' built
 * output, a gateway with tail_sampling, loadbalancing and spanmetrics,
 * `genAiPipeline()` output, the two collector configs of
 * examples/agent-observability, and collector-contrib example configs at the
 * pinned release. The generated source must lint clean.
 *
 * The other direction too: a config using every built-in's typed fields
 * survives TypeScript -> YAML -> TypeScript -> YAML.
 *
 * Where `otelcol-contrib` is on PATH (or `OTELCOL_BIN` names a contrib
 * build) the re-emitted configs are also checked by `otelcol validate`.
 * generated-types.e2e.test.ts type-checks the generated source.
 */

import { describe, expect, test } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dump, load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { importCommand, importFromContent } from "@intentius/chant/cli/commands/import";
import { otelSerializer } from "../serializer";
import { collectorYaml } from "../collector";
import { registeredDefinitions } from "../define";
import { genAiPipeline } from "../genai";
import { COMPONENT_TYPE_ALIASES, SECTION_OF, type CollectorConfig, type ComponentKind } from "../model";
import * as c from "../components";
import { OtelCollectorParser } from "./parser";
import { OtelCollectorGenerator } from "./generator";
import { everyBuiltin, exampleOutputs, pkgDir, primary, read, UPSTREAM_BUILTIN_ONLY } from "./testdata/fixtures";

// ── helpers ─────────────────────────────────────────────────────────

/** A parsed config with the differences the collector does not see taken out. */
function normalize(yaml: string): CollectorConfig {
  const doc = (load(yaml) ?? {}) as CollectorConfig;
  for (const section of Object.values(SECTION_OF)) {
    const s = doc[section];
    if (!s) continue;
    for (const id of Object.keys(s)) if (s[id] === null) s[id] = {};
    if (Object.keys(s).length === 0) delete doc[section];
  }
  const service = doc.service;
  if (service) {
    if (service.extensions?.length === 0) delete service.extensions;
    for (const p of Object.values(service.pipelines ?? {})) {
      p.receivers ??= [];
      p.exporters ??= [];
      if (!p.processors || p.processors.length === 0) delete p.processors;
    }
    if (Object.keys(service).length === 0) delete doc.service;
  }
  return doc;
}

/**
 * The `# chant:` header lines, with the component list of a semconv line
 * sorted: the rebuilt config lists components in the order the build
 * discovers them, which within a module is export-name order.
 */
function headerLines(yaml: string): string[] {
  return yaml
    .split("\n")
    .filter((l) => /^#\s*chant:/.test(l))
    .map((l) => l.replace(/\(([^)]*)\)$/, (_, list: string) => `(${list.split(", ").sort().join(", ")})`));
}

interface Imported {
  source: string;
  warnings: string[];
  yaml: string;
  buildErrors: unknown[];
  lint: { errorCount: number; warningCount: number; output: string };
}

/** A chant project dir inside the package, so the lexicon resolves as it does for a user. */
function projectDir(): string {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["otel"] };\n');
  writeFileSync(join(dir, "package.json"), '{ "name": "otel-import-roundtrip", "private": true, "type": "module" }\n');
  return dir;
}

/** YAML -> IR -> TypeScript -> `chant build` -> YAML, and `chant lint` over the source. */
async function importAndBuild(yaml: string): Promise<Imported> {
  const ir = new OtelCollectorParser().parse(yaml);
  const files = new OtelCollectorGenerator().generate(ir);
  const dir = projectDir();
  try {
    const srcDir = join(dir, "src");
    for (const file of files) writeFileSync(join(srcDir, file.path), file.content);
    const result = await build(srcDir, [otelSerializer]);
    const lint = await lintCommand({ path: srcDir, format: "stylish" });
    return {
      source: files.map((f) => `// ${f.path}\n${f.content}`).join("\n"),
      warnings: ir.warnings ?? [],
      yaml: primary(result.outputs.get("otel")),
      buildErrors: result.errors,
      lint: { errorCount: lint.errorCount, warningCount: lint.warningCount, output: lint.output },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every import is expected to rebuild equal and lint clean; a fixture may name lint rules it expects to fire. */
async function expectRoundTrip(yaml: string, opts: { lintRules?: string[] } = {}): Promise<Imported> {
  const out = await importAndBuild(yaml);
  expect(out.buildErrors).toEqual([]);
  expect(normalize(out.yaml)).toEqual(normalize(yaml));
  if (opts.lintRules) {
    for (const rule of opts.lintRules) expect(out.lint.output).toContain(rule);
  } else {
    if (out.lint.errorCount + out.lint.warningCount > 0) console.log(out.lint.output);
    expect(out.lint.errorCount).toBe(0);
    expect(out.lint.warningCount).toBe(0);
  }
  return out;
}

function findOtelcol(): string | undefined {
  const candidates = [process.env.OTELCOL_BIN, "otelcol-contrib"].filter((b): b is string => !!b);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf-8" });
    if (r.status === 0) return bin;
  }
  return undefined;
}

const OTELCOL = findOtelcol();

function otelcolValidate(yaml: string): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "chant-otelcol-import-"));
  try {
    const file = join(dir, "config.yaml");
    writeFileSync(file, yaml);
    const r = spawnSync(OTELCOL!, ["validate", `--config=${file}`], {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, TEMPO_TOKEN: "t", DEPLOY_ENV: "test", SPLUNK_HEC_TOKEN: "t", K8S_NODE_NAME: "node-1" },
    });
    return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("YAML -> TypeScript -> YAML", () => {
  test("the otel examples' built output", async () => {
    const outputs = await exampleOutputs();
    expect(outputs.map(([n]) => n)).toEqual(["custom-component", "genai-agent", "getting-started", "k8s-node-agent", "tail-sampling-gateway"]);
    for (const [name, yaml] of outputs) {
      const out = await expectRoundTrip(yaml);
      // The `# chant:` header comes back too: the custom component's pin, the semconv line.
      expect(headerLines(out.yaml), name).toEqual(headerLines(yaml));
    }
  });

  test("a gateway with tail_sampling, loadbalancing and spanmetrics", async () => {
    const yaml = read("gateway.yaml");
    const out = await expectRoundTrip(yaml);
    expect(out.source).toContain("new TailSamplingProcessor(");
    expect(out.source).toContain("new LoadBalancingExporter(");
    expect(out.source).toContain("const spanmetrics = new SpanMetricsConnector(");
    // The connector is one entity, on both sides of the join.
    expect(out.source).toContain("exporters: [otlpTempo, spanmetrics]");
    expect(out.source).toContain("receivers: [spanmetrics]");
    // ${env:VAR} stays a reference.
    expect(out.source).toContain('authorization: "Bearer ${env:TEMPO_TOKEN}"');
    expect(out.source).toContain('default: "${env:DEPLOY_ENV}"');
    // pprof is declared but not enabled, so the Service lists what is.
    expect(out.source).toContain("extensions: [zpages, healthCheck]");
    expect(out.source).toContain("const telemetry: ServiceTelemetry = {");
    // Nested config is lifted into named consts typed by the component's config type (COR001).
    expect(out.source).toContain('const tailSamplingPolicies: TailSamplingProcessorConfig["policies"] = [');
    expect(out.warnings).toEqual([]);
  });

  test("genAiPipeline() output", async () => {
    const tempo = new c.OtlpExporter({ name: "tempo", endpoint: "tempo:4317", tls: { insecure: true } });
    const sampler = new c.ProbabilisticSamplerProcessor({ sampling_percentage: 25 });
    for (const entities of [
      genAiPipeline(),
      genAiPipeline({ traceExporters: [tempo], sampling: [sampler], keepContent: true, logs: false }),
      genAiPipeline({ maskValues: ["\\b[0-9]{13,16}\\b"], hashFunction: "sha3", healthCheck: false }),
    ]) {
      const yaml = collectorYaml(entities);
      const out = await expectRoundTrip(yaml);
      expect(headerLines(out.yaml)).toEqual(headerLines(yaml));
    }
  });

  test("a signaltometrics connector imports to the typed class", async () => {
    const out = await expectRoundTrip(read("signaltometrics.yaml"));
    expect(out.source).toContain("new SignalToMetricsConnector(");
    expect(out.source).not.toContain("defineComponent");
    // The connector is one entity, on both sides of the join.
    expect(out.source).toContain("receivers: [signaltometricsGenai]");
    // A constant OTTL value stays a string.
    expect(load(out.yaml)).toMatchObject({ connectors: { "signaltometrics/genai": { logs: [{ sum: { value: "1" } }] } } });
    expect(out.warnings).toEqual([]);
  });

  test("a k8s_leader_elector extension imports to the typed class", async () => {
    const out = await expectRoundTrip(read("k8s-leader-elector.yaml"));
    expect(out.source).toContain("new K8sLeaderElectorExtension(");
    expect(out.source).not.toContain("defineComponent");
    expect(out.source).toContain('lease_name: "otel-k8s-cluster"');
    expect(out.warnings).toEqual([]);
  });

  test("the collector configs of examples/agent-observability", async () => {
    for (const file of ["agent-observability-agent.yaml", "agent-observability-gateway.yaml"]) {
      await expectRoundTrip(read(file));
    }
  });

  for (const file of UPSTREAM_BUILTIN_ONLY) {
    test(`collector-contrib v0.130.0: ${file}`, async () => {
      const out = await expectRoundTrip(read("upstream", file));
      expect(out.source).not.toContain("defineComponent");
    });
  }

  test.skipIf(!OTELCOL)("otelcol validate accepts every re-emitted config", async () => {
    // Not the agent-observability agent: its k8s resolver needs a cluster to build (that example's own tests swap it for dns).
    const yamls: Array<[string, string]> = [
      ["gateway.yaml", read("gateway.yaml")],
      ["signaltometrics.yaml", read("signaltometrics.yaml")],
      ["agent-observability-gateway.yaml", read("agent-observability-gateway.yaml")],
      ["genAiPipeline()", collectorYaml(genAiPipeline())],
      ...UPSTREAM_BUILTIN_ONLY.map((f): [string, string] => [f, read("upstream", f)]),
      // hostmetrics' root_path is accepted on linux only, which is where the node agent runs.
      ...(await exampleOutputs()).filter(([n]) => n !== "k8s-node-agent" || process.platform === "linux"),
    ];
    for (const [name, yaml] of yamls) {
      const { yaml: rebuilt } = await importAndBuild(yaml);
      const { ok, output } = otelcolValidate(rebuilt);
      expect(ok, `${name}: ${output}`).toBe(true);
    }
  });

});

/** `yaml` with every renamed built-in written under the collector's newer name (`spanmetrics` as `span_metrics`). */
function withNewNames(yaml: string): string {
  const doc = (load(yaml) ?? {}) as CollectorConfig;
  const renamed = new Map<string, string>();
  for (const kind of Object.keys(SECTION_OF) as ComponentKind[]) {
    const section = doc[SECTION_OF[kind]];
    if (!section) continue;
    const out: Record<string, unknown> = {};
    for (const [id, cfg] of Object.entries(section)) {
      const slash = id.indexOf("/");
      const type = slash === -1 ? id : id.slice(0, slash);
      const alias = COMPONENT_TYPE_ALIASES.find((a) => a.kind === kind && a.builtin === type);
      const next = alias ? `${alias.type}${slash === -1 ? "" : id.slice(slash)}` : id;
      if (alias) renamed.set(`${kind}:${id}`, next);
      out[next] = cfg;
    }
    (doc as Record<string, unknown>)[SECTION_OF[kind]] = out;
  }
  // A receiver and an exporter may share an id (`otlp`), so each list renames only its own kinds.
  const kindsOf = { receivers: ["receiver", "connector"], processors: ["processor"], exporters: ["exporter", "connector"] } as const;
  for (const p of Object.values(doc.service?.pipelines ?? {})) {
    for (const list of ["receivers", "processors", "exporters"] as const) {
      p[list] = p[list]?.map((id) => kindsOf[list].map((k) => renamed.get(`${k}:${id}`)).find(Boolean) ?? id);
    }
  }
  return dump(doc, { lineWidth: -1 });
}

describe("the collector's newer names for renamed built-ins", () => {
  test("import to the same classes as the old names, and build back to the old names", async () => {
    const fixtures: Array<[string, string]> = [
      ["every built-in", collectorYaml(everyBuiltin())],
      ["gateway.yaml", read("gateway.yaml")],
      ["signaltometrics.yaml", read("signaltometrics.yaml")],
    ];
    const used = new Set<string>();
    for (const [name, yaml] of fixtures) {
      const renamedYaml = withNewNames(yaml);
      if (renamedYaml === dump(load(yaml), { lineWidth: -1 })) continue;
      const before = await importAndBuild(yaml);
      const after = await importAndBuild(renamedYaml);
      expect(after.buildErrors, name).toEqual([]);
      const classes = (src: string) => [...src.matchAll(/new ([A-Z]\w+)\(/g)].map((m) => m[1]).sort();
      expect(classes(after.source), name).toEqual(classes(before.source));
      expect(after.source, name).not.toContain("defineComponent<");
      // Emitted names stay the ones the pinned collector knows.
      expect(normalize(after.yaml), name).toEqual(normalize(yaml));
      for (const w of after.warnings) {
        const m = /uses "(\w+)", the collector's newer name for "(\w+)"/.exec(w);
        if (m) used.add(m[1]);
      }
    }
    // The every-built-in fixture uses all twelve renamed types.
    expect([...used].sort()).toEqual(COMPONENT_TYPE_ALIASES.map((a) => a.type).sort());
  });
});

describe("components chant does not ship", () => {
  test("go through defineComponent with their config as data, and survive the round trip", async () => {
    const out = await expectRoundTrip(read("upstream", "fault-tolerant-logs.yaml"));
    expect(out.source).toContain("const FileStorageExtension = defineComponent<Record<string, unknown>>()({");
    expect(out.source).toContain("pin: COLLECTOR_PIN,");
    expect(out.source).toMatch(/\/\/ extension "file_storage" is not a component chant ships/);
    expect(out.source).toContain('const fileStorageFilelogreceiver = new FileStorageExtension({');
    expect(out.source).toContain('import { FileStorageExtension } from "./custom-components";');
    // The typed built-ins keep referring to the storage extension by id, as data.
    expect(out.source).toContain('storage: "file_storage/filelogreceiver"');
  });

  test("an unknown receiver and exporter in the loadbalancing agent example", async () => {
    const out = await expectRoundTrip(read("upstream", "loadbalancing-agent.yaml"));
    expect(out.source).toContain('type: "fluentforward"');
    expect(out.source).toContain("new LoadBalancingExporter(");
  });

  test("nop receivers and exporters around a servicegraph connector", async () => {
    const out = await expectRoundTrip(read("upstream", "servicegraph-nop.yaml"));
    expect(out.source).toContain("const NopReceiver = defineComponent");
    expect(out.source).toContain("const NopExporter = defineComponent");
    expect(out.source).toContain("const servicegraph = new ServiceGraphConnector(");
  });

  test("a literal credential is imported as found and reported by OTEL002", async () => {
    const out = await expectRoundTrip(read("upstream", "couchbase.yaml"), { lintRules: ["OTEL002"] });
    expect(out.source).toContain('password: "otelpassword"');
    expect(out.source).toContain("const MetricstransformProcessor = defineComponent");
  });

  test("a pin from the `# chant:` header is carried back into defineComponent", async () => {
    const yaml = [
      "# chant: exporter datadog/eu schema github.com/open-telemetry/opentelemetry-collector-contrib/exporter/datadogexporter@v0.129.0 sha256:abc",
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc: {}",
      "exporters:",
      "  datadog/eu:",
      "    api:",
      "      key: ${env:DD_API_KEY}",
      "      site: datadoghq.eu",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [datadog/eu]",
      "",
    ].join("\n");
    const out = await expectRoundTrip(yaml);
    expect(out.source).toContain('version: "v0.129.0"');
    expect(out.source).toContain('digest: "sha256:abc"');
    expect(out.source).not.toContain("COLLECTOR_PIN,");
    expect(headerLines(out.yaml)).toEqual(headerLines(yaml));
  });
});

describe("TypeScript -> YAML -> TypeScript -> YAML", () => {
  test("every built-in, each using its typed fields", async () => {
    const entities = everyBuiltin();
    const first = collectorYaml(entities);

    // The fixture covers every built-in this package registers.
    const config = load(first) as CollectorConfig;
    const used = new Set<string>();
    for (const [kind, section] of Object.entries(SECTION_OF) as Array<[ComponentKind, keyof CollectorConfig]>) {
      for (const id of Object.keys((config[section] as Record<string, unknown>) ?? {})) used.add(`${kind}:${id.split("/")[0]}`);
    }
    const builtins = registeredDefinitions().filter((d) => d.builtin).map((d) => `${d.kind}:${d.type}`);
    expect([...used].sort()).toEqual([...new Set(builtins)].sort());

    const out = await expectRoundTrip(first);
    expect(out.source).not.toContain("defineComponent");
    // Importing is a fixed point from there: the rebuilt YAML (components now in
    // export-name order within each section) gives the same TypeScript and YAML, text for text.
    const again = await importAndBuild(out.yaml);
    const third = await importAndBuild(again.yaml);
    expect(third.source).toBe(again.source);
    expect(third.yaml).toBe(again.yaml);
  });
});

// ── through core's import command ───────────────────────────────────

test("importFromContent writes one module per section through the otel plugin", async () => {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  try {
    const output = join(dir, "src");
    const result = await importFromContent({ content: read("gateway.yaml"), lexicon: "otel", output });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.lexicon).toBe("otel");
    expect(result.generatedFiles).toEqual([
      "receivers.ts",
      "processors.ts",
      "exporters.ts",
      "connectors.ts",
      "extensions.ts",
      "pipelines.ts",
      "service.ts",
    ]);
    const built = await build(output, [otelSerializer]);
    expect(built.errors).toEqual([]);
    expect(normalize(primary(built.outputs.get("otel")))).toEqual(normalize(read("gateway.yaml")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("chant import collector.yaml", () => {
  for (const lexicon of [undefined, "otel"]) {
    test(lexicon ? "with --lexicon otel" : "detected as a collector config", async () => {
      const dir = projectDir();
      try {
        const templatePath = join(dir, "collector.yaml");
        writeFileSync(templatePath, read("gateway.yaml"));
        const output = join(dir, "src");
        const result = await importCommand({ templatePath, output, force: true, lexicon });
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.lexicon).toBe("otel");
        expect(result.generatedFiles).toContain("pipelines.ts");
        const built = await build(output, [otelSerializer]);
        expect(built.errors).toEqual([]);
        expect(normalize(primary(built.outputs.get("otel")))).toEqual(normalize(read("gateway.yaml")));
        const lint = await lintCommand({ path: output, format: "stylish" });
        expect(lint.errorCount + lint.warningCount, lint.output).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
