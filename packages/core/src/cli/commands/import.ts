import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join, resolve, basename, dirname } from "path";
import { formatSuccess, formatWarning, formatError } from "../format";
import type { TemplateIR, ResourceIR, ParameterIR, TemplateParser } from "../../import/parser";
import type { GeneratedFile, TypeScriptGenerator } from "../../import/generator";
import { listInstalledLexicons, loadPlugin, loadPlugins, resolveProjectLexicons } from "../plugins";
import type { LexiconPlugin, ResourceSelector } from "../../lexicon";
import { parseYAMLDocument, splitYAMLDocuments } from "../../yaml";

/**
 * Import command options
 */
export interface ImportOptions {
  /** Path to template file */
  templatePath: string;
  /** Output directory (defaults to ./infra/) */
  output?: string;
  /** Force overwrite existing files */
  force?: boolean;
  /**
   * Lexicon whose parser handles the file (#2935). Skips detection and the
   * JSON/YAML check: the raw content goes straight to that plugin's parser.
   */
  lexicon?: string;
}

/**
 * Import command result
 */
export interface ImportResult {
  /** Whether import succeeded */
  success: boolean;
  /** Generated files */
  generatedFiles: string[];
  /** Warning messages */
  warnings: string[];
  /** Error message if failed */
  error?: string;
  /** The lexicon that handled the template */
  lexicon?: string;
  /**
   * True when `lexicon` was found by template detection, false or absent when
   * it was named (`--lexicon`, `--kustomize`) (#2965).
   */
  detected?: boolean;
}

/**
 * Resource category for organizing files
 */
type ResourceCategory = "storage" | "compute" | "network" | "other";

/**
 * Parse template content for detection (#2935): JSON first, then YAML. A YAML
 * file is split into documents with core's `splitYAMLDocuments` (the k8s
 * parser splits the same way), and each document is parsed on its own, so
 * detection sees the same per-document objects the plugin's parser will. A
 * document whose top level is a list parses as that list (#2965). JSON yields
 * one document, the parsed value, exactly as before. Returns undefined when
 * the content is neither: core's YAML reader is lenient and turns unparseable
 * text into an empty mapping, so a file with no non-empty document is
 * rejected.
 */
export function parseTemplateDocuments(content: string): unknown[] | undefined {
  try {
    return [JSON.parse(content)];
  } catch {
    // Not JSON: try YAML.
  }
  const documents: unknown[] = [];
  for (const chunk of splitYAMLDocuments(content)) {
    let doc: unknown;
    try {
      doc = parseYAMLDocument(chunk);
    } catch {
      continue;
    }
    if (typeof doc === "object" && doc !== null && Object.keys(doc).length > 0) {
      documents.push(doc);
    }
  }
  return documents.length > 0 ? documents : undefined;
}

/** The outcome of template detection (#2965). */
export interface TemplateDetection {
  /** The plugin that handles the template. */
  plugin: LexiconPlugin;
  /**
   * Where it came from: one of the project's lexicons, or an installed
   * lexicon package tried because none of the project's matched.
   */
  source: "project" | "installed";
  /** Other installed lexicons that also recognized the deciding document. */
  alsoMatched: string[];
}

/**
 * Find the plugins that recognize a template. Documents are tried in file
 * order and the first one some plugin recognizes decides; every plugin that
 * recognizes that document is returned, in the order given. For a JSON
 * template there is exactly one document, so this is the old behaviour.
 */
function matchingPlugins(documents: unknown[], plugins: LexiconPlugin[]): LexiconPlugin[] {
  for (const data of documents) {
    const matches = plugins.filter((plugin) => {
      try {
        return plugin.detectTemplate?.(data) === true;
      } catch {
        return false;
      }
    });
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Detect which lexicon handles a template (#2965). The project's lexicons
 * (from chant.config, or the lexicons its source imports) are asked first, so
 * inside a project nothing changes when one of them matches. When none does,
 * or there is no project, every installed `@intentius/chant-lexicon-*`
 * package that is not already a project lexicon is asked, in name order,
 * and one with a `templateParser` is preferred over one without.
 * Installed lexicons are loaded one at a time and without `init()`; one that
 * fails to load is skipped. The chosen plugin is initialized before it is
 * returned.
 */
export async function detectTemplateLexicon(
  documents: unknown[],
  projectDir: string,
): Promise<TemplateDetection | undefined> {
  let projectNames: string[] = [];
  let projectPlugins: LexiconPlugin[] = [];
  try {
    projectNames = await resolveProjectLexicons(projectDir);
    projectPlugins = await loadPlugins(projectNames);
  } catch {
    projectPlugins = [];
  }

  const [fromProject] = matchingPlugins(documents, projectPlugins);
  if (fromProject) return { plugin: fromProject, source: "project", alsoMatched: [] };

  const installed: LexiconPlugin[] = [];
  for (const name of listInstalledLexicons(projectDir)) {
    if (projectNames.includes(name)) continue;
    try {
      installed.push(await loadPlugin(name));
    } catch {
      // Not loadable from here: it cannot handle the template either.
    }
  }

  // A lexicon that can import the template goes ahead of one that only
  // recognizes it (github and forgejo both read an Actions workflow).
  const matches = matchingPlugins(documents, installed);
  const [plugin, ...others] = [
    ...matches.filter((p) => p.templateParser),
    ...matches.filter((p) => !p.templateParser),
  ];
  if (!plugin) return undefined;
  await plugin.init?.();
  return { plugin, source: "installed", alsoMatched: others.map((p) => p.name) };
}

/**
 * Get the category for a resource type
 */
function getResourceCategory(type: string): ResourceCategory {
  const typeLower = type.toLowerCase();

  // Storage resources
  if (typeLower.includes("bucket") || typeLower.includes("storage") || typeLower.includes("queue")) {
    return "storage";
  }

  // Compute resources
  if (typeLower.includes("container") || typeLower.includes("service") || typeLower.includes("function")) {
    return "compute";
  }

  // Network resources
  if (typeLower.includes("loadbalancer") || typeLower.includes("lb") || typeLower.includes("network")) {
    return "network";
  }

  return "other";
}

/**
 * Organize resources into categories
 */
function organizeByCategory(ir: TemplateIR): Map<ResourceCategory, ResourceIR[]> {
  const categories = new Map<ResourceCategory, ResourceIR[]>();

  for (const resource of ir.resources) {
    const category = getResourceCategory(resource.type);
    const existing = categories.get(category) ?? [];
    existing.push(resource);
    categories.set(category, existing);
  }

  return categories;
}

/** The files an import writes, and anything core could not keep. */
export interface OrganizedFiles {
  files: GeneratedFile[];
  warnings: string[];
}

/**
 * The first file of one per-category `generate()` call, which core writes as
 * `<name>.ts`. Any further files that call returned are named in a warning
 * rather than dropped silently; a call that returned nothing is skipped with
 * a warning rather than failing on `generated[0]`.
 */
function firstFileOf(generated: GeneratedFile[], fileName: string, warnings: string[]): string | undefined {
  if (generated.length === 0) {
    warnings.push(`The generator returned no file for ${fileName}; it was not written.`);
    return undefined;
  }
  if (generated.length > 1) {
    const dropped = generated.slice(1).map((f) => f.path).join(", ");
    warnings.push(
      `The generator returned ${generated.length} files for ${fileName}; only the first was kept, ` +
        `and ${dropped} ${generated.length === 2 ? "was" : "were"} not written. ` +
        "A generator that places its own files sets ownsLayout (#2964).",
    );
  }
  return generated[0].content;
}

/**
 * Decide the files an import writes. A generator with `ownsLayout` is called
 * once with the whole IR and its files are written exactly as returned
 * (#2964). Otherwise an IR of up to three resources is generated in one call,
 * and a larger one is split into one file per resource category plus an
 * `index.ts` barrel.
 */
export function generateOrganizedFiles(
  ir: TemplateIR,
  generator: TypeScriptGenerator,
): OrganizedFiles {
  const warnings: string[] = [];

  // The generator places its own files, or everything fits in one call.
  if (generator.ownsLayout === true || ir.resources.length <= 3) {
    return { files: generator.generate(ir), warnings };
  }

  const files: GeneratedFile[] = [];
  const categories = organizeByCategory(ir);
  const exports: string[] = [];

  // Generate files for each category
  for (const [category, resources] of categories) {
    if (resources.length === 0) continue;

    const categoryIr: TemplateIR = {
      parameters: category === "other" ? ir.parameters : [],
      resources,
    };

    const fileName = `${category}.ts`;
    const content = firstFileOf(generator.generate(categoryIr), fileName, warnings);
    if (content === undefined) continue;
    files.push({ path: fileName, content });

    // Track exports
    for (const resource of resources) {
      const varName = resource.logicalId.charAt(0).toLowerCase() + resource.logicalId.slice(1);
      exports.push(`export { ${varName} } from "./${category}";`);
    }
  }

  // Handle parameters separately if not included in other category
  if (ir.parameters.length > 0 && !categories.has("other")) {
    const paramsIr: TemplateIR = {
      parameters: ir.parameters,
      resources: [],
    };
    const content = firstFileOf(generator.generate(paramsIr), "parameters.ts", warnings);
    if (content !== undefined) {
      files.push({ path: "parameters.ts", content });
      for (const param of ir.parameters) {
        const varName = param.name.charAt(0).toLowerCase() + param.name.slice(1);
        exports.push(`export { ${varName} } from "./parameters";`);
      }
    }
  }

  // Generate index.ts
  if (exports.length > 0) {
    files.push({
      path: "index.ts",
      content: exports.join("\n") + "\n",
    });
  }

  return { files, warnings };
}

/**
 * Execute the import command
 */
export async function importCommand(options: ImportOptions): Promise<ImportResult> {
  const templatePath = resolve(options.templatePath);
  const outputDir = resolve(options.output ?? "./infra/");
  const generatedFiles: string[] = [];
  const warnings: string[] = [];

  // Check if template exists
  if (!existsSync(templatePath)) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: `Template file not found: ${templatePath}`,
    };
  }

  // Read template content
  let content: string;
  try {
    content = readFileSync(templatePath, "utf-8");
  } catch (err) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: `Failed to read template: ${err}`,
    };
  }

  // `--lexicon <name>` names the plugin, so there is nothing to detect and no
  // format to check: the plugin's parser decides what it accepts (#2935).
  if (options.lexicon) {
    return importFromContent({
      content,
      lexicon: options.lexicon,
      output: options.output,
      force: options.force,
    });
  }

  // Parse for detection: JSON, falling back to YAML.
  const documents = parseTemplateDocuments(content);
  if (!documents) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: "Template is neither valid JSON nor YAML.",
    };
  }

  // Detect from the output directory (or CWD) so that project config is
  // found relative to where the user is working, not an arbitrary monorepo
  // root.
  const projectDir = resolve(options.output ? dirname(options.output) : ".");
  const detection = await detectTemplateLexicon(documents, projectDir);
  if (!detection) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error:
        "Could not detect template lexicon. No installed lexicon recognizes this template. " +
        "Pass --lexicon <name> to import it with a specific lexicon.",
    };
  }

  const { plugin } = detection;
  if (detection.alsoMatched.length > 0) {
    warnings.push(
      `The template is also recognized by ${detection.alsoMatched.join(", ")}. ` +
        `Importing with ${plugin.name}; pass --lexicon <name> to choose another.`,
    );
  }

  const result = parseAndWrite(plugin, content, outputDir, options.force, warnings, generatedFiles, plugin.name);
  return { ...result, detected: true };
}

/**
 * Import from an in-memory template string through a KNOWN plugin — no
 * detection, no JSON assumption (#1548). This is the seam
 * `chant import --kustomize <dir>` drives with `kustomize build` output
 * through the k8s plugin's YAML parser, and `chant import <file> --lexicon
 * <name>` drives with the file's content (#2935); `importCommand` above is
 * the same pipeline behind file reading + JSON/YAML detection.
 */
export interface ContentImportOptions {
  /** The raw template content (YAML or JSON — the plugin's parser decides). */
  content: string;
  /** The lexicon whose parser/generator handle it, e.g. "k8s". */
  lexicon: string;
  output?: string;
  force?: boolean;
}

export async function importFromContent(options: ContentImportOptions): Promise<ImportResult> {
  const outputDir = resolve(options.output ?? "./infra/");
  let plugins: LexiconPlugin[];
  try {
    plugins = await loadPlugins([options.lexicon]);
  } catch (err) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: `Could not load lexicon "${options.lexicon}": ${err}`,
    };
  }
  const plugin = plugins[0];
  if (!plugin) {
    return { success: false, generatedFiles: [], warnings: [], error: `Lexicon "${options.lexicon}" not available.` };
  }
  return parseAndWrite(plugin, options.content, outputDir, options.force, [], [], plugin.name);
}

/** The shared tail of every template import: parse → generate → write. */
function parseAndWrite(
  plugin: LexiconPlugin,
  content: string,
  outputDir: string,
  force: boolean | undefined,
  warnings: string[],
  generatedFiles: string[],
  lexicon: string,
): ImportResult {
  // A lexicon can recognize a template (detectTemplate) without being able to
  // import it (grafana has no parser). Every path funnels through here, so
  // this one check covers detection, --lexicon and content import (#2940).
  if (!plugin.templateParser || !plugin.templateGenerator) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: `lexicon "${plugin.name}" does not support template import`,
      lexicon: plugin.name,
    };
  }

  // Parse template
  let ir: TemplateIR;
  try {
    const parser = plugin.templateParser();
    ir = parser.parse(content);
  } catch (err) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: `Failed to parse template: ${err}`,
    };
  }

  // Sections the parser read but import cannot carry, named by the parser
  // rather than dropped silently (#2069).
  if (ir.warnings) {
    warnings.push(...ir.warnings);
  }

  const generator = plugin.templateGenerator();

  // Check output directory
  if (existsSync(outputDir) && !force) {
    const files = readdirSync(outputDir);
    if (files.length > 0) {
      warnings.push(`Output directory ${outputDir} is not empty. Use --force to overwrite.`);
    }
  }

  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Generate files
  const { files, warnings: layoutWarnings } = generateOrganizedFiles(ir, generator);
  warnings.push(...layoutWarnings);

  // Write files
  for (const file of files) {
    const filePath = join(outputDir, file.path);
    const dirPath = join(outputDir, file.path.split("/").slice(0, -1).join("/"));

    if (dirPath && !existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    // Check for existing file
    if (existsSync(filePath) && !force) {
      warnings.push(`File ${file.path} already exists, skipping`);
      continue;
    }

    writeFileSync(filePath, file.content);
    generatedFiles.push(file.path);
  }

  return {
    success: true,
    generatedFiles,
    warnings,
    lexicon,
  };
}

/**
 * Live import options — read from a running cloud/cluster instead of a file.
 */
export interface LiveImportOptions {
  /** Environment to resolve (passed to each lexicon's exportResources). */
  environment: string;
  /** The deployed stack to export from, for a multi-stack project (#932). When
   * omitted, the single-stack convention applies (the stack named after the
   * environment). */
  stack?: string;
  /** Restrict to one lexicon by name (e.g. "aws", "k8s"). */
  lexicon?: string;
  /** Output directory (defaults to ./infra/). */
  output?: string;
  /** Force overwrite existing files. */
  force?: boolean;
  /** Selector forwarded to the lexicon. */
  selector?: ResourceSelector;
  /** Restrict to chant-owned resources (inert until ownership marking lands). */
  owned?: boolean;
  /** Keep server-defaulted fields instead of stripping to declared shape. */
  verbatim?: boolean;
}

/**
 * Merge several template IRs into one. Resources and parameters concatenate;
 * later metadata wins on key collisions.
 */
function mergeIR(parts: TemplateIR[]): TemplateIR {
  const resources: ResourceIR[] = [];
  const parameters: ParameterIR[] = [];
  let metadata: Record<string, unknown> | undefined;
  for (const part of parts) {
    resources.push(...part.resources);
    parameters.push(...part.parameters);
    if (part.metadata) metadata = { ...(metadata ?? {}), ...part.metadata };
  }
  return { resources, parameters, metadata };
}

/**
 * Import directly from a live environment: ask each lexicon's exportResources
 * for full-fidelity IR, then generate chant TypeScript from it.
 *
 * Unlike file import, the live config may contain secrets — the caller prints a
 * warning. Uses the same file layout as file import (`generateOrganizedFiles`).
 */
export async function importFromLive(options: LiveImportOptions): Promise<ImportResult> {
  const projectDir = resolve(options.output ? dirname(options.output) : ".");

  // Resolve project lexicons, then hand off to the testable core.
  let plugins: LexiconPlugin[];
  try {
    const lexiconNames = await resolveProjectLexicons(projectDir);
    plugins = await loadPlugins(lexiconNames);
  } catch {
    plugins = [];
  }

  return liveImportFromPlugins(plugins, options);
}

/**
 * Multi-stack live import (#932): for a project that declares `stacks` in
 * chant.config, import each stack from its own live CloudFormation stack
 * (`exportResources({ stack })`) into its own source directory (`src`). Plugins
 * are resolved once from the project root; each stack regenerates independently,
 * so a reconcile of a multi-stack project touches the right source per stack
 * instead of one flat import against a single env-named stack. Returns one
 * result per stack, in declaration order.
 */
export async function importFromLiveStacks(
  options: Omit<LiveImportOptions, "stack" | "output">,
  stacks: Array<{ name: string; src: string }>,
): Promise<Array<{ stack: string; result: ImportResult }>> {
  let plugins: LexiconPlugin[];
  try {
    const lexiconNames = await resolveProjectLexicons(resolve("."));
    plugins = await loadPlugins(lexiconNames);
  } catch {
    plugins = [];
  }

  const results: Array<{ stack: string; result: ImportResult }> = [];
  for (const s of stacks) {
    const result = await liveImportFromPlugins(plugins, { ...options, stack: s.name, output: s.src });
    results.push({ stack: s.name, result });
  }
  return results;
}

/**
 * Live-import core: given resolved plugins, export and generate. Split from
 * plugin resolution so it can be tested with fake exporters (no cloud calls).
 */
export async function liveImportFromPlugins(
  plugins: LexiconPlugin[],
  options: LiveImportOptions,
): Promise<ImportResult> {
  const outputDir = resolve(options.output ?? "./infra/");
  const warnings: string[] = [];

  let exporters = plugins.filter((p) => p.exportResources && p.templateGenerator);
  if (options.lexicon) {
    exporters = exporters.filter((p) => p.name === options.lexicon);
  }

  if (exporters.length === 0) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: options.lexicon
        ? `Lexicon "${options.lexicon}" does not support live export, or is not in this project.`
        : "No project lexicon supports live export (exportResources).",
    };
  }

  // Collect IR from every exporter, tagging which lexicon produced output.
  const irParts: TemplateIR[] = [];
  let generatorLexicon: LexiconPlugin | undefined;
  for (const plugin of exporters) {
    let ir: TemplateIR;
    try {
      ir = await plugin.exportResources!({
        environment: options.environment,
        stack: options.stack,
        selector: options.selector,
        owned: options.owned,
        verbatim: options.verbatim,
      });
    } catch (err) {
      warnings.push(`${plugin.name}: live export failed — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (ir.resources.length === 0) continue;
    irParts.push(ir);
    generatorLexicon ??= plugin;
  }

  if (irParts.length === 0 || !generatorLexicon) {
    return {
      success: false,
      generatedFiles: [],
      warnings,
      error: `No resources exported from environment "${options.environment}".`,
    };
  }

  if (exporters.length > 1 && irParts.length > 1) {
    warnings.push("Multiple lexicons exported resources; generated with the first. Use --lexicon to target one.");
  }

  const ir = mergeIR(irParts);
  const generator = generatorLexicon.templateGenerator!();

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const { files, warnings: layoutWarnings } = generateOrganizedFiles(ir, generator);
  warnings.push(...layoutWarnings);
  const generatedFiles: string[] = [];
  for (const file of files) {
    const filePath = join(outputDir, file.path);
    const dirPath = join(outputDir, file.path.split("/").slice(0, -1).join("/"));
    if (dirPath && !existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    if (existsSync(filePath) && !options.force) {
      warnings.push(`File ${file.path} already exists, skipping`);
      continue;
    }
    writeFileSync(filePath, file.content);
    generatedFiles.push(file.path);
  }

  return {
    success: true,
    generatedFiles,
    warnings,
    lexicon: generatorLexicon.name,
    detected: !options.lexicon,
  };
}

/**
 * Print import result
 */
export function printImportResult(result: ImportResult): void {
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "Import failed" }));
    return;
  }

  for (const warning of result.warnings) {
    console.error(formatWarning({ message: warning }));
  }

  if (result.lexicon) {
    console.log(`${result.detected ? "Detected lexicon" : "Lexicon"}: ${result.lexicon}`);
  }

  if (result.generatedFiles.length > 0) {
    console.log(formatSuccess("Generated files:"));
    for (const file of result.generatedFiles) {
      console.log(`  ${file}`);
    }
  } else {
    console.log("No files generated.");
  }
}
