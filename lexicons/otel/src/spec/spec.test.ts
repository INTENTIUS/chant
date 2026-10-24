import { describe, expect, test } from "vitest";
import { CONTRIB_MODULE, CORE_MODULE, locate, parseManifest, refsIn, resolveRef } from "./fetch";
import { documentAlias, generateTypes, isDeprecated, propertyDocs } from "./parse";
import {
  OTEL_SPEC_PIN,
  OTELCOL_CONTRIB_VERSION,
  OTELCOL_K8S_VERSION,
  assertPinnedSnapshot,
  assertSnapshotVersions,
  canonicalJson,
  specDigest,
} from "./pin";
import { loadSnapshot } from "./snapshot";
import { BUILTIN_SPECS } from "./builtins";
import { BUILTIN_CATALOG } from "../catalog";

const OTLP = `${CORE_MODULE}/receiver/otlpreceiver`;
const TAIL = `${CONTRIB_MODULE}/processor/tailsamplingprocessor`;

describe("manifests and refs", () => {
  test("a builder manifest lists component modules by kind, without providers", () => {
    const modules = parseManifest(`
dist: { name: otelcol-contrib }
receivers:
  - gomod: go.opentelemetry.io/collector/receiver/otlpreceiver v0.162.0
connectors:
  - gomod: github.com/open-telemetry/opentelemetry-collector-contrib/connector/countconnector v0.162.0
providers:
  - gomod: go.opentelemetry.io/collector/confmap/provider/envprovider v1.48.0
`);
    expect(modules).toEqual([
      { kind: "receiver", module: OTLP, version: "v0.162.0" },
      { kind: "connector", module: `${CONTRIB_MODULE}/connector/countconnector`, version: "v0.162.0" },
    ]);
  });

  test("each $ref form resolves to a package and a definition", () => {
    expect(resolveRef(TAIL, "and_cfg")).toEqual({ doc: TAIL, def: "and_cfg" });
    expect(resolveRef(TAIL, "./internal/metadata.config")).toEqual({ doc: `${TAIL}/internal/metadata`, def: "config" });
    expect(resolveRef(OTLP, "/config/configgrpc.server_config")).toEqual({ doc: `${CORE_MODULE}/config/configgrpc`, def: "server_config" });
    expect(resolveRef(TAIL, "/pkg/ottl.error_mode")).toEqual({ doc: `${CONTRIB_MODULE}/pkg/ottl`, def: "error_mode" });
    expect(resolveRef(TAIL, "go.opentelemetry.io/collector/config/configopaque.string")).toEqual({
      doc: `${CORE_MODULE}/config/configopaque`,
      def: "string",
    });
    expect(refsIn({ a: { $ref: "x" }, b: [{ $ref: "y" }] })).toEqual(["x", "y"]);
  });

  test("core packages read from opentelemetry-collector, contrib ones from contrib", () => {
    const tags = { core: "v0.162.0", contrib: "v0.162.0" };
    expect(locate(OTLP, tags)).toMatchObject({ repo: "open-telemetry/opentelemetry-collector", path: "receiver/otlpreceiver" });
    expect(locate(TAIL, tags)).toMatchObject({ repo: "open-telemetry/opentelemetry-collector-contrib", path: "processor/tailsamplingprocessor" });
    expect(locate("go.opentelemetry.io/obi", tags)).toBeUndefined();
  });
});

describe("schema to TypeScript", () => {
  const docs = {
    "example.com/c": {
      $defs: {
        node: { type: "object", properties: { next: { $ref: "node" }, level: { $ref: "go.opentelemetry.io/collector/config/configtelemetry.level" } } },
      },
      description: "Config of c.",
      type: "object",
      properties: {
        timeout: { type: "string", format: "duration", description: "Timeout. Deprecated: use deadline." },
        grpc: { "x-optional": true, $ref: "node" },
        mode: { type: "string", enum: ["a", "b"] },
        count: { type: "integer", "x-customType": "uint64" },
        id: { type: "string", "x-customType": "go.opentelemetry.io/collector/component.ID" },
        labels: { type: "object", additionalProperties: { type: "string" } },
        missing: { $ref: "/nowhere.thing" },
      },
      allOf: [{ $ref: "go.opentelemetry.io/collector/config/confighttp.server_config" }],
    },
    "go.opentelemetry.io/collector/config/confighttp": { $defs: { server_config: { type: "object", properties: { endpoint: { type: "string" } } } } },
    "go.opentelemetry.io/collector/config/configtelemetry": { $defs: { level: { type: "integer" } } },
  };

  test("definitions become named aliases; extensions map to TypeScript", () => {
    const g = generateTypes(docs, ["example.com/c"]);
    const root = g.roots.get("example.com/c")!;
    expect(root).toBe("ExampleComCSchema");
    expect(g.declarations).toContain(`export type ${root} = CollectorConfigConfighttpServerConfig & {`);
    expect(g.declarations).toContain("timeout?: Duration;");
    expect(g.declarations).toContain("@deprecated");
    expect(g.declarations).toContain("grpc?: ExampleComCNode | null;");
    expect(g.declarations).toContain('mode?: "a" | "b";');
    expect(g.declarations).toContain("count?: number;");
    expect(g.declarations).toContain("id?: string;");
    expect(g.declarations).toContain("labels?: Record<string, string>;");
    expect(g.declarations).toContain("missing?: unknown;");
    // Recursive definitions refer to themselves by name.
    expect(g.declarations).toContain("next?: ExampleComCNode;");
    // configtelemetry.Level is read from its name, not its number.
    expect(g.declarations).toContain('export type CollectorConfigConfigtelemetryLevel = "none" | "basic" | "normal" | "detailed";');
    expect([...g.unresolved.keys()]).toEqual(["/nowhere.thing"]);
  });

  test("property docs carry descriptions, short types and deprecation, embedded structs flattened", () => {
    const props = propertyDocs(docs, "example.com/c");
    expect(props.endpoint).toEqual({ type: "string" });
    expect(props.timeout).toMatchObject({ type: "duration", deprecated: true });
    expect(props.grpc.properties?.level.type).toBe('"none" | "basic" | "normal" | "detailed"');
    expect(props.labels.type).toBe("object");
  });

  test("deprecation is read from Go comment forms", () => {
    expect(isDeprecated("Deprecated: use X")).toBe(true);
    expect(isDeprecated("Size of cache. Deprecated [v0.130.0]: use Y")).toBe(true);
    expect(isDeprecated("Not deprecated at all")).toBe(false);
    expect(documentAlias(`${CONTRIB_MODULE}/pkg/ottl`)).toBe("PkgOttl");
  });
});

describe("the committed snapshot", () => {
  const snapshot = loadSnapshot();

  test("matches the pin and the version constants", () => {
    expect(snapshot.versions["otelcol-contrib"]).toBe(OTELCOL_CONTRIB_VERSION);
    expect(snapshot.versions["otelcol-k8s"]).toBe(OTELCOL_K8S_VERSION);
    expect(specDigest(snapshot)).toBe(OTEL_SPEC_PIN.digest);
    expect(Object.keys(snapshot.schemas)).toHaveLength(OTEL_SPEC_PIN.documents);
    expect(() => assertPinnedSnapshot(snapshot)).not.toThrow();
  });

  test("a changed snapshot or version refuses, and the accept env var warns instead", () => {
    const edited = { ...snapshot, schemas: { ...snapshot.schemas, "example.com/x": {} } };
    expect(() => assertPinnedSnapshot(edited, { env: {} })).toThrow(/does not match OTEL_SPEC_PIN/);
    const warnings: string[] = [];
    assertPinnedSnapshot(edited, { env: { CHANT_ACCEPT_OTEL_SPEC: "1" }, warn: (m) => warnings.push(m) });
    expect(warnings[0]).toContain("documents: 132");
    expect(() => assertSnapshotVersions({ "otelcol-contrib": "v0.1.0", "otelcol-k8s": OTELCOL_K8S_VERSION })).toThrow(/just snapshot/);
  });

  test("the digest ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });

  test("BUILTIN_SPECS lists the exported component classes", () => {
    const fromCatalog = BUILTIN_CATALOG.filter((c) => c.type !== undefined).map((c) => `${c.className} ${c.kind} ${c.type}`);
    expect(BUILTIN_SPECS.map((b) => `${b.className} ${b.kind} ${b.type}`).sort()).toEqual(fromCatalog.sort());
  });
});
