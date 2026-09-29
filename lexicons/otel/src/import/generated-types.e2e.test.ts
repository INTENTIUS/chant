/**
 * The generated source type-checks against the lexicon's config types.
 * Compiling a dozen generated projects takes longer than the unit-test
 * budget allows, so this runs with the e2e tests.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { collectorYaml } from "../collector";
import { genAiPipeline } from "../genai";
import { OtelCollectorParser } from "./parser";
import { OtelCollectorGenerator } from "./generator";
import { everyBuiltin, exampleOutputs, pkgDir, read, repoRoot } from "./testdata/fixtures";

/** Type errors in generated projects, compiled together against the lexicon's source with the repo's compiler options. */
function typeErrors(projects: Record<string, Array<{ path: string; content: string }>>): string[] {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  try {
    const files: string[] = [];
    for (const [name, generated] of Object.entries(projects)) {
      const sub = join(dir, name.replace(/[^A-Za-z0-9]+/g, "-"));
      mkdirSync(sub);
      for (const f of generated) {
        writeFileSync(join(sub, f.path), f.content);
        files.push(join(sub, f.path));
      }
    }
    const configFile = ts.readConfigFile(join(repoRoot, "tsconfig.json"), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
    const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
    const real = (f: string) => ts.sys.realpath?.(f) ?? f;
    const fileSet = new Set(files.map(real));
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file && fileSet.has(real(d.file.fileName)));
    // A program that saw none of the files would pass vacuously.
    expect(files.every((f) => program.getSourceFile(f) !== undefined)).toBe(true);
    return diagnostics.map((d) => {
      const at = real(d.file!.fileName).slice(real(dir).length + 1);
      return `${at}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const generate = (yaml: string) => new OtelCollectorGenerator().generate(new OtelCollectorParser().parse(yaml));

/** Every vendored import fixture, by path under testdata/: the chant-built configs and the collector-contrib ones. */
function vendoredFixtures(): string[] {
  const dir = join(import.meta.dirname, "testdata");
  const yamlIn = (sub: string) =>
    readdirSync(join(dir, sub))
      .filter((f) => f.endsWith(".yaml"))
      .sort()
      .map((f) => (sub ? `${sub}/${f}` : f));
  return [...yamlIn(""), ...yamlIn("upstream")];
}

describe("the generated source type-checks against the lexicon's config types", () => {
  test("for every vendored fixture, every example's output, genAiPipeline() and every built-in's typed fields", async () => {
    const fixtures = vendoredFixtures();
    // The corpus the round-trip tests read; a missing directory would pass vacuously.
    expect(fixtures).toEqual(expect.arrayContaining(["gateway.yaml", "upstream/couchbase.yaml", "upstream/servicegraph-nop.yaml"]));
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    const projects: Record<string, Array<{ path: string; content: string }>> = {
      ...Object.fromEntries(fixtures.map((f) => [f, generate(read(...f.split("/")))])),
      genai: generate(collectorYaml(genAiPipeline())),
      everyBuiltin: generate(collectorYaml(everyBuiltin())),
      ...Object.fromEntries((await exampleOutputs()).map(([n, y]) => [`example-${n}`, generate(y)])),
    };
    expect(typeErrors(projects)).toEqual([]);
  }, 120_000);

  test("a value outside a built-in's typed config is carried as found, and tsc points at it", () => {
    // The type check is not vacuous: a batch timeout of `true` is neither a duration string nor
    // nanoseconds, and a scrape job stays closed to keys Prometheus does not read.
    const yaml = [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      grpc: {}",
      "  prometheus:",
      "    config:",
      "      scrape_configs:",
      "        - job_name: self",
      "          static_configs: [{ targets: [\"localhost:8888\"] }]",
      "          basic_auth: { username: u, password_file: /etc/p }",
      "          scrape_everything: true",
      "processors:",
      "  batch:",
      "    timeout: true",
      "exporters:",
      "  debug: {}",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      processors: [batch]",
      "      exporters: [debug]",
      "    metrics:",
      "      receivers: [prometheus]",
      "      exporters: [debug]",
      "",
    ].join("\n");
    expect(typeErrors({ bad: generate(yaml) })).toEqual([
      expect.stringMatching(/^bad\/processors\.ts: Type 'true' is not assignable to type 'Duration/),
      expect.stringMatching(/^bad\/receivers\.ts: .*'scrape_everything' does not exist in type 'PrometheusScrapeConfig'/),
    ]);
  }, 120_000);
});
