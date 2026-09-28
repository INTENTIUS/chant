/**
 * The generated source type-checks against the lexicon's config types.
 * Compiling a dozen generated projects takes longer than the unit-test
 * budget allows, so this runs with the e2e tests.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { collectorYaml } from "../collector";
import { genAiPipeline } from "../genai";
import { OtelCollectorParser } from "./parser";
import { OtelCollectorGenerator } from "./generator";
import { everyBuiltin, exampleOutputs, pkgDir, read, repoRoot, UPSTREAM_BUILTIN_ONLY } from "./testdata/fixtures";

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

describe("the generated source type-checks against the lexicon's config types", () => {
  test("for every fixture whose config stays within the typed fields", async () => {
    const projects: Record<string, Array<{ path: string; content: string }>> = {
      gateway: generate(read("gateway.yaml")),
      agent: generate(read("agent-observability-agent.yaml")),
      agentGateway: generate(read("agent-observability-gateway.yaml")),
      genai: generate(collectorYaml(genAiPipeline())),
      everyBuiltin: generate(collectorYaml(everyBuiltin())),
      faultTolerant: generate(read("upstream", "fault-tolerant-logs.yaml")),
      ...Object.fromEntries(UPSTREAM_BUILTIN_ONLY.map((f) => [f, generate(read("upstream", f))])),
      ...Object.fromEntries((await exampleOutputs()).map(([n, y]) => [n, generate(y)])),
    };
    expect(typeErrors(projects)).toEqual([]);
  }, 120_000);

  test("a value outside a built-in's typed config is carried as found, and tsc points at it", () => {
    // couchbase uses the filter processor's legacy match syntax and a scrape job's basic_auth,
    // neither of which the lexicon's config types cover.
    const couchbase = typeErrors({ couchbase: generate(read("upstream", "couchbase.yaml")) });
    expect(couchbase).toEqual([
      expect.stringMatching(/^couchbase\/processors\.ts: .*'exclude' does not exist/),
      expect.stringMatching(/^couchbase\/receivers\.ts: .*'basic_auth' does not exist in type 'PrometheusScrapeConfig'/),
    ]);
    // The servicegraph test config writes bucket durations as bare integers (nanoseconds); Duration is a string.
    const servicegraph = typeErrors({ servicegraph: generate(read("upstream", "servicegraph-nop.yaml")) });
    expect(servicegraph).toEqual(Array(5).fill("servicegraph/connectors.ts: Type 'number' is not assignable to type 'string'."));
  }, 120_000);
});
