import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, resolve, basename } from "path";
import { formatSuccess, formatWarning, formatError } from "../format";
import type { TemplateIR, ResourceIR, TemplateParser } from "../../import/parser";
import type { GeneratedFile, TypeScriptGenerator } from "../../import/generator";
import { loadPlugins, resolveProjectLexicons } from "../plugins";
import type { LexiconPlugin } from "../../lexicon";

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
  /** Detected lexicon */
  lexicon?: string;
}

/**
 * Resource category for organizing files
 */
type ResourceCategory = "storage" | "compute" | "network" | "other";

/**
 * Detect which plugin handles a template by asking each plugin.
 * @param data - Parsed JSON object
 * @param plugins - Loaded lexicon plugins
 * @returns The matching plugin, or undefined if none match
 */
function detectPlugin(data: unknown, plugins: LexiconPlugin[]): LexiconPlugin | undefined {
  for (const plugin of plugins) {
    if (plugin.detectTemplate?.(data)) {
      return plugin;
    }
  }
  return undefined;
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

/**
 * Generate organized files with separate modules
 */
function generateOrganizedFiles(
  ir: TemplateIR,
  generator: TypeScriptGenerator,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const categories = organizeByCategory(ir);
  const exports: string[] = [];

  // If all resources fit in one file, just generate main.ts
  if (ir.resources.length <= 3) {
    return generator.generate(ir);
  }

  // Generate files for each category
  for (const [category, resources] of categories) {
    if (resources.length === 0) continue;

    const categoryIr: TemplateIR = {
      parameters: category === "other" ? ir.parameters : [],
      resources,
    };

    const generated = generator.generate(categoryIr);
    const fileName = `${category}.ts`;

    files.push({
      path: fileName,
      content: generated[0].content,
    });

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
    const generated = generator.generate(paramsIr);
    files.push({
      path: "parameters.ts",
      content: generated[0].content,
    });

    for (const param of ir.parameters) {
      const varName = param.name.charAt(0).toLowerCase() + param.name.slice(1);
      exports.push(`export { ${varName} } from "./parameters";`);
    }
  }

  // Generate index.ts
  if (exports.length > 0) {
    files.push({
      path: "index.ts",
      content: exports.join("\n") + "\n",
    });
  }

  return files;
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

  // Load plugins and detect lexicon
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: "Template is not valid JSON.",
    };
  }

  // Load plugins from project config, falling back to all installed lexicons
  let plugins: LexiconPlugin[];
  try {
    const lexiconNames = await resolveProjectLexicons(resolve("."));
    plugins = await loadPlugins(lexiconNames);
  } catch {
    plugins = [];
  }

  // If no plugins resolved (no config, no source files), try common lexicons
  if (plugins.length === 0) {
    try {
      plugins = await loadPlugins(["aws"]);
    } catch {
      // No lexicons available at all
    }
  }

  const plugin = detectPlugin(data, plugins);
  if (!plugin) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: "Could not detect template lexicon. No installed lexicon recognizes this template.",
    };
  }

  const lexicon = plugin.name;

  if (!plugin.templateParser || !plugin.templateGenerator) {
    return {
      success: false,
      generatedFiles: [],
      warnings: [],
      error: `Lexicon "${plugin.name}" does not support template import.`,
      lexicon,
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

  const generator = plugin.templateGenerator();

  // Check output directory
  if (existsSync(outputDir) && !options.force) {
    const files = require("fs").readdirSync(outputDir);
    if (files.length > 0) {
      warnings.push(`Output directory ${outputDir} is not empty. Use --force to overwrite.`);
    }
  }

  // Create output directory
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Generate files
  const files = generateOrganizedFiles(ir, generator);

  // Write files
  for (const file of files) {
    const filePath = join(outputDir, file.path);
    const dirPath = join(outputDir, file.path.split("/").slice(0, -1).join("/"));

    if (dirPath && !existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }

    // Check for existing file
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
    lexicon,
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
    console.log(`Detected lexicon: ${result.lexicon}`);
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
