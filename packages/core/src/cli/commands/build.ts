import { build } from "../../build";
import type { Serializer, SerializerResult } from "../../serializer";
import type { LexiconPlugin } from "../../lexicon";
import { runPostSynthChecks } from "../../lint/post-synth";
import type { PostSynthCheck } from "../../lint/post-synth";
import { formatError, formatWarning, formatSuccess, formatBold, formatInfo } from "../format";
import { writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { watchDirectory, formatTimestamp, formatChangedFiles } from "../watch";

/**
 * Build command options
 */
export interface BuildOptions {
  /** Path to infrastructure directory */
  path: string;
  /** Output file path (undefined = stdout) */
  output?: string;
  /** Output format */
  format: "json" | "yaml";
  /** Serializers to use for serialization */
  serializers: Serializer[];
  /** Lexicon plugins (for post-synth checks) */
  plugins?: LexiconPlugin[];
  /** Print summary to stderr */
  verbose?: boolean;
}

/**
 * Build command result
 */
export interface BuildResult {
  /** Whether the build succeeded */
  success: boolean;
  /** Number of resources built */
  resourceCount: number;
  /** Number of source files processed */
  fileCount: number;
  /** Error messages */
  errors: string[];
  /** Warning messages */
  warnings: string[];
}

/**
 * Execute the build command
 */
export async function buildCommand(options: BuildOptions): Promise<BuildResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Resolve the path
  const infraPath = resolve(options.path);

  // Run the build
  const result = await build(infraPath, options.serializers);

  // Format errors
  for (const error of result.errors) {
    const formatted = formatError({
      file: "file" in error ? (error as unknown as Record<string, unknown>).file as string | undefined : undefined,
      line: "line" in error ? (error as unknown as Record<string, unknown>).line as number | undefined : undefined,
      column: "column" in error ? (error as unknown as Record<string, unknown>).column as number | undefined : undefined,
      message: error.message,
      name: error.name,
    });
    errors.push(formatted);
  }

  // Format warnings
  for (const warning of result.warnings) {
    warnings.push(formatWarning({ message: warning }));
  }

  // Run post-synth checks from plugins
  if (result.errors.length === 0 && options.plugins) {
    const postSynthChecks: PostSynthCheck[] = [];
    for (const plugin of options.plugins) {
      if (plugin.postSynthChecks) {
        postSynthChecks.push(...plugin.postSynthChecks());
      }
    }

    if (postSynthChecks.length > 0) {
      const postDiags = runPostSynthChecks(postSynthChecks, result);
      for (const diag of postDiags) {
        const prefix = diag.entity ? `[${diag.entity}] ` : "";
        const lexiconSuffix = diag.lexicon ? ` (${diag.lexicon})` : "";
        if (diag.severity === "error") {
          errors.push(formatError({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
        } else {
          warnings.push(formatWarning({ message: `${prefix}${diag.message}${lexiconSuffix}` }));
        }
      }
    }
  }

  // Handle output
  if (result.errors.length === 0 && errors.length === 0) {
    // Extract primary content and collect additional files from SerializerResult
    const additionalFiles = new Map<string, string>();

    function getPrimaryContent(raw: string | SerializerResult): string {
      if (typeof raw === "string") return raw;
      if (raw.files) {
        for (const [filename, content] of Object.entries(raw.files)) {
          additionalFiles.set(filename, content);
        }
      }
      return raw.primary;
    }

    // Try to parse content as JSON; return raw string if not JSON.
    function tryParseJson(content: string): { json: unknown } | { raw: string } {
      try {
        return { json: JSON.parse(content) };
      } catch {
        return { raw: content };
      }
    }

    // Single lexicon: output the template directly
    // Multiple lexicons: wrap in lexicon keys
    let output: string = "{}";
    if (result.outputs.size === 1) {
      const [, raw] = [...result.outputs.entries()][0];
      const content = getPrimaryContent(raw);
      const parsed = tryParseJson(content);
      if ("json" in parsed) {
        output = JSON.stringify(parsed.json, sortedJsonReplacer, 2);
        if (options.format === "yaml") {
          output = jsonToYaml(JSON.parse(output));
        }
      } else {
        output = parsed.raw;
      }
    } else {
      // Multiple lexicons: JSON outputs get combined under lexicon keys,
      // non-JSON outputs (e.g. YAML) are appended after a separator.
      const combined: Record<string, unknown> = {};
      const nonJsonSections: string[] = [];
      const sortedLexiconNames = [...result.outputs.keys()].sort();
      for (const lexiconName of sortedLexiconNames) {
        const content = getPrimaryContent(result.outputs.get(lexiconName)!);
        const parsed = tryParseJson(content);
        if ("json" in parsed) {
          combined[lexiconName] = parsed.json;
        } else {
          nonJsonSections.push(`# --- ${lexiconName} ---\n${parsed.raw}`);
        }
      }

      const parts: string[] = [];
      if (Object.keys(combined).length > 0) {
        let jsonOutput = JSON.stringify(combined, sortedJsonReplacer, 2);
        if (options.format === "yaml") {
          jsonOutput = jsonToYaml(JSON.parse(jsonOutput));
        }
        parts.push(jsonOutput);
      }
      parts.push(...nonJsonSections);
      if (parts.length > 0) {
        output = parts.join("\n\n");
      }
    }

    if (options.output) {
      // Write to file
      try {
        const outputPath = resolve(options.output);
        writeFileSync(outputPath, output);

        // Write additional files (e.g. nested stack templates) alongside the primary output
        if (additionalFiles.size > 0) {
          const outputDir = dirname(outputPath);
          for (const [filename, content] of additionalFiles) {
            let fileContent = content;
            // Format additional files consistently
            try {
              const fileParsed = JSON.parse(content);
              fileContent = JSON.stringify(fileParsed, sortedJsonReplacer, 2);
              if (options.format === "yaml") {
                fileContent = jsonToYaml(JSON.parse(fileContent));
              }
            } catch {
              // If not JSON, write as-is
            }
            writeFileSync(join(outputDir, filename), fileContent);
          }
        }
      } catch (err) {
        errors.push(
          formatError({
            message: `Failed to write output file: ${err instanceof Error ? err.message : String(err)}`,
          })
        );
      }
    } else {
      // Print to stdout
      console.log(output);
      // Log additional files to stderr if any
      for (const [filename, content] of additionalFiles) {
        console.error(`\n--- ${filename} ---`);
        console.error(content);
      }
    }
  }

  const resourceCount = result.entities.size;
  const fileCount = result.sourceFileCount;

  if (options.verbose && errors.length === 0) {
    console.error(
      formatSuccess(
        `Built ${formatBold(String(resourceCount))} resources successfully`
      )
    );
  }

  return {
    success: errors.length === 0,
    resourceCount,
    fileCount,
    errors,
    warnings,
  };
}

/**
 * JSON.stringify replacer that sorts object keys for deterministic output
 */
function sortedJsonReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return value;
}

/**
 * Simple JSON to YAML converter
 */
function jsonToYaml(obj: unknown, indent = 0): string {
  const spaces = "  ".repeat(indent);

  if (obj === null) return "null";
  if (obj === undefined) return "~";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    // Quote strings that need it
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#")) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((item) => `${spaces}- ${jsonToYaml(item, indent + 1).trimStart()}`)
      .join("\n");
  }

  if (typeof obj === "object") {
    const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, value]) => {
        const yamlValue = jsonToYaml(value, indent + 1);
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return `${spaces}${key}:\n${yamlValue}`;
        }
        return `${spaces}${key}: ${yamlValue.trimStart()}`;
      })
      .join("\n");
  }

  return String(obj);
}

/**
 * Print errors to stderr
 */
export function printErrors(errors: string[]): void {
  for (const error of errors) {
    console.error(error);
  }
}

/**
 * Print warnings to stderr
 */
export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.error(warning);
  }
}

/**
 * Run build in watch mode. Runs an initial build, then watches for changes
 * and triggers rebuilds. Returns a cleanup function.
 */
export function buildCommandWatch(
  options: BuildOptions,
  onRebuild?: (result: BuildResult) => void,
): () => void {
  const infraPath = resolve(options.path);

  console.error(formatInfo(`[${formatTimestamp()}] Watching for changes...`));

  // Run initial build
  buildCommand(options).then((result) => {
    printWarnings(result.warnings);
    printErrors(result.errors);
    onRebuild?.(result);
    console.error(formatInfo(`[${formatTimestamp()}] Waiting for changes...`));
  });

  // Watch for changes and trigger rebuilds
  const cleanup = watchDirectory(infraPath, async (changedFiles) => {
    console.error("");
    console.error(
      formatInfo(
        `[${formatTimestamp()}] Changes detected: ${formatChangedFiles(changedFiles, infraPath)}`,
      ),
    );

    try {
      const result = await buildCommand(options);
      printWarnings(result.warnings);
      printErrors(result.errors);
      onRebuild?.(result);
    } catch (err) {
      console.error(formatError({ message: err instanceof Error ? err.message : String(err) }));
    }

    console.error(formatInfo(`[${formatTimestamp()}] Waiting for changes...`));
  });

  return cleanup;
}
