/**
 * The generated source type-checks against the lexicon's types. Compiling
 * the corpus takes longer than the unit-test budget allows, so this runs
 * with the e2e tests.
 *
 * Grafana's UI exports and what the examples build type-check clean. A
 * community dashboard can carry keys the pinned schemas do not list (query
 * fields from older Grafana versions such as `step` and `metric`, panel
 * options added after the pin): it still imports and builds back to the
 * same JSON, GRAF107 warns about each key, and tsc points at the const or
 * constructor that holds it. Those are pinned here, per fixture, so a
 * change to the generator or the types that adds or removes one is seen.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { GrafanaParser } from "./parser";
import { GrafanaGenerator } from "./generator";
import { COMMUNITY, UI_EXPORTS, V2_EXPORTS, exampleOutputs, pkgDir, read, removeDir, repoRoot, writeFiles } from "./testdata/fixtures";

type Files = Array<{ path: string; content: string }>;

/** Type errors in generated projects, compiled together against the lexicon's source with the repo's compiler options. */
function typeErrors(projects: Record<string, Files>): string[] {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  try {
    const files: string[] = [];
    for (const [name, generated] of Object.entries(projects)) {
      const sub = join(dir, name.replace(/[^A-Za-z0-9]+/g, "-"));
      mkdirSync(sub);
      files.push(...writeFiles(sub, generated));
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
      return `${at}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
  } finally {
    removeDir(dir);
  }
}

const generate = (content: string): Files => new GrafanaGenerator().generate(new GrafanaParser().parse(content));

/**
 * Error counts by the property tsc names, for a compact pin of what a
 * fixture carries outside the types. tsc names only the first unknown key
 * of an object literal, so a count is a lower bound (GRAF107 lists them all).
 */
function byProperty(errors: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of errors) {
    const m = /'([^']+)' does not exist in type/.exec(e);
    const key = m ? m[1] : e.replace(/^[^:]+: /, "");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

describe("the generated source type-checks against the lexicon's types", () => {
  test("Grafana's UI exports, the v2 dashboards and the examples' dashboards type-check clean", async () => {
    const projects: Record<string, Files> = Object.fromEntries([...UI_EXPORTS, ...V2_EXPORTS].map((f) => [f, generate(read(f))]));
    for (const [name, text] of await exampleOutputs()) {
      if (/^[^/]+\/dashboards\/.*\.json$/.test(name)) projects[name] = generate(text);
    }
    expect(typeErrors(projects)).toEqual([]);
  }, 180_000);

  test("community dashboards: what they carry outside the pinned types is where tsc points", () => {
    const found: Record<string, Record<string, number>> = {};
    for (const file of COMMUNITY) found[file] = byProperty(typeErrors({ [file]: generate(read(file)) }));
    expect(found).toEqual({
      "community/node-exporter-full.json": { step: 273, metric: 1 },
      "community/k8s-views-global.json": {},
      "community/k8s-views-pods.json": { footer: 3 },
      "community/traefik.json": {},
      "community/redis.json": { metric: 11, step: 6, time_options: 1, unitScale: 13 },
      "community/prometheus-2-stats.json": { metric: 3, now: 1, step: 18 },
      "community/prometheus-2-stats.grafana-12.4.11.json": { metric: 3, step: 18 },
    });
  }, 300_000);
});
