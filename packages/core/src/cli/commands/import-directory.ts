/**
 * `chant import <directory>` (#5115): every template under a directory
 * becomes one module of one project, so the checks that look across
 * objects (a RoleBinding naming a Role, a Kustomization naming a
 * GitRepository, a workload consuming a Secret) see the whole directory
 * instead of one file at a time.
 *
 * Each input file is written to the same relative path with a `.ts`
 * extension, and the objects of every file are parsed through one embedded
 * content resolver, so the directories that hold another lexicon's modules
 * stay distinct. A file that is not a template of the lexicon is skipped
 * with a warning that names it; the others are imported.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";
import { markImportedSource } from "../../lint/rules/imported-source";
import type { ImportDiagnostic, ResourceIR, TemplateIR } from "../../import/parser";
import type { GeneratedFile } from "../../import/generator";
import { EmbeddedImports } from "../../import/embedded";
import { resolveParserOptions } from "../../import/parser-options";
import type { LexiconPlugin } from "../../lexicon";
import { loadPlugins } from "../plugins";
import {
  buildErrorWarnings,
  detectTemplateLexicon,
  firstFileOf,
  parseTemplateDocuments,
  parseWithEmbedded,
  type ImportOptions,
  type ImportResult,
} from "./import";

const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);

/** Every `.yaml` and `.yml` file under `root`, as absolute paths in name order. Symbolic links are not followed. */
function listYamlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out;
}

const posixPath = (p: string): string => p.split(sep).join("/");

/** The module path for an input file: its own path with a `.ts` extension, made unique among `taken`. */
function modulePath(relativeSource: string, taken: Set<string>): string {
  const base = relativeSource.replace(/\.ya?ml$/i, "");
  let path = `${base}.ts`;
  for (let n = 2; taken.has(path); n++) path = `${base}-${n}.ts`;
  taken.add(path);
  return path;
}

/** One input file that parsed into objects. */
interface ParsedFile {
  /** Path relative to the imported directory, with `/` separators. */
  source: string;
  content: string;
}

export async function importDirectory(options: ImportOptions): Promise<ImportResult> {
  const directory = resolve(options.templatePath);
  const outputDir = resolve(options.output ?? "./infra/");
  const projectDir = resolve(options.output ? dirname(options.output) : ".");
  const warnings: string[] = [];
  const fail = (error: string, lexicon?: string): ImportResult => ({
    success: false,
    generatedFiles: [],
    warnings,
    error,
    ...(lexicon ? { lexicon } : {}),
  });

  const listed = listYamlFiles(directory);
  if (listed.length === 0) return fail(`No .yaml or .yml files under ${directory}.`);

  // The lexicon: named, or the one that recognizes a document in the directory.
  let plugin: LexiconPlugin | undefined;
  let detected = false;
  if (options.lexicon) {
    try {
      [plugin] = await loadPlugins([options.lexicon]);
    } catch (err) {
      return fail(`Could not load lexicon "${options.lexicon}": ${err}`);
    }
    if (!plugin) return fail(`Lexicon "${options.lexicon}" not available.`);
  } else {
    const documents: unknown[] = [];
    for (const file of listed) {
      try {
        documents.push(...(parseTemplateDocuments(readFileSync(file, "utf-8")) ?? []));
      } catch {
        // Unreadable: reported when the files are chosen below.
      }
    }
    const detection = await detectTemplateLexicon(documents, projectDir);
    if (!detection) {
      return fail(
        "Could not detect template lexicon. No installed lexicon recognizes a template under this directory. " +
          "Pass --lexicon <name> to import it with a specific lexicon.",
      );
    }
    plugin = detection.plugin;
    detected = true;
    if (detection.alsoMatched.length > 0) {
      warnings.push(
        `The directory is also recognized by ${detection.alsoMatched.join(", ")}. ` +
          `Importing with ${plugin.name}; pass --lexicon <name> to choose another.`,
      );
    }
  }
  if (!plugin.templateParser || !plugin.templateGenerator) {
    return fail(`lexicon "${plugin.name}" does not support template import`, plugin.name);
  }
  const resolved = resolveParserOptions(plugin, options.parserOptions);
  if ("error" in resolved) return fail(resolved.error, plugin.name);

  // The files that are this lexicon's templates.
  let chosen = listed;
  if (plugin.importFiles) {
    const selection = plugin.importFiles({ directory, files: listed });
    chosen = selection.files;
    warnings.push(...selection.warnings);
  }
  const parser = plugin.templateParser(resolved.options);
  const files: ParsedFile[] = [];
  for (const file of chosen) {
    const source = posixPath(relative(directory, file));
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (err) {
      warnings.push(`${source} could not be read and was skipped (${err instanceof Error ? err.message : String(err)}).`);
      continue;
    }
    const documents = parseTemplateDocuments(content);
    if (!documents || (plugin.detectTemplate && !documents.some((d) => safeDetect(plugin!, d)))) {
      warnings.push(`${source} is not a ${plugin.name} template and was skipped.`);
      continue;
    }
    try {
      const probe = parser.parse(content, { embedded: new EmbeddedImports([], { quiet: true }) });
      if (probe.resources.length === 0) {
        warnings.push(`${source} holds no ${plugin.name} resources and was skipped.`);
        continue;
      }
    } catch (err) {
      warnings.push(`${source} did not parse and was skipped (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}).`);
      continue;
    }
    files.push({ source, content });
  }
  if (files.length === 0) return fail(`No ${plugin.name} templates found under ${directory}.`, plugin.name);

  // One parse of every file, through one resolver. The identifiers taken so
  // far are shared, so two files cannot declare the same name; the set starts
  // empty on the first file of each pass (the probe pass and the pass with
  // the owners' importers each read every file).
  const identifiers = new Set<string>();
  let irs: TemplateIR[];
  let embedded: EmbeddedImports | undefined;
  try {
    ({ irs, embedded } = await parseWithEmbedded(
      files.map((f, index) => (context) => {
        if (index === 0) identifiers.clear();
        return parser.parse(f.content, { ...context, identifiers });
      }),
      [plugin],
      projectDir,
    ));
  } catch (err) {
    return fail(`Failed to parse templates: ${err}`, plugin.name);
  }
  irs = irs.map((ir, i) => ({
    ...ir,
    resources: ir.resources.map((r) => ({ ...r, metadata: { ...r.metadata, sourcePath: files[i].source } })),
  }));
  irs.forEach((ir, i) => {
    if (ir.warnings) warnings.push(...ir.warnings.map((w) => withSource(w, files[i].source)));
  });
  const diagnostics: ImportDiagnostic[] = irs.flatMap((ir) => ir.diagnostics ?? []);
  if (options.validate) {
    if (!plugin.validateImport) return fail(`lexicon "${plugin.name}" has no emulator to validate an import against`, plugin.name);
    try {
      const merged: TemplateIR = { resources: irs.flatMap((ir) => ir.resources as ResourceIR[]), parameters: irs.flatMap((ir) => ir.parameters) };
      diagnostics.push(...(await plugin.validateImport(merged, resolved.options)));
    } catch (err) {
      return fail(`--validate failed to run: ${err instanceof Error ? err.message : String(err)}`, plugin.name);
    }
  }
  if (embedded) warnings.push(...embedded.warnings);

  // One module per file, at the file's own path.
  const generator = plugin.templateGenerator();
  const taken = new Set((embedded?.files ?? []).map((f) => f.path));
  const modules: GeneratedFile[] = [];
  irs.forEach((ir, i) => {
    const path = modulePath(files[i].source, taken);
    const generated = generator.generate(ir, { directory: posixPath(dirname(path)) === "." ? "" : posixPath(dirname(path)), sourcePath: files[i].source });
    const content = firstFileOf(generated, path, warnings);
    if (content !== undefined) modules.push({ path, content });
  });

  if (existsSync(outputDir) && !options.force && readdirSync(outputDir).length > 0) {
    warnings.push(`Output directory ${outputDir} is not empty. Use --force to overwrite.`);
  }
  mkdirSync(outputDir, { recursive: true });
  const generatedFiles: string[] = [];
  for (const file of [...modules, ...(embedded?.files ?? [])]) {
    const filePath = join(outputDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    if (existsSync(filePath) && !options.force) {
      warnings.push(`File ${file.path} already exists, skipping`);
      continue;
    }
    writeFileSync(filePath, markImportedSource(file.path, file.content));
    generatedFiles.push(file.path);
  }

  warnings.push(...(await buildErrorWarnings(plugin, outputDir)));

  return {
    success: true,
    generatedFiles,
    warnings,
    lexicon: plugin.name,
    detected,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function safeDetect(plugin: LexiconPlugin, document: unknown): boolean {
  try {
    return plugin.detectTemplate?.(document) === true;
  } catch {
    return false;
  }
}

/** A parser warning, with the file it came from in front. */
function withSource(warning: string, source: string): string {
  return `${source}: ${warning}`;
}
