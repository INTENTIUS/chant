/**
 * `prometheus.yml` through `chant import`: YAML -> TypeScript -> `chant build`
 * -> YAML must give back the same file (key order and quoting aside), the
 * generated source must lint clean, and `promtool check config` must accept
 * both the fixture and what comes back, when `promtool` is on PATH (or
 * `PROMTOOL` names it).
 */

import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { load } from "js-yaml";
import { build } from "@intentius/chant/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { prometheusSerializer, PROMETHEUS_FILE } from "../serializer";
import { hasTool, promtoolCheckConfig } from "../tools";
import { PrometheusParser } from "./parser";
import { PrometheusGenerator } from "./generator";
import { pkgDir, read } from "./testdata/fixtures";
import type { SerializerResult } from "@intentius/chant/serializer";

const PROMTOOL = hasTool(process.env.PROMTOOL ?? "promtool");

/** The `prometheus.yml` of one build output: the primary output, or the file beside a rule file. */
function prometheusYml(out: string | SerializerResult | undefined): string {
  if (out === undefined || typeof out === "string") return out ?? "";
  return out.files?.[PROMETHEUS_FILE] ?? out.primary;
}

function projectDir(): string {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["prometheus"] };\n');
  writeFileSync(join(dir, "package.json"), '{ "name": "prometheus-config-roundtrip", "private": true, "type": "module" }\n');
  return dir;
}

async function importAndBuild(yaml: string) {
  const dir = projectDir();
  try {
    const srcDir = join(dir, "src");
    const ir = new PrometheusParser().parse(yaml);
    const files: string[] = [];
    const sources: string[] = [];
    for (const file of new PrometheusGenerator().generate(ir)) {
      writeFileSync(join(srcDir, file.path), file.content);
      files.push(file.path);
      sources.push(`// ${file.path}\n${file.content}`);
    }
    const result = await build(srcDir, [prometheusSerializer]);
    const lint = await lintCommand({ path: srcDir, format: "stylish" });
    return {
      files,
      source: sources.join("\n"),
      warnings: ir.warnings ?? [],
      yaml: prometheusYml(result.outputs.get("prometheus")),
      buildErrors: result.errors,
      lint: { errorCount: lint.errorCount, warningCount: lint.warningCount, output: lint.output },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Doc = Record<string, unknown> & { scrape_configs?: Array<{ job_name: string }> };

/** A parsed prometheus.yml with the scrape jobs sorted by name, the one order the serializer changes. */
function normalize(yaml: string): Doc {
  const doc = (load(yaml) ?? {}) as Doc;
  if (doc.scrape_configs) doc.scrape_configs = [...doc.scrape_configs].sort((a, b) => a.job_name.localeCompare(b.job_name));
  return doc;
}

/** Files the fixture's rule_files glob and promtool's checks read. */
const COMPANIONS = { "rules/a.yml": "groups:\n  - name: g\n    rules:\n      - record: a:b\n        expr: sum(up)\n" };

describe("prometheus.yml: YAML -> TypeScript -> YAML", () => {
  test("a config using every typed section and discovery kind", async () => {
    const fixture = read("prometheus-full.yml");
    const out = await importAndBuild(fixture);
    expect(out.buildErrors).toEqual([]);
    expect(normalize(out.yaml)).toEqual(normalize(fixture));
    if (out.lint.errorCount + out.lint.warningCount > 0) console.log(out.lint.output);
    expect(out.lint.errorCount).toBe(0);
    expect(out.lint.warningCount).toBe(0);

    expect(out.files).toEqual(["scrape-configs-1.ts", "scrape-configs-2.ts", "prometheus.ts"]);
    expect(out.source).toContain("new ScrapeConfig(");
    expect(out.source).toContain("new PrometheusConfig(");
    expect(out.source).toMatch(/: StaticConfig\[\] = /);
    expect(out.source).toMatch(/: RelabelConfig\[\] = /);
    expect(out.source).toMatch(/: KubernetesSDConfig\[\] = /);
    expect(out.source).toMatch(/: FileSDConfig\[\] = /);
    expect(out.source).toMatch(/: HttpSDConfig\[\] = /);
    expect(out.source).toMatch(/: DnsSDConfig\[\] = /);
    expect(out.source).toMatch(/: Ec2SDConfig\[\] = /);
    expect(out.source).toMatch(/: ConsulSDConfig\[\] = /);
    expect(out.source).toMatch(/: RemoteWriteConfig\[\] = /);
    expect(out.source).toMatch(/: RemoteReadConfig\[\] = /);
    expect(out.source).toMatch(/: PrometheusGlobalConfig = /);
    expect(out.source).toMatch(/: PrometheusAlertingConfig = /);
    expect(out.source).toMatch(/: OtlpConfig = /);

    // The one discovery kind the lexicon does not type is named, and kept.
    expect(out.source).toContain("docker_sd_configs is not a discovery kind the lexicon types");
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("docker_sd_configs");
  });

  test("the config terragucci emits is a fixed point", async () => {
    const yaml = `global:
  scrape_interval: 5s
scrape_configs:
  - job_name: otel-collector
    static_configs:
      - targets:
          - otel-collector:8889
`;
    const out = await importAndBuild(yaml);
    expect(out.buildErrors).toEqual([]);
    expect(out.yaml).toBe(yaml);
    expect(out.warnings).toEqual([]);
    expect(out.lint.errorCount + out.lint.warningCount, out.lint.output).toBe(0);
    expect(out.files).toEqual(["scrape-configs.ts", "prometheus.ts"]);
  });

  test("scrape jobs only: no PrometheusConfig is declared", async () => {
    const out = await importAndBuild("scrape_configs:\n  - job_name: a\n    static_configs:\n      - targets:\n          - a:1\n");
    expect(out.files).toEqual(["scrape-configs.ts"]);
    expect(out.source).not.toContain("PrometheusConfig(");
  });

  test("a rule file is still a rule file", async () => {
    const ir = new PrometheusParser().parse("groups:\n  - name: g\n    rules:\n      - record: a:b\n        expr: sum(up)\n");
    expect(ir.resources[0].type).toBe("Prometheus::RuleFile");
  });
});

describe("promtool check config", () => {
  test.skipIf(!PROMTOOL)("accepts the fixture and the file imported from it", async () => {
    const fixture = read("prometheus-full.yml");
    const before = promtoolCheckConfig(fixture, COMPANIONS);
    expect(before.ok, before.output).toBe(true);
    const out = await importAndBuild(fixture);
    const after = promtoolCheckConfig(out.yaml, COMPANIONS);
    expect(after.ok, after.output).toBe(true);
  }, 60_000);
});
