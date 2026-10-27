/**
 * `chant import --index <ref>` (#4524): typed source for indexed resources.
 *
 * Reads one index version (a file, or a version in the project's index
 * store), selects nodes, and writes source through each lexicon's own
 * template generator. Nothing is applied and nothing is written to the
 * cloud. The pure part is ../../lifecycle/index-import.ts; this module reads
 * the index, builds the project for the declared check, and writes files.
 *
 * The report (`chant-index-import.json` in the output directory, or
 * `--report <path>`) names every selected resource's identity and cloud ids,
 * what was imported, declared or unsupported, each reference and each
 * parameter. The adoption step (INTENTIUS/choudoufu#2284) reads it.
 * `--adopt-out <file>` also writes the adoption file (`adopt: v1`, #4536)
 * that adopts every imported resource as its logical id.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import type { GeneratedFile } from "../../import/generator";
import type { LexiconPlugin } from "../../lexicon";
import type { DeclaredEntity } from "../../lifecycle/identity-match";
import { adoptionFileFromImportReport, adoptionFileJson } from "../../lifecycle/adoption-file";
import type { IndexDocument } from "../../lifecycle/index-document";
import {
  declaredNodes,
  indexImportHeader,
  planIndexImport,
  selectionIsEmpty,
  type IndexImportPlan,
  type IndexImportReport,
  type IndexImportSelection,
} from "../../lifecycle/index-import";
import { generateOrganizedFiles, type ImportResult } from "./import";

export const INDEX_IMPORT_REPORT_FILE = "chant-index-import.json";

export interface IndexImportOptions {
  /** A JSON file (one index document, or a list of the documents of one read), or `<scopeKey>[@<version>]` in the index store. */
  index: string;
  selection: IndexImportSelection;
  /** Output directory (defaults to ./infra/). */
  output?: string;
  force?: boolean;
  /** Where to write the report; defaults to `<output>/chant-index-import.json`. */
  report?: string;
  /** Where to write the adoption file for what was imported (`--adopt-out`, #4536). */
  adoptOut?: string;
  /** The project whose declared entities are checked (defaults to the current directory). */
  projectDir?: string;
  /** The project's source directory (`--src`; defaults to `sourceDir` from chant.config, then the project). */
  src?: string;
  /** Plugins to use instead of loading them (tests). */
  plugins?: LexiconPlugin[];
  /** Declared entities by lexicon instead of building the project (tests). */
  declaredEntities?: ReadonlyMap<string, readonly DeclaredEntity[]>;
}

export interface IndexImportResult extends ImportResult {
  report?: IndexImportReport;
}

function asDocuments(parsed: unknown, from: string): IndexDocument[] {
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { documents?: unknown }).documents)
      ? (parsed as { documents: unknown[] }).documents
      : [parsed];
  for (const d of list) {
    if (!d || typeof d !== "object" || (d as { index?: unknown }).index !== "v1") {
      throw new Error(`${from} does not hold index documents (index: "v1")`);
    }
  }
  return list as IndexDocument[];
}

/**
 * The documents an index ref names: a file path, or a store ref in the
 * grammar `chant search --index` reads (`<scopeKey>[@latest|@<version>]`,
 * ../../lifecycle/index-join.ts), from the store chant.config's `snapshots`
 * picks (#4519).
 */
export async function loadIndexDocuments(ref: string, cwd: string): Promise<IndexDocument[]> {
  const asFile = resolve(cwd, ref);
  if (existsSync(asFile)) return asDocuments(JSON.parse(readFileSync(asFile, "utf-8")), ref);
  const { parseIndexRef, readIndexRef } = await import("../../lifecycle/index-join");
  const parsed = parseIndexRef(ref);
  if ("error" in parsed) throw new Error(`no file of that name, and ${parsed.error}; ${parsed.hint}`);
  const { resolveSnapshotStore } = await import("../../lifecycle/snapshot-store");
  const store = await resolveSnapshotStore({ cwd });
  await store.fetch();
  const read = await readIndexRef(store, parsed);
  if ("error" in read) throw new Error(read.hint ? `${read.error}; ${read.hint}` : read.error);
  return [read.doc];
}

/**
 * The files an import plan writes, through each lexicon's template
 * generator, with the plan's header on each group's first file. Pure apart
 * from the generators, so the same plan gives byte-identical files.
 */
export function renderIndexImport(
  plan: IndexImportPlan,
  plugins: readonly LexiconPlugin[],
): { files: GeneratedFile[]; warnings: string[] } {
  const files: GeneratedFile[] = [];
  const warnings: string[] = [];
  for (const group of plan.groups) {
    const plugin = plugins.find((p) => p.name === group.lexicon);
    if (!plugin?.templateGenerator) {
      warnings.push(`the ${group.lexicon} lexicon has no template generator; ${group.ir.resources.length} resource(s) in ${group.dir || "."} were not written`);
      continue;
    }
    const organized = generateOrganizedFiles(group.ir, plugin.templateGenerator());
    warnings.push(...organized.warnings);
    organized.files.forEach((f, i) => {
      const path = group.dir ? `${group.dir}/${f.path}` : f.path;
      files.push({ path, content: i === 0 ? indexImportHeader(plan, group) + f.content : f.content });
    });
  }
  return { files, warnings };
}

/** The report as written: two-space JSON and a final newline. */
export function indexImportReportJson(report: IndexImportReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** The project's declared entities by lexicon, or why there are none to check. */
async function projectEntities(
  projectDir: string,
  src: string | undefined,
  plugins: readonly LexiconPlugin[],
): Promise<{ entities: Map<string, DeclaredEntity[]>; warning?: string }> {
  const entities = new Map<string, DeclaredEntity[]>();
  try {
    const { loadChantConfigUpward } = await import("../../config");
    const { config, configPath } = await loadChantConfigUpward(projectDir);
    if (!configPath) return { entities };
    const projectPlugins = plugins.filter((p) => p.serializer);
    if (projectPlugins.length === 0) return { entities };
    const { build } = await import("../../build");
    const { isObservableDeclarable } = await import("../../declarable");
    const root = src ? resolve(src) : resolve(dirname(configPath), config.sourceDir ?? ".");
    const result = await build(root, projectPlugins.map((p) => p.serializer), undefined, { config: config as unknown as Record<string, unknown> });
    if (result.errors.length > 0) {
      return { entities, warning: `the project at ${root} does not build, so no indexed resource was checked against its declarations` };
    }
    for (const [name, entity] of result.entities) {
      if (!isObservableDeclarable(entity)) continue;
      const list = entities.get(entity.lexicon) ?? entities.set(entity.lexicon, []).get(entity.lexicon)!;
      list.push({ name, entityType: entity.entityType, props: (entity.props ?? {}) as Record<string, unknown> });
    }
    return { entities };
  } catch (err) {
    return { entities, warning: `the declared check did not run: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The plugins for the index's lexicons and the project's, each loaded once; one that fails to load is left out. */
async function pluginsFor(docs: readonly IndexDocument[], projectDir: string): Promise<LexiconPlugin[]> {
  const { loadPlugin, resolveProjectLexicons } = await import("../plugins");
  let names: string[] = [];
  try {
    names = await resolveProjectLexicons(projectDir);
  } catch {
    names = [];
  }
  for (const d of docs) for (const n of d.graph.nodes) if (!n.unmappedKind) names.push(n.lexicon);
  const plugins: LexiconPlugin[] = [];
  for (const name of [...new Set(names)].sort()) {
    try {
      const plugin = await loadPlugin(name);
      await plugin.init?.();
      plugins.push(plugin);
    } catch {
      // Not installed here: its nodes are reported as not loaded.
    }
  }
  return plugins;
}

export async function importFromIndex(options: IndexImportOptions): Promise<IndexImportResult> {
  const outputDir = resolve(options.output ?? "./infra/");
  const projectDir = resolve(options.projectDir ?? (options.output ? dirname(outputDir) : "."));
  const warnings: string[] = [];
  const fail = (error: string): IndexImportResult => ({ success: false, generatedFiles: [], warnings, error });

  if (selectionIsEmpty(options.selection)) {
    return fail("name what to import: --type <type>, --name <native id>, --tag key=value, --select <file of node ids>, or --all");
  }

  let docs: IndexDocument[];
  try {
    docs = await loadIndexDocuments(options.index, process.cwd());
  } catch (err) {
    return fail(`could not read the index ${options.index}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const plugins = options.plugins ?? (await pluginsFor(docs, projectDir));
  let declared: Map<string, string> = new Map();
  let entities: ReadonlyMap<string, readonly DeclaredEntity[]>;
  if (options.declaredEntities) {
    entities = options.declaredEntities;
  } else {
    const project = await projectEntities(projectDir, options.src, plugins);
    if (project.warning) warnings.push(project.warning);
    entities = project.entities;
  }
  try {
    declared = declaredNodes(docs, entities, plugins);
  } catch (err) {
    warnings.push(`the declared check did not run: ${err instanceof Error ? err.message : String(err)}`);
  }

  let plan: IndexImportPlan;
  try {
    plan = planIndexImport(docs, options.selection, plugins, { declared });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (plan.report.resources.length === 0) return fail("the selection matches no node in the index");

  const { files, warnings: renderWarnings } = renderIndexImport(plan, plugins);
  warnings.push(...renderWarnings);
  for (const r of plan.report.resources) {
    if (r.status === "unsupported") warnings.push(`${r.node}: not imported, ${r.reason}`);
  }

  const reportPath = resolve(options.report ?? join(outputDir, INDEX_IMPORT_REPORT_FILE));
  const generatedFiles: string[] = [];
  const write = (path: string, content: string, shown: string) => {
    if (existsSync(path) && !options.force) {
      warnings.push(`File ${shown} already exists, skipping`);
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    generatedFiles.push(shown);
  };
  for (const file of files) write(join(outputDir, file.path), file.content, file.path);
  write(reportPath, indexImportReportJson(plan.report), relative(outputDir, reportPath) || reportPath);
  if (options.adoptOut) {
    const adoptPath = resolve(options.adoptOut);
    try {
      write(adoptPath, adoptionFileJson(adoptionFileFromImportReport(plan.report)), relative(outputDir, adoptPath) || adoptPath);
    } catch (err) {
      return { success: false, generatedFiles, warnings, error: `no adoption file written: ${err instanceof Error ? err.message : String(err)}`, report: plan.report };
    }
  }

  const lexicons = [...new Set(plan.groups.map((g) => g.lexicon))];
  return {
    success: true,
    generatedFiles,
    warnings,
    ...(lexicons.length === 1 ? { lexicon: lexicons[0] } : {}),
    report: plan.report,
  };
}

/** One line per status: what was imported, declared and left out. */
export function summarizeIndexImport(report: IndexImportReport): string {
  const count = (s: string) => report.resources.filter((r) => r.status === s).length;
  return `index import: ${count("imported")} imported, ${count("declared")} already declared, ${count("unsupported")} unsupported, ${report.parameters.length} parameter(s) to fill in`;
}
