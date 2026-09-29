/**
 * The import corpus, shared by the round-trip tests (roundtrip.test.ts) and
 * the type-check of the generated source (generated-types.e2e.test.ts).
 *
 * - Grafana's own UI exports of two seed dashboards, from 12.4.11 and
 *   13.2.2, plain and "for sharing externally" (test/fixtures/exports/,
 *   provenance in its README).
 * - Community dashboards from grafana.com (test/fixtures/community/,
 *   provenance and licenses in its README).
 * - Alerting provisioning files (test/fixtures/alerting/).
 * - What this lexicon's examples build.
 * - Datasource provisioning files (test/fixtures/provisioning/).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { build } from "@intentius/chant/build";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import { otelSerializer } from "@intentius/chant-lexicon-otel/serializer";
import { prometheusSerializer } from "@intentius/chant-lexicon-prometheus/serializer";
import { grafanaSerializer } from "../../serializer";

export const pkgDir = resolve(import.meta.dirname, "../../..");
export const repoRoot = resolve(pkgDir, "../..");
export const fixturesDir = join(pkgDir, "test", "fixtures");

/** A fixture file's text, by path under test/fixtures. */
export const read = (...p: string[]): string => readFileSync(join(fixturesDir, ...p), "utf-8");

/** The classic UI exports (every export but the v1 and v2 resources), as paths under test/fixtures. */
export const UI_EXPORTS: readonly string[] = ["grafana-12.4.11", "grafana-13.2.2"].flatMap((v) =>
  readdirSync(join(fixturesDir, "exports", v))
    .filter((f) => f.endsWith(".json") && !f.includes("-resource"))
    .sort()
    .map((f) => `exports/${v}/${f}`),
);

/** v2 dashboards (#2947): the checkout V2 Resource UI export, and the tabs dashboard as the v2 API reads it. */
export const V2_EXPORTS: readonly string[] = ["exports/grafana-13.2.2/checkout.v2-resource.json", "exports/grafana-13.2.2/tabs.v2-resource.json"];

/** The tabs dashboard read at dashboard.grafana.app/v1: Grafana's lossy down-conversion of a dashboard it stores as v2. */
export const LOSSY_V1_EXPORT = "exports/grafana-13.2.2/tabs.v1-resource.json";

/** The grafana.com dashboards, as paths under test/fixtures. */
export const COMMUNITY: readonly string[] = [
  "community/node-exporter-full.json",
  "community/k8s-views-global.json",
  "community/k8s-views-pods.json",
  "community/traefik.json",
  "community/redis.json",
  "community/prometheus-2-stats.json",
  "community/prometheus-2-stats.grafana-12.4.11.json",
];

/**
 * Datasource provisioning files (test/fixtures/provisioning/, provenance in
 * its README): one written for chant with every plugin whose settings are
 * typed, and grafana/docker-otel-lgtm's.
 */
export const PROVISIONING: readonly string[] = ["provisioning/typed-plugins.datasources.yaml", "provisioning/docker-otel-lgtm.datasources.yaml"];

/**
 * The alerting provisioning corpus (test/fixtures/alerting/, provenance and
 * licenses in its README): Grafana 12.4.11 and 13.2.2 exports, and files
 * from projects that provision Grafana alerting from files.
 */
export const ALERTING: readonly string[] = ["grafana-12.4.11", "grafana-13.2.2", "community"].flatMap((d) =>
  readdirSync(join(fixturesDir, "alerting", d))
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `alerting/${d}/${f}`),
);

/** The example build roots and the serializers each needs. */
const EXAMPLES: ReadonlyArray<{ name: string; serializers: Serializer[] }> = [
  { name: "getting-started", serializers: [grafanaSerializer] },
  { name: "dashboards-from-declarations", serializers: [otelSerializer, prometheusSerializer, grafanaSerializer] },
  { name: "alerting", serializers: [prometheusSerializer, grafanaSerializer] },
];

/** Every file each example builds, keyed `<example>/<path>`. */
export async function exampleOutputs(): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const { name, serializers } of EXAMPLES) {
    const srcDir = join(pkgDir, "examples", name, "src");
    if (!statSync(srcDir).isDirectory()) continue;
    const result = await build(srcDir, serializers);
    if (result.errors.length > 0) throw new Error(`${name}: ${result.errors.map(String).join("; ")}`);
    const files = (result.outputs.get("grafana") as SerializerResult).files ?? {};
    for (const [path, text] of Object.entries(files)) out.push([`${name}/${path}`, text]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** A chant project directory inside the package, so the lexicon resolves as it does for a user. */
export function projectDir(): string {
  const dir = mkdtempSync(join(pkgDir, ".roundtrip-tmp-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["grafana"] };\n');
  writeFileSync(join(dir, "package.json"), '{ "name": "grafana-import-roundtrip", "private": true, "type": "module" }\n');
  return dir;
}

/** Write generated files under `dir`, creating their directories. */
export function writeFiles(dir: string, files: ReadonlyArray<{ path: string; content: string }>): string[] {
  const written: string[] = [];
  for (const f of files) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
    written.push(path);
  }
  return written;
}

/** Remove a directory made by `projectDir`. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Every `.ts` file under a directory, recursively. */
export function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
