/**
 * Typed Helm values: the helm lexicon's `projectCodegen` hook (`chant
 * generate`, core's project-codegen.ts).
 *
 * For each chart a project lists under `helm.charts`, generation reads the
 * chart's `values.schema.json` (or, without one, its `values.yaml`) and writes
 * to `<outDir>/helm/index.ts`:
 *
 * - `<Name>Values`, the values type: from the schema, with every member
 *   optional (the schema validates the values Helm merges with the chart's
 *   defaults, so a key it requires is usually already set), or inferred from
 *   `values.yaml` (./codegen/values-type.ts).
 * - `<Name>Render(props)`, a factory that calls `HelmRender` with the repo,
 *   chart and version from the config, so the type and the version it was
 *   generated from cannot drift apart. It takes `HelmRender`'s other props.
 *
 * A remote chart is downloaded without the helm binary: an `oci://` chart
 * through the registry API, a classic repository through its `index.yaml`.
 * Both go through `ctx.fetch` when the caller passes one.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import yaml from "js-yaml";
import { GENERATED_TS_HEADER, type ProjectCodegen, type ProjectCodegenContext } from "@intentius/chant/project-codegen";
import { jsdocLines, schemaToTypeScript } from "@intentius/chant/codegen/json-schema-to-ts";
import { fetchWithRetry } from "@intentius/chant/codegen/fetch";
import { pullOciChart, readTarGz } from "@intentius/chant-lexicon-k8s/crd/oci-chart";
import { CHART_KEY_PATTERN, type HelmProjectChart } from "./config";
import { inferValuesType } from "./codegen/values-type";

/** The chart files generation reads. */
export interface ChartFiles {
  chartYaml: string;
  valuesYaml?: string;
  valuesSchema?: string;
}

type RemoteChart = Extract<HelmProjectChart, { chart: string }>;

/** Download a remote chart's files. Tests replace it. */
export type ChartPuller = (chart: RemoteChart, fetchImpl: typeof fetch | undefined) => Promise<ChartFiles>;

const CHART_FILES = ["Chart.yaml", "values.yaml", "values.schema.json"] as const;

/** The hook, with an injectable puller for remote charts. */
export function helmProjectCodegen(options: { pull?: ChartPuller } = {}): ProjectCodegen {
  const pull = options.pull ?? pullRemoteChart;
  return {
    inputs(ctx) {
      const charts = declaredCharts(ctx);
      if (!charts) return undefined;
      return Object.fromEntries(charts.map(([key, chart]) => [key, describeChart(key, chart, ctx.projectRoot)]));
    },

    async generate(ctx) {
      const charts = declaredCharts(ctx) ?? [];
      const blocks: string[] = [];
      const summary: string[] = [];
      for (const [key, chart] of charts) {
        describeChart(key, chart, ctx.projectRoot); // validates before any download
        const files = "path" in chart ? readLocalChart(resolve(ctx.projectRoot, chart.path)) : await pull(chart, ctx.fetch);
        const generated = renderChart(key, chart, files, ctx);
        blocks.push(generated.code);
        summary.push(generated.summary);
      }
      const local = charts.some(([, chart]) => "path" in chart);
      return { files: { "index.ts": renderModule(blocks, local) }, summary };
    },
  };
}

function declaredCharts(ctx: ProjectCodegenContext): Array<[string, HelmProjectChart]> | undefined {
  const charts = (ctx.config.helm as { charts?: Record<string, HelmProjectChart> } | undefined)?.charts;
  if (!charts || Object.keys(charts).length === 0) return undefined;
  return Object.entries(charts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A chart as a JSON value for the drift digest: a local chart by the hashes
 * of the files generation reads, a remote one by its pin.
 */
function describeChart(key: string, chart: HelmProjectChart, projectRoot: string): Record<string, unknown> {
  if (!CHART_KEY_PATTERN.test(key)) {
    throw new Error(`helm.charts.${key}: the key names the generated factory, so it must start with a letter and hold only letters, digits, - and _`);
  }
  if ("path" in chart) {
    const dir = resolve(projectRoot, chart.path);
    if (!existsSync(join(dir, "Chart.yaml"))) throw new Error(`helm.charts.${key}: no Chart.yaml in ${chart.path}`);
    const hashes: Record<string, string> = {};
    for (const file of CHART_FILES) {
      const path = join(dir, file);
      if (existsSync(path)) hashes[file] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
    return { path: chart.path, files: hashes };
  }
  if (!chart.version) {
    throw new Error(`helm.charts.${key}: ${chart.chart} needs a version. An unpinned chart makes the generated types depend on when they were generated.`);
  }
  if (!chart.repo && !chart.chart.startsWith("oci://")) {
    throw new Error(`helm.charts.${key}: ${chart.chart} needs a repo, or must be an oci:// reference`);
  }
  return {
    ...(chart.repo ? { repo: chart.repo } : {}),
    chart: chart.chart,
    version: chart.version,
    ...(chart.digest ? { digest: chart.digest } : {}),
  };
}

function readLocalChart(dir: string): ChartFiles {
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
  return { chartYaml: read("Chart.yaml")!, valuesYaml: read("values.yaml"), valuesSchema: read("values.schema.json") };
}

/** The top-level chart's files out of a chart archive (subcharts are ignored). */
export function chartFilesFromArchive(files: Map<string, Buffer>, label: string): ChartFiles {
  const chartYamlPath = [...files.keys()].find((p) => p.split("/").length === 2 && p.endsWith("/Chart.yaml"));
  if (!chartYamlPath) throw new Error(`${label}: the archive has no top-level Chart.yaml`);
  const dir = chartYamlPath.split("/")[0];
  const read = (f: string) => files.get(`${dir}/${f}`)?.toString("utf8");
  return { chartYaml: read("Chart.yaml")!, valuesYaml: read("values.yaml"), valuesSchema: read("values.schema.json") };
}

/** Download a remote chart: OCI through the registry API, a classic repository through its index. */
export async function pullRemoteChart(chart: RemoteChart, fetchImpl: typeof fetch | undefined): Promise<ChartFiles> {
  const label = `${chart.repo ? `${chart.repo} ` : ""}${chart.chart} ${chart.version}`;
  if (!chart.repo) {
    const http = fetchImpl ? { probe: fetchImpl, get: fetchImpl } : undefined;
    const tgz = await pullOciChart(chart.chart, chart.version, chart.digest, http);
    return chartFilesFromArchive(readTarGz(tgz), label);
  }

  const get = async (url: string): Promise<Response> => {
    const response = fetchImpl ? await fetchImpl(url) : await fetchWithRetry(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
  };
  const base = chart.repo.endsWith("/") ? chart.repo : `${chart.repo}/`;
  // Failsafe: every scalar stays a string, so a digest of all digits or a
  // version like 1.10 is read as written.
  const index = yaml.load(await (await get(new URL("index.yaml", base).href)).text(), { schema: yaml.FAILSAFE_SCHEMA }) as {
    entries?: Record<string, Array<{ version?: string; urls?: string[]; digest?: string }>>;
  };
  const entry = index?.entries?.[chart.chart]?.find((e) => e.version === chart.version);
  if (!entry?.urls?.length) throw new Error(`${label}: not in the repository's index.yaml`);
  const tgz = Buffer.from(await (await get(new URL(entry.urls[0], base).href)).arrayBuffer());
  const digest = createHash("sha256").update(tgz).digest("hex");
  if (entry.digest && entry.digest !== digest) {
    throw new Error(`${label}: the archive's sha256 is ${digest}, but the repository index says ${entry.digest}`);
  }
  if (chart.digest && chart.digest.replace(/^sha256:/, "") !== digest) {
    throw new Error(`${label}: the archive's sha256 is ${digest}, but the config pins ${chart.digest}`);
  }
  return chartFilesFromArchive(readTarGz(tgz), label);
}

/** `ingress-nginx` -> `IngressNginx`. */
export function factoryBase(key: string): string {
  return key
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function renderChart(
  key: string,
  chart: HelmProjectChart,
  files: ChartFiles,
  ctx: ProjectCodegenContext,
): { code: string; summary: string } {
  const meta = (yaml.load(files.chartYaml) ?? {}) as { name?: string; version?: string };
  const base = factoryBase(key);
  const valuesName = `${base}Values`;
  const fnName = `${base}Render`;

  const local = "path" in chart;
  const chartName = local ? chart.path : chart.chart;
  // A local chart is located from the generated module, so the render finds
  // it whatever directory the build runs in.
  const chartExpr = local
    ? `chartPath(${JSON.stringify(relative(ctx.outDir, resolve(ctx.projectRoot, chart.path)).split(sep).join("/"))})`
    : JSON.stringify(chart.chart);
  const version = local ? meta.version : chart.version;
  if (!version) throw new Error(`helm.charts.${key}: ${chartName} has no version in Chart.yaml`);
  const repo = local ? "" : (chart.repo ?? "");
  const from = local ? `the chart at ${chartName}` : `${chart.chart} ${version}${chart.repo ? ` from ${chart.repo}` : ""}`;

  const lines: string[] = [];
  let source: string;
  if (files.valuesSchema) {
    let schema: unknown;
    try {
      schema = JSON.parse(files.valuesSchema);
    } catch (err) {
      throw new Error(`helm.charts.${key}: values.schema.json does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { type, declarations } = schemaToTypeScript(schema, { allOptional: true, namePrefix: valuesName, rootName: valuesName });
    for (const d of declarations) lines.push(...jsdocLines(d.description, ""), `export type ${d.name} = ${d.type};`, "");
    lines.push(`/** Values for ${from}, from its values.schema.json. */`, `export type ${valuesName} = ${type};`);
    source = "values.schema.json";
  } else {
    let values: unknown;
    try {
      values = files.valuesYaml ? yaml.load(files.valuesYaml) : undefined;
    } catch (err) {
      throw new Error(`helm.charts.${key}: values.yaml does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
    lines.push(`/** Values for ${from}, inferred from its values.yaml defaults. */`, `export type ${valuesName} = ${inferValuesType(values)};`);
    source = files.valuesYaml ? "values.yaml" : "no values file";
  }

  lines.push(
    "",
    `/** \`${fnName}\`'s props: \`HelmRender\`'s, with the chart fixed by chant.config and \`values\` typed. */`,
    `export type ${fnName}Props = Omit<HelmRenderProps, "repo" | "chart" | "version" | "values"> & { values?: ${valuesName} };`,
    "",
    `/** Render ${from}. */`,
    `export function ${fnName}(props: ${fnName}Props) {`,
    "  return HelmRender({",
    "    ...props,",
    `    repo: ${JSON.stringify(repo)},`,
    `    chart: ${chartExpr},`,
    `    version: ${JSON.stringify(version)},`,
    "    values: props.values as Record<string, unknown> | undefined,",
    "  });",
    "}",
  );
  return { code: lines.join("\n"), summary: `${fnName} (${meta.name ?? chartName} ${version}, values from ${source})` };
}

function renderModule(blocks: string[], local: boolean): string {
  return [
    GENERATED_TS_HEADER,
    "// Typed render factories for the charts helm.charts declares in chant.config.",
    ...(local ? ['import { relative } from "node:path";', 'import { fileURLToPath } from "node:url";'] : []),
    'import { HelmRender, type HelmRenderProps } from "@intentius/chant-lexicon-helm";',
    ...(local
      ? [
          "",
          "/** A chart directory given relative to this module, as a path from the working directory. */",
          "function chartPath(fromHere: string): string {",
          '  return relative(process.cwd(), fileURLToPath(new URL(fromHere, import.meta.url))) || ".";',
          "}",
        ]
      : []),
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}
