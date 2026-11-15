/**
 * Helm charts and values files, read from manifests as data (#5100).
 *
 * Four places name a chart: a kustomization's `helmCharts`, an Argo CD
 * Application or ApplicationSet source, a Flux `HelmRelease`, and a Terraform
 * `helm_release`. Nothing here fetches a chart, renders one or runs a binary;
 * it reads what the files say.
 *
 * ## What the reader leaves on a node
 *
 * {@link stampHelmReferences} puts a `helmReferences` key on the object that
 * names a chart: the chart references it names ({@link HelmChartRef}), and the
 * workspace-relative path of every values file it names. A kustomization with
 * `helmCharts` is itself a node ({@link kustomizationDocument}), since the
 * file is no manifest and no rendered object stands for it. The values files
 * that exist and parse become `Helm::Values` nodes ({@link helmValuesEntity}),
 * and a values file's `extraObjects` become manifest nodes of the same member,
 * so the objects a chart is told to create are in the graph with the rest.
 *
 * The edges are the catalog's. A holder's `helmReferences.valuesFiles[]`
 * names a `Helm::Values` node by its `path` (rules in ./reference-catalog.ts),
 * so a file that does not exist is a dangling reference with its path. The
 * chart nodes are shared by every member that names the chart, and are made
 * by the helm lexicon's catalog from the stamps (`sharedNodes`,
 * `@intentius/chant-lexicon-helm`), which can see every member at once.
 *
 * ## How a path resolves
 *
 * - A kustomization's `valuesFile` and `additionalValuesFiles` are relative to
 *   the kustomization's directory.
 * - An Argo `$<ref>/path` in `helm.valueFiles` names a file in the repository
 *   of the source whose `ref` is `<ref>`. The checkout is one repository, so
 *   the path is read from the workspace root, whatever that source's
 *   `repoURL` says. If the repository is another one, the file is not there
 *   and the reference is dangling, with the path as written.
 * - A relative `valueFiles` entry of a source with a git `path` is relative to
 *   that path, read from the workspace root. On a source with a `chart` it is
 *   inside the chart's package, which is not in the checkout, and is not read.
 * - A path with template syntax (`{{ ... }}`) is not read: an ApplicationSet's
 *   templated paths are expanded by the generator issue, not here.
 * - A path that leaves the workspace is not read, and is dangling.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadAll } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import type { RenderedManifestEntity } from "./manifest-entity";
import { addRenderedEntity, renderedManifestEntity } from "./kustomize/rendered-entity";

/** The key the stamp is written under on the object that names a chart. */
export const HELM_REFERENCES_KEY = "helmReferences";

/** Annotation on an object read out of a values file's `extraObjects`, valued with the file's workspace-relative path. */
export const HELM_VALUES_ANNOTATION = "chant.intentius.io/helm-values";

/** Node kind of a values file. The helm lexicon's `Helm::Values` type. */
export const HELM_VALUES_KIND = "Helm::Values";

/** One chart a repository serves at one version: what a chart node stands for. */
export interface HelmChartRef {
  /** The chart repository URL without a trailing slash, or `flux:<namespace>/<name>` for a Flux `sourceRef` the catalog resolves to the repository's URL. */
  repo: string;
  chart: string;
  /** As written; empty when the reference names no version. */
  version: string;
}

/** What the reader leaves on an object that names a chart. */
export interface HelmReferences {
  charts: Array<HelmChartRef & { valuesFiles?: string[] }>;
  /** Workspace-relative, `/` separated: every values file the object names, resolved. */
  valuesFiles: string[];
}

type Doc = Record<string, unknown>;

const isMap = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const templated = (s: string): boolean => s.includes("{{");

/** A repository URL as chart references compare it: no trailing slash. */
export function normalizeChartRepo(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** `<repo without scheme>/<chart>@<version>`: the id suffix of a chart node, and what two references share when they name the same chart. */
export function helmChartKey(ref: HelmChartRef): string {
  return `${ref.repo.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")}/${ref.chart}@${ref.version}`;
}

/** The values file a reference names, as the workspace names it, or undefined when it is not read (templated, outside the workspace). */
function workspacePath(workspace: string, abs: string): string | undefined {
  const rel = relative(workspace, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** What the references of one object come to: charts with their files, files not tied to a chart, and paths that cannot be read. */
interface Found {
  charts: Array<HelmChartRef & { valuesFiles: string[] }>;
  /** Files named with no chart (a git `path` source). */
  loose: string[];
  /** Paths named that lie outside the workspace; they stay in the stamp as written so the reference is dangling. */
  outside: string[];
}

export interface HelmReadContext {
  /** The workspace root, absolute. */
  workspace: string;
  /** The member's directory, absolute. */
  dir: string;
}

function chartOrNone(repo: unknown, chart: unknown, version: unknown): HelmChartRef | undefined {
  const r = str(repo);
  const c = str(chart);
  if (!r || !c || templated(r) || templated(c)) return undefined;
  const v = typeof version === "string" ? version : typeof version === "number" ? String(version) : "";
  return { repo: normalizeChartRepo(r), chart: c, version: templated(v) ? "" : v };
}

/** The sources of an Argo CD Application, or of an ApplicationSet's template. */
function argoSources(doc: Doc): Doc[] {
  const spec = isMap(doc.spec) ? doc.spec : {};
  const holder = doc.kind === "ApplicationSet" ? (isMap(spec.template) && isMap(spec.template.spec) ? spec.template.spec : {}) : spec;
  const list = Array.isArray(holder.sources) ? holder.sources : holder.source !== undefined ? [holder.source] : [];
  return list.filter(isMap);
}

function argoFound(doc: Doc, ctx: HelmReadContext): Found {
  const found: Found = { charts: [], loose: [], outside: [] };
  const sources = argoSources(doc);
  const refs = new Set(sources.map((s) => str(s.ref)).filter((r): r is string => r !== undefined));
  for (const source of sources) {
    const ref = chartOrNone(source.repoURL, source.chart, source.targetRevision);
    const helm = isMap(source.helm) ? source.helm : {};
    const files: string[] = [];
    for (const entry of Array.isArray(helm.valueFiles) ? helm.valueFiles : []) {
      const file = str(entry);
      if (!file || templated(file) || /^[a-z][a-z0-9+.-]*:\/\//i.test(file)) continue;
      let abs: string | undefined;
      if (file.startsWith("$")) {
        const slash = file.indexOf("/");
        if (slash === -1 || !refs.has(file.slice(1, slash))) continue;
        abs = resolve(ctx.workspace, file.slice(slash + 1));
      } else if (str(source.path) && !str(source.chart) && !templated(String(source.path))) {
        abs = resolve(ctx.workspace, String(source.path), file);
      } else {
        continue;
      }
      const rel = workspacePath(ctx.workspace, abs);
      if (rel === undefined) found.outside.push(file);
      else files.push(rel);
    }
    if (ref) found.charts.push({ ...ref, valuesFiles: files });
    else found.loose.push(...files);
  }
  return found;
}

function fluxFound(doc: Doc): Found {
  const found: Found = { charts: [], loose: [], outside: [] };
  const spec = isMap(doc.spec) ? doc.spec : {};
  const chartSpec = isMap(spec.chart) && isMap(spec.chart.spec) ? spec.chart.spec : {};
  const chart = str(chartSpec.chart);
  const source = isMap(chartSpec.sourceRef) ? chartSpec.sourceRef : {};
  const name = str(source.name);
  if (!chart || !name || source.kind !== "HelmRepository" || templated(chart) || templated(name)) return found;
  const metadata = isMap(doc.metadata) ? doc.metadata : {};
  const namespace = str(source.namespace) ?? str(metadata.namespace) ?? "default";
  const version = typeof chartSpec.version === "string" && !templated(chartSpec.version) ? chartSpec.version : "";
  found.charts.push({ repo: `flux:${namespace}/${name}`, chart, version, valuesFiles: [] });
  return found;
}

/** The first kustomization file in `dir`, parsed, or undefined. */
export function readKustomizationFile(dir: string): { file: string; doc: Doc } | undefined {
  for (const name of ["kustomization.yaml", "kustomization.yml", "Kustomization"]) {
    const file = join(dir, name);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    try {
      const doc = loadAll(readFileSync(file, "utf-8"))[0];
      if (isMap(doc)) return { file, doc };
    } catch {
      // A kustomization that does not parse is the render's to report.
    }
  }
  return undefined;
}

/** Whether a kustomization names a chart: a non-empty `helmCharts` with a mapping in it. */
export function hasHelmCharts(doc: Doc): boolean {
  return Array.isArray(doc.helmCharts) && doc.helmCharts.some(isMap);
}

/**
 * The kustomization as a manifest document, for a directory whose
 * kustomization names a chart, or undefined when it names none. The file has
 * no `apiVersion` or `kind` of its own to require, so they are given their
 * kustomize defaults, and the member's label names it.
 */
export function kustomizationDocument(dir: string, label: string): Doc | undefined {
  const read = readKustomizationFile(dir);
  if (!read || !hasHelmCharts(read.doc)) return undefined;
  const { apiVersion, kind, metadata, ...rest } = read.doc;
  return {
    apiVersion: str(apiVersion) ?? "kustomize.config.k8s.io/v1beta1",
    kind: str(kind) ?? "Kustomization",
    metadata: { ...(isMap(metadata) ? metadata : {}), name: label },
    ...rest,
  };
}

function kustomizationFound(doc: Doc, ctx: HelmReadContext): Found {
  const found: Found = { charts: [], loose: [], outside: [] };
  for (const entry of Array.isArray(doc.helmCharts) ? doc.helmCharts : []) {
    if (!isMap(entry)) continue;
    const ref = chartOrNone(entry.repo, entry.name, entry.version);
    const named = [entry.valuesFile, ...(Array.isArray(entry.additionalValuesFiles) ? entry.additionalValuesFiles : [])];
    const files: string[] = [];
    for (const f of named) {
      const file = str(f);
      if (!file || templated(file)) continue;
      const rel = workspacePath(ctx.workspace, resolve(ctx.dir, file));
      if (rel === undefined) found.outside.push(file);
      else files.push(rel);
    }
    if (ref) found.charts.push({ ...ref, valuesFiles: files });
    else found.loose.push(...files);
  }
  return found;
}

/** Whether a document is an object that can name a chart. */
function holderKind(doc: Doc): "argo" | "flux" | "kustomize" | undefined {
  const api = str(doc.apiVersion) ?? "";
  if (api.startsWith("argoproj.io/") && (doc.kind === "Application" || doc.kind === "ApplicationSet")) return "argo";
  if (api.startsWith("helm.toolkit.fluxcd.io/") && doc.kind === "HelmRelease") return "flux";
  if (api.startsWith("kustomize.config.k8s.io/") && doc.kind === "Kustomization") return "kustomize";
  return undefined;
}

/**
 * The document with `helmReferences` on it, when it names a chart or a values
 * file. A document that names neither is returned as it is.
 */
export function stampHelmReferences(doc: Doc, ctx: HelmReadContext): { doc: Doc; references?: HelmReferences } {
  const kind = holderKind(doc);
  if (!kind) return { doc };
  const found = kind === "argo" ? argoFound(doc, ctx) : kind === "flux" ? fluxFound(doc) : kustomizationFound(doc, ctx);
  const valuesFiles = [...new Set([...found.charts.flatMap((c) => c.valuesFiles), ...found.loose])].sort();
  const lone = found.outside;
  if (found.charts.length === 0 && valuesFiles.length === 0 && lone.length === 0) return { doc };
  const references: HelmReferences = {
    charts: found.charts.map((c) => ({ repo: c.repo, chart: c.chart, version: c.version, ...(c.valuesFiles.length > 0 ? { valuesFiles: c.valuesFiles } : {}) })),
    valuesFiles: [...valuesFiles, ...lone],
  };
  return { doc: { ...doc, [HELM_REFERENCES_KEY]: references }, references };
}

/** A values file read as data. */
export interface HelmValuesRead {
  /** Workspace-relative. */
  path: string;
  values: Doc;
}

/**
 * Read a workspace-relative values file as YAML. Returns undefined, with a
 * warning naming the file, when it is not a file, does not parse, or is not a
 * mapping; a file that does not exist is not a warning, the reference to it is
 * the dangling entry.
 */
export function readValuesFile(workspace: string, path: string, warn: (message: string) => void): HelmValuesRead | undefined {
  const abs = resolve(workspace, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
  try {
    const doc = loadAll(readFileSync(abs, "utf-8"))[0];
    if (doc === undefined || doc === null) return { path, values: {} };
    if (!isMap(doc)) {
      warn(`values file ${path} is not a mapping and was skipped`);
      return undefined;
    }
    return { path, values: doc };
  } catch (err) {
    warn(`values file ${path} is not valid YAML and was skipped (${(err instanceof Error ? err.message : String(err)).split("\n")[0]})`);
    return undefined;
  }
}

/**
 * A values file as a node: the helm lexicon's `Helm::Values`, its `path`
 * (workspace-relative, the name catalog rules join on), the charts that name
 * it, and the values, as the file has them.
 */
export function helmValuesEntity(read: HelmValuesRead, charts: HelmChartRef[]): Declarable {
  return {
    lexicon: "helm",
    entityType: HELM_VALUES_KIND,
    kind: "resource",
    props: { path: read.path, ...(charts.length > 0 ? { charts } : {}), values: read.values },
    [DECLARABLE_MARKER]: true,
  } as Declarable;
}

/**
 * Everything one member's documents say about charts: stamp each holder, and
 * add a values node for each file a holder names that exists, and a manifest
 * node for each object in those files' `extraObjects`. Returns the stamped
 * documents, in order; the nodes go into `entities`.
 */
export function readHelmReferences(opts: {
  documents: Doc[];
  ctx: HelmReadContext;
  label: string;
  entities: Map<string, Declarable>;
  warnings: string[];
  memberKind: string;
}): Doc[] {
  const { ctx, label, entities, warnings } = opts;
  const files = new Map<string, HelmChartRef[]>();
  const stamped = opts.documents.map((document) => {
    const { doc, references } = stampHelmReferences(document, ctx);
    if (!references) return doc;
    for (const path of references.valuesFiles) if (!files.has(path)) files.set(path, []);
    for (const chart of references.charts) {
      for (const path of chart.valuesFiles ?? []) {
        const have = files.get(path)!;
        if (!have.some((c) => helmChartKey(c) === helmChartKey(chart))) have.push({ repo: chart.repo, chart: chart.chart, version: chart.version });
      }
    }
    return doc;
  });

  for (const path of [...files.keys()].sort()) {
    const read = readValuesFile(ctx.workspace, path, (m) => warnings.push(`${opts.memberKind} member "${label}": ${m}`));
    if (!read) continue;
    entities.set(`${label}/values/${path}`, helmValuesEntity(read, files.get(path)!));
    const extra = read.values.extraObjects;
    for (const object of Array.isArray(extra) ? extra : []) {
      if (!isMap(object)) continue;
      if (typeof object.apiVersion !== "string" || typeof object.kind !== "string") continue;
      const entity: RenderedManifestEntity | null = renderedManifestEntity(object, path, HELM_VALUES_ANNOTATION);
      if (!entity) continue;
      addRenderedEntity(entities, label, entity);
    }
  }
  return stamped;
}
