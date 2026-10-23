import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { makePostSynthCtx } from "@intentius/chant-test-utils";
import type { Declarable } from "@intentius/chant/declarable";
import type { ProcessRunner } from "@intentius/chant/components/verbs/process-runner";
import { BUILTIN_CATALOG } from "./catalog";
import { COLLECTOR_PIN, defineComponent } from "./define";
import { otelSerializer } from "./serializer";
import { otel128 } from "./lint/post-synth/otel128";
import {
  BUILTIN_MODULES,
  DISTRIBUTION_MANIFEST_FILE,
  Distribution,
  distributionManifest,
  distributionYaml,
  moduleComponentType,
} from "./distribution";
import { createOcbBuildCapability, ocbOutputPath } from "./build/ocb-build";
import { otelCapabilityPlugin, ocbBuild } from "./build/capability-plugin";
import {
  BatchProcessor,
  DebugExporter,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
  SpanMetricsConnector,
  TransformProcessor,
  otelPlugin,
} from "./index";

const V = COLLECTOR_PIN.version;
const CORE = "go.opentelemetry.io/collector";
const CONTRIB = "github.com/open-telemetry/opentelemetry-collector-contrib";

const AcmeExporter = defineComponent<{ endpoint: string }>()({
  kind: "exporter",
  type: "acme",
  pin: { source: "github.com/acme/otel/exporter/acmeexporter", version: "v1.4.2" },
});

/**
 * The keys of the builder's `Config`, `Distribution` and `Module` structs at
 * v0.130.0 (`cmd/builder/internal/builder/config.go`). ocb reads the manifest
 * strictly, so a key outside these fails the build.
 */
const OCB_CONFIG_KEYS = ["dist", "receivers", "processors", "exporters", "connectors", "extensions", "providers", "converters", "replaces", "excludes", "conf_resolver"];
const OCB_DIST_KEYS = ["module", "name", "go", "description", "output_path", "version", "build_tags", "debug_compilation", "cgo_enabled", "use_absolute_replace_paths"];
const OCB_MODULE_KEYS = ["gomod", "import", "name", "path"];

function entities(record: Record<string, unknown>): Map<string, Declarable> {
  return new Map(Object.entries(record) as Array<[string, Declarable]>);
}

function distribution(extra: Partial<ConstructorParameters<typeof Distribution>[0]> = {}) {
  return new Distribution({
    dist: { name: "otelcol-acme", description: "Acme collector", output_path: "./_build", version: "1.0.0" },
    receivers: [OtlpReceiver],
    processors: [BatchProcessor, TransformProcessor],
    exporters: [OtlpExporter, DebugExporter, AcmeExporter],
    ...extra,
  });
}

describe("Distribution manifest (#3374)", () => {
  test("every built-in has a Go module, and the table names nothing else", () => {
    const builtins = BUILTIN_CATALOG.filter((e) => e.type).map((e) => `${e.kind}:${e.type}`).sort();
    expect(Object.keys(BUILTIN_MODULES).sort()).toEqual(builtins);
    for (const path of Object.values(BUILTIN_MODULES)) expect(path.startsWith(CORE) || path.startsWith(CONTRIB)).toBe(true);
  });

  test("built-ins write their module at COLLECTOR_PIN, a custom component its own pin", () => {
    const m = distributionManifest(distribution({ providers: [{ gomod: `${CORE}/confmap/provider/envprovider v1.36.0` }] }));
    expect(m).toEqual({
      dist: { name: "otelcol-acme", description: "Acme collector", output_path: "./_build", version: "1.0.0" },
      receivers: [{ gomod: `${CORE}/receiver/otlpreceiver ${V}` }],
      processors: [{ gomod: `${CORE}/processor/batchprocessor ${V}` }, { gomod: `${CONTRIB}/processor/transformprocessor ${V}` }],
      exporters: [
        { gomod: `${CORE}/exporter/otlpexporter ${V}` },
        { gomod: `${CORE}/exporter/debugexporter ${V}` },
        { gomod: "github.com/acme/otel/exporter/acmeexporter v1.4.2" },
      ],
      providers: [{ gomod: `${CORE}/confmap/provider/envprovider v1.36.0` }],
    });
  });

  test("the YAML holds only keys ocb's config knows, and reads back to the manifest", () => {
    const d = distribution({
      dist: { module: "github.com/acme/otelcol", name: "otelcol-acme", go: "/usr/local/go/bin/go", output_path: "./_build", build_tags: "netgo", debug_compilation: false, cgo_enabled: false, use_absolute_replace_paths: true },
      connectors: [SpanMetricsConnector],
      extensions: [{ gomod: "github.com/acme/otel/extension/acmeauthextension v1.4.2", import: "github.com/acme/otel/extension/acmeauthextension/v2", name: "acmeauth", path: "./acmeauth" }],
      converters: [{ gomod: "github.com/acme/otel/converter v0.1.0" }],
      replaces: ["github.com/acme/otel => ../otel"],
      excludes: ["github.com/bad/mod v1.0.0"],
      conf_resolver: { default_uri_scheme: "env" },
    });
    const doc = load(distributionYaml(d)) as Record<string, unknown>;
    expect(doc).toEqual(distributionManifest(d));
    for (const k of Object.keys(doc)) expect(OCB_CONFIG_KEYS).toContain(k);
    for (const k of Object.keys(doc.dist as object)) expect(OCB_DIST_KEYS).toContain(k);
    for (const list of ["receivers", "processors", "exporters", "connectors", "extensions", "providers", "converters"]) {
      for (const mod of (doc[list] as Array<Record<string, unknown>> | undefined) ?? []) {
        for (const k of Object.keys(mod)) expect(OCB_MODULE_KEYS).toContain(k);
        expect(mod.gomod).toMatch(/^\S+ v\d+\.\d+\.\d+\S*$/);
      }
    }
  });

  test("a component listed under the wrong kind is refused", () => {
    const d = new Distribution({ dist: {}, receivers: [OtlpExporter as never] });
    expect(() => distributionManifest(d)).toThrow(/otlp is a exporter, listed under the distribution's receivers/);
  });

  test("a module's component type is read from a built-in's path or a contrib-style name", () => {
    expect(moduleComponentType("receiver", `${CORE}/receiver/otlpreceiver ${V}`)).toBe("otlp");
    expect(moduleComponentType("extension", `${CONTRIB}/extension/k8sleaderelector ${V}`)).toBe("k8s_leader_elector");
    expect(moduleComponentType("exporter", `${CONTRIB}/exporter/datadogexporter ${V}`)).toBe("datadog");
    expect(moduleComponentType("exporter", "github.com/acme/otel/vendor-out v1.0.0")).toBeUndefined();
  });
});

describe("otel serializer with a Distribution (#3374)", () => {
  const config = () => {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const debug = new DebugExporter({});
    return { otlp, debug, traces: new Pipeline({ signal: "traces", receivers: [otlp], exporters: [debug] }) };
  };

  test("writes the builder manifest beside the config", () => {
    const out = otelSerializer.serialize(entities({ ...config(), dist: distribution() }));
    expect(typeof out).toBe("object");
    const files = (out as { files?: Record<string, string> }).files!;
    expect(Object.keys(files)).toEqual([DISTRIBUTION_MANIFEST_FILE]);
    expect(load(files[DISTRIBUTION_MANIFEST_FILE])).toEqual(distributionManifest(distribution()));
  });

  test("a project without a Distribution serializes as before", () => {
    const out = otelSerializer.serialize(entities(config()));
    expect(typeof out).toBe("string");
  });

  test("the Distribution is not part of the collector config", () => {
    const withDist = otelSerializer.serialize(entities({ ...config(), dist: distribution() }));
    expect((withDist as { primary: string }).primary).toBe(otelSerializer.serialize(entities(config())));
  });
});

describe("OTEL128: the config uses only what the Distribution builds (#3374)", () => {
  function run(extra: Record<string, unknown>, dist?: unknown) {
    const otlp = new OtlpReceiver({ protocols: { grpc: { endpoint: "0.0.0.0:4317" } } });
    const all = { otlp, ...extra };
    const yaml = otelSerializer.serialize(entities(all));
    const primary = typeof yaml === "string" ? yaml : yaml.primary;
    return otel128.check(makePostSynthCtx("otel", primary, entities(dist ? { ...all, dist } : all)));
  }

  test("reports a component missing from the Distribution", () => {
    const diags = run({ otlpOut: new OtlpExporter({ endpoint: "tempo:4317" }), spans: new SpanMetricsConnector({}) }, distribution());
    expect(diags.map((d) => [d.checkId, d.severity, d.entity])).toEqual([["OTEL128", "error", "spanmetrics"]]);
    expect(diags[0].message).toContain('connector "spanmetrics" is not in the Distribution');
  });

  test("a config the Distribution covers has no finding", () => {
    expect(run({ otlpOut: new OtlpExporter({ endpoint: "tempo:4317" }), batch: new BatchProcessor({}) }, distribution())).toEqual([]);
  });

  test("a project without a Distribution is not checked", () => {
    expect(run({ spans: new SpanMetricsConnector({}) })).toEqual([]);
  });

  test("a module whose type can't be told makes a missing component a warning that names it", () => {
    const d = distribution({ connectors: [{ gomod: "github.com/acme/otel/joiner v1.0.0" }] });
    const diags = run({ spans: new SpanMetricsConnector({}) }, d);
    expect(diags.map((x) => x.severity)).toEqual(["warning"]);
    expect(diags[0].message).toContain('"github.com/acme/otel/joiner"');
  });

  test("is registered and catalogued", () => {
    expect(otelPlugin.postSynthChecks!().map((c) => c.id)).toContain("OTEL128");
  });
});

describe("ocb-build (#3374)", () => {
  function runner(available = true) {
    const calls: Array<{ command: string; cwd?: string }> = [];
    const r: ProcessRunner = {
      async run(command, options) {
        calls.push({ command, cwd: options?.cwd });
        return { stdout: "", stderr: "" };
      },
      async available() {
        return available;
      },
    };
    return { r, calls };
  }

  function manifest(text: string): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "ocb-build-"));
    const path = join(dir, DISTRIBUTION_MANIFEST_FILE);
    writeFileSync(path, text);
    return { dir, path };
  }

  test("runs ocb in the manifest's directory and hands on the output directory", async () => {
    const m = manifest(distributionYaml(distribution()));
    try {
      const { r, calls } = runner();
      const out = await createOcbBuildCapability(r).run({ env: "dev", component: "collector" }, { config: m.path, skipCompilation: true });
      expect(calls).toEqual([{ command: `'ocb' --config '${m.path}' --skip-compilation`, cwd: m.dir }]);
      expect(out.kind).toBe("dir");
      expect(out.dir).toBe(join(m.dir, "_build"));
      expect(out.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      rmSync(m.dir, { recursive: true, force: true });
    }
  });

  test("refuses a manifest with no dist.output_path before running ocb", async () => {
    const m = manifest(distributionYaml(new Distribution({ dist: { name: "x" }, receivers: [OtlpReceiver] })));
    try {
      const { r, calls } = runner();
      await expect(createOcbBuildCapability(r).run({ env: "dev", component: "c" }, { config: m.path })).rejects.toThrow(/sets no dist.output_path/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(m.dir, { recursive: true, force: true });
    }
  });

  test("says when ocb is not installed", async () => {
    const m = manifest(distributionYaml(distribution()));
    try {
      await expect(createOcbBuildCapability(runner(false).r).run({ env: "dev", component: "c" }, { config: m.path })).rejects.toThrow(/"ocb" is not installed/);
    } finally {
      rmSync(m.dir, { recursive: true, force: true });
    }
  });

  test("an absolute output_path is kept", () => {
    expect(ocbOutputPath("dist:\n  output_path: /opt/build\n", "/work")).toBe("/opt/build");
  });

  test("the lexicon contributes it as a build verb", () => {
    expect(otelCapabilityPlugin.capabilities().map((c) => c.kind)).toEqual(["ocb-build"]);
    expect(otelCapabilityPlugin.families!()).toEqual({ build: ["ocb-build"] });
    expect(ocbBuild({ config: "dist/builder-config.yaml" })).toEqual({ kind: "ocb-build", config: "dist/builder-config.yaml" });
  });
});
