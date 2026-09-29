import { describe, expect, test } from "vitest";
import { EmbeddedImports, type EmbeddedContent, type EmbeddedContentImporter } from "@intentius/chant/import/embedded";
import { K8sParser } from "./parser";
import { K8sGenerator } from "./generator";

const MANIFEST = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: otel-agent
  labels:
    app.kubernetes.io/name: otel-agent
data:
  config.yaml: |
    receivers:
      otlp: {}
    exporters:
      debug: {}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          exporters: [debug]
  plain.txt: just text
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: dashboards
  labels:
    grafana_dashboard: "1"
data:
  api.json: '{"title": "API", "panels": [], "schemaVersion": 41}'
---
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: api-rules
spec:
  groups:
    - name: api
      rules:
        - alert: Down
          expr: up == 0
`;

/** Claims every offered piece of content, recording it, as `fake.ts` exporting `thing`. */
function claimAll(seen: EmbeddedContent[]): EmbeddedContentImporter {
  return {
    what: "anything",
    matches: () => true,
    import: (c) => {
      seen.push(c);
      return {
        files: [{ path: "fake.ts", content: "const thing = 1;\n\nexport { thing };\n" }],
        value: { bindings: [{ from: "fake.ts", name: "thing" }], shape: "single", through: { from: "@acme/fake", name: "render" } },
      };
    },
  };
}

describe("k8s import offers embedded content (#2962)", () => {
  test("without a resolver, everything is kept as written", () => {
    const ir = new K8sParser().parse(MANIFEST);
    expect((ir.resources[0].properties.data as Record<string, unknown>)["config.yaml"]).toContain("receivers:");
  });

  test("ConfigMap values that parse as documents, and a PrometheusRule's groups, are offered", () => {
    const seen: EmbeddedContent[] = [];
    const embedded = new EmbeddedImports([{ lexicon: "acme", importer: claimAll(seen) }]);
    new K8sParser().parse(MANIFEST, { embedded });

    // plain.txt is not a document and is not offered.
    expect(seen.map((c) => [c.location, c.directory, c.select, c.expectedOwner?.lexicon])).toEqual([
      ['ConfigMap otel-agent data["config.yaml"]', "otel-agent-config", undefined, "otel"],
      ['ConfigMap dashboards data["api.json"]', "dashboards", undefined, "grafana"],
      ["PrometheusRule api-rules spec.groups", "api-rules", "groups", "prometheus"],
    ]);
    expect(seen[1].labels).toEqual({ grafana_dashboard: "1" });
    expect(seen[2].document).toEqual({ groups: [{ name: "api", rules: [{ alert: "Down", expr: "up == 0" }] }] });
    expect(embedded.files.map((f) => f.path)).toEqual(["otel-agent-config/fake.ts", "dashboards/fake.ts", "api-rules/fake.ts"]);
  });

  test("the generator references what the owner declared, and quotes keys that are not identifiers", () => {
    const embedded = new EmbeddedImports([{ lexicon: "acme", importer: claimAll([]) }]);
    const ir = new K8sParser().parse(MANIFEST, { embedded });
    const [main] = new K8sGenerator().generate(ir);
    expect(main.content).toContain('import { render } from "@acme/fake";');
    expect(main.content).toContain('import { thing } from "./otel-agent-config/fake";');
    expect(main.content).toContain('import { thing as thing2 } from "./dashboards/fake";');
    expect(main.content).toContain('"config.yaml": render(thing),');
    expect(main.content).toContain('"api.json": render(thing2),');
    expect(main.content).toContain("groups: render(thing3),");
    expect(main.content).toContain('"plain.txt": "just text",');
    expect(main.content).toContain('"app.kubernetes.io/name": "otel-agent",');
  });

  test("when no installed lexicon imports it, the content is kept and the expected owner is named", () => {
    const embedded = new EmbeddedImports([]);
    const ir = new K8sParser().parse(MANIFEST, { embedded });
    expect((ir.resources[0].properties.data as Record<string, unknown>)["config.yaml"]).toContain("receivers:");
    expect(embedded.warnings).toHaveLength(3);
    expect(embedded.warnings[0]).toMatch(/^ConfigMap otel-agent data\["config.yaml"\] looks like an OpenTelemetry Collector config/);
    expect(embedded.warnings[0]).toContain("@intentius/chant-lexicon-otel");
    expect(embedded.warnings[1]).toContain("@intentius/chant-lexicon-grafana");
    expect(embedded.warnings[2]).toContain("@intentius/chant-lexicon-prometheus");
    const [main] = new K8sGenerator().generate(ir);
    expect(main.content).not.toContain("import { render");
  });
});

describe("the k8s generator's imports", () => {
  test("a constructor named inside a string value is not imported", () => {
    const ir = new K8sParser().parse(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: app
data:
  main.js: 'const x = new Widget("a");'
`);
    const [main] = new K8sGenerator().generate(ir);
    expect(main.content.split("\n")[0]).toBe('import { ConfigMap } from "@intentius/chant-lexicon-k8s";');
  });
});
