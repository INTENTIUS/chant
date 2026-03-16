import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { formatSuccess, formatWarning } from "../format";

// Template generators
import { generatePluginTs, generateIndexTs } from "./init-lexicon/templates/plugin";
import { generateCodegenGenerateTs, generateCodegenGenerateCliTs, generateCodegenNamingTs, generateCodegenPackageTs, generateCodegenDocsTs } from "./init-lexicon/templates/codegen";
import { generateSpecFetchTs, generateSpecParseTs } from "./init-lexicon/templates/spec";
import { generateSampleRuleTs, generateLintRulesIndexTs } from "./init-lexicon/templates/lint";
import { generateLspCompletionsTs, generateLspHoverTs } from "./init-lexicon/templates/lsp";
import { generatePackageJson, generateTsConfig, generateJustfile, generateGitignore, generateReadme, generateSerializerTs, generateValidateTs, generateValidateCliTs } from "./init-lexicon/templates/project";
import { generatePluginTestTs, generateSerializerTestTs, generateCompletionsTestTs, generateHoverTestTs } from "./init-lexicon/templates/tests";
import { generateDocsPackageJson, generateDocsTsConfig, generateDocsAstroConfig, generateDocsContentConfig, generateDocsIndexMdx } from "./init-lexicon/templates/docs";
import { generateExamplePackageJson, generateExampleInfraTs } from "./init-lexicon/templates/examples";

/**
 * Init-lexicon command options
 */
export interface InitLexiconOptions {
  /** Lexicon name (e.g. "k8s") */
  name: string;
  /** Target directory (defaults to ./lexicons/<name>) */
  path?: string;
  /** Force init even in non-empty directory */
  force?: boolean;
  /** Skip install prompt */
  skipInstall?: boolean;
}

/**
 * Init-lexicon command result
 */
export interface InitLexiconResult {
  success: boolean;
  createdFiles: string[];
  warnings: string[];
  error?: string;
}

// ── Name derivation helpers ──────────────────────────────────────────

function toCamelCase(name: string): string {
  return name.replace(/[-_]+(.)/g, (_, c) => c.toUpperCase());
}

export function deriveNames(name: string) {
  const camel = toCamelCase(name);
  return {
    pluginVarName: `${camel}Plugin`,
    serializerVarName: `${camel}Serializer`,
    rulePrefix: name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3),
    packageName: `@intentius/chant-lexicon-${name}`,
  };
}

// ── writeIfNotExists ─────────────────────────────────────────────────

function writeIfNotExists(
  filePath: string,
  content: string,
  relativePath: string,
  createdFiles: string[],
  warnings: string[],
): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content);
    createdFiles.push(relativePath);
  } else {
    warnings.push(`${relativePath} already exists, skipping`);
  }
}

// ── Main command ─────────────────────────────────────────────────────

/**
 * Execute the init-lexicon command.
 */
export async function initLexiconCommand(options: InitLexiconOptions): Promise<InitLexiconResult> {
  const { name } = options;
  const names = deriveNames(name);
  const targetDir = resolve(options.path ?? join("lexicons", name));
  const createdFiles: string[] = [];
  const warnings: string[] = [];

  // Check if directory is non-empty
  if (existsSync(targetDir)) {
    const contents = readdirSync(targetDir);
    const nonHiddenFiles = contents.filter((f) => !f.startsWith("."));

    if (nonHiddenFiles.length > 0 && !options.force) {
      return {
        success: false,
        createdFiles: [],
        warnings: [],
        error: `Directory is not empty: ${targetDir}\nUse --force to initialize anyway.`,
      };
    }

    if (nonHiddenFiles.length > 0) {
      warnings.push("Initializing in non-empty directory");
    }
  }

  // Create directory structure
  const dirs = [
    "",
    "src",
    "src/codegen",
    "src/spec",
    "src/lint",
    "src/lint/rules",
    "src/lsp",
    "src/generated",
    "docs",
    "docs/src",
    "docs/src/content",
    "docs/src/content/docs",
    "examples/getting-started",
    "examples/getting-started/src",
  ];

  for (const dir of dirs) {
    const fullPath = join(targetDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // File map: relative path -> content
  const files: Record<string, string> = {
    "src/plugin.ts": generatePluginTs(name, names),
    "src/index.ts": generateIndexTs(names),
    "src/serializer.ts": generateSerializerTs(name, names),
    "src/codegen/generate.ts": generateCodegenGenerateTs(),
    "src/codegen/generate-cli.ts": generateCodegenGenerateCliTs(),
    "src/codegen/naming.ts": generateCodegenNamingTs(),
    "src/codegen/package.ts": generateCodegenPackageTs(name),
    "src/codegen/docs.ts": generateCodegenDocsTs(name),
    "src/spec/fetch.ts": generateSpecFetchTs(),
    "src/spec/parse.ts": generateSpecParseTs(),
    "src/lint/rules/sample.ts": generateSampleRuleTs(names),
    "src/lint/rules/index.ts": generateLintRulesIndexTs(),
    "src/lsp/completions.ts": generateLspCompletionsTs(name),
    "src/lsp/hover.ts": generateLspHoverTs(name),
    "src/lsp/completions.test.ts": generateCompletionsTestTs(),
    "src/lsp/hover.test.ts": generateHoverTestTs(),
    "src/plugin.test.ts": generatePluginTestTs(name, names),
    "src/serializer.test.ts": generateSerializerTestTs(name, names),
    "src/validate.ts": generateValidateTs(name),
    "src/validate-cli.ts": generateValidateCliTs(),
    "package.json": generatePackageJson(name, names),
    "tsconfig.json": generateTsConfig(),
    "justfile": generateJustfile(name),
    ".gitignore": generateGitignore(),
    "README.md": generateReadme(name, names),
    "docs/package.json": generateDocsPackageJson(name),
    "docs/tsconfig.json": generateDocsTsConfig(),
    "docs/astro.config.mjs": generateDocsAstroConfig(name),
    "docs/src/content.config.ts": generateDocsContentConfig(),
    "docs/src/content/docs/index.mdx": generateDocsIndexMdx(name),
    "examples/getting-started/package.json": generateExamplePackageJson(name),
    "examples/getting-started/src/infra.ts": generateExampleInfraTs(name, names),
  };

  // Write .gitkeep files
  const gitkeeps = [
    "src/generated/.gitkeep",
  ];

  for (const gk of gitkeeps) {
    const fullPath = join(targetDir, gk);
    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, "");
      createdFiles.push(gk);
    }
  }

  // Write all template files
  for (const [relativePath, content] of Object.entries(files)) {
    writeIfNotExists(
      join(targetDir, relativePath),
      content,
      relativePath,
      createdFiles,
      warnings,
    );
  }

  return {
    success: true,
    createdFiles,
    warnings,
  };
}

/**
 * Print the result of init-lexicon and show next steps.
 */
export async function printInitLexiconResult(result: InitLexiconResult): Promise<void> {
  if (!result.success) {
    console.error(result.error);
    return;
  }

  for (const warning of result.warnings) {
    console.error(formatWarning({ message: warning }));
  }

  if (result.createdFiles.length > 0) {
    console.log(formatSuccess("Created:"));
    for (const file of result.createdFiles) {
      console.log(`  ${file}`);
    }
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. cd into the lexicon directory");
  console.log("  2. bun install");
  console.log("  3. Edit src/spec/fetch.ts — point at your upstream schema source");
  console.log("  4. Edit src/spec/parse.ts — parse your schema format");
  console.log("  5. just generate — generate types from spec");
  console.log("  6. just validate — check generated artifacts");
}
