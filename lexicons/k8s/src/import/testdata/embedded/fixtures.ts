/**
 * Shared by the embedded-content round trip (embedded-roundtrip.test.ts) and
 * the type check of what it generates (embedded-types.e2e.test.ts): run
 * `chant import` over a manifest file the way a user does, through
 * `importCommand`, in a project inside this package so the lexicons resolve
 * as they would for them.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join, relative, resolve } from "path";
import { importCommand, type ImportResult } from "@intentius/chant/cli/commands/import";
import { parsePrometheusYaml } from "@intentius/chant-lexicon-prometheus/import/parser";

export const pkgDir = resolve(import.meta.dirname, "../../../..");
export const repoRoot = resolve(pkgDir, "../..");
export const read = (name: string) => readFileSync(join(import.meta.dirname, name), "utf-8");

export interface Imported {
  result: ImportResult;
  /** The project directory; the generated source is in `src/`. The caller removes it. */
  dir: string;
  srcDir: string;
  /** Every generated file by its path under `src/`. */
  files: Record<string, string>;
}

function walk(dir: string, root: string, out: Record<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out[relative(root, path)] = readFileSync(path, "utf-8");
  }
}

/**
 * `chant import manifest.yaml --lexicon k8s` into a fresh project, or with
 * `detect`, `chant import manifest.yaml` with the lexicon detected.
 */
export async function importManifest(yaml: string, options: { detect?: boolean } = {}): Promise<Imported> {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  writeFileSync(join(dir, "package.json"), '{ "name": "k8s-embedded-roundtrip", "private": true, "type": "module" }\n');
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["k8s"] };\n');
  const srcDir = join(dir, "src");
  mkdirSync(srcDir);
  const templatePath = join(dir, "manifest.yaml");
  writeFileSync(templatePath, yaml);
  const result = await importCommand({ templatePath, output: srcDir, ...(options.detect ? {} : { lexicon: "k8s" }) });
  const files: Record<string, string> = {};
  walk(srcDir, srcDir, files);
  return { result, dir, srcDir, files };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * An alertmanager.yml as the prometheus importer reads it, receivers and
 * time intervals sorted by name (the serializer sorts them): what an
 * imported ConfigMap's `alertmanager.yml` must give back (#3031).
 */
export function alertmanagerConfig(text: string): Record<string, unknown> {
  const parsed = parsePrometheusYaml(text);
  if (parsed.kind !== "alertmanager") throw new Error("not an alertmanager.yml");
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const { receivers, time_intervals, ...rest } = parsed.config;
  return {
    ...rest,
    ...(receivers ? { receivers: [...receivers].sort(byName) } : {}),
    ...(time_intervals ? { time_intervals: [...time_intervals].sort(byName) } : {}),
  };
}
