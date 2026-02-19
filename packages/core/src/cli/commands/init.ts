import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createInterface } from "readline";
import { z } from "zod";
import { formatSuccess, formatWarning } from "../format";
import { loadPlugin } from "../plugins";

/**
 * Schema for validating generated package.json — catches template bugs early.
 */
const GeneratedPackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  type: z.literal("module"),
  scripts: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
});

/**
 * Init command options
 */
export interface InitOptions {
  /** Target directory (defaults to cwd) */
  path?: string;
  /** Lexicon to use */
  lexicon: string;
  /** Force init even in non-empty directory */
  force?: boolean;
  /** Skip MCP config generation */
  skipMcp?: boolean;
  /** Skip interactive install prompt */
  skipInstall?: boolean;
}

/**
 * Init command result
 */
export interface InitResult {
  /** Whether init succeeded */
  success: boolean;
  /** Created files */
  createdFiles: string[];
  /** Warning messages */
  warnings: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Detect the IDE environment for MCP config
 */
function detectIdeEnvironment(): "claude-code" | "cursor" | "generic" {
  // Check for Claude Code
  if (existsSync(join(homedir(), ".claude"))) {
    return "claude-code";
  }

  // Check for Cursor
  if (existsSync(join(homedir(), ".cursor"))) {
    return "cursor";
  }

  return "generic";
}

/**
 * Get MCP config directory based on IDE
 */
function getMcpConfigDir(ide: "claude-code" | "cursor" | "generic"): string {
  switch (ide) {
    case "claude-code":
      return join(homedir(), ".claude");
    case "cursor":
      return join(homedir(), ".cursor");
    default:
      return join(homedir(), ".config", "mcp");
  }
}

/**
 * Generate package.json content
 */
function generatePackageJson(lexicon: string): string {
  const dependencies: Record<string, string> = {
    "@intentius/chant": "^0.1.0",
    [`@intentius/chant-lexicon-${lexicon}`]: "^0.1.0",
  };

  const pkg = {
    name: "chant-project",
    version: "0.1.0",
    type: "module" as const,
    scripts: {
      build: `chant build src --lexicon ${lexicon}`,
      lint: "chant lint src",
      dev: `chant build src --lexicon ${lexicon} --watch`,
    },
    dependencies,
    devDependencies: {
      typescript: "^5.0.0",
    },
  };

  // Validate generated output to catch template bugs
  const result = GeneratedPackageJsonSchema.safeParse(pkg);
  if (!result.success) {
    throw new Error(`Bug: generated package.json is invalid: ${result.error.issues[0].message}`);
  }

  return JSON.stringify(pkg, null, 2);
}

/**
 * Generate tsconfig.json content with path mappings for .chant/ types
 */
function generateTsConfig(lexicon: string): string {
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: true,
      outDir: "./dist",
      rootDir: "./src",
      paths: {
        "@intentius/chant": ["./.chant/types/core"],
        "@intentius/chant/*": ["./.chant/types/core/*"],
        [`@intentius/chant-lexicon-${lexicon}`]: [`./.chant/types/lexicon-${lexicon}`],
        [`@intentius/chant-lexicon-${lexicon}/*`]: [`./.chant/types/lexicon-${lexicon}/*`],
      },
    },
    include: ["src"],
    exclude: ["node_modules", "dist"],
  };

  return JSON.stringify(config, null, 2);
}

/**
 * Generate chant.config.ts content
 */
function generateChantConfig(lexicon: string): string {
  return `import type { ChantConfig } from "@intentius/chant";

export default {
  lexicons: ["${lexicon}"],
} satisfies ChantConfig;
`;
}

/**
 * Generate .gitignore content
 */
function generateGitignore(): string {
  return `dist/
node_modules/
.chant/types/
.chant/meta/
.chant/rules/
.chant/skills/
`;
}


/**
 * Generate embedded core type definitions for .chant/types/core/
 */
function generateCoreTypeDefs(): string {
  return `// @intentius/chant — core type definitions
// Run "chant update" to sync the latest types

/** Wraps a value that may be a literal or an intrinsic expression */
export type Value<T> = T | Intrinsic;

/** Marker interface for intrinsic functions (Ref, Sub, etc.) */
export interface Intrinsic {
  toJSON(): unknown;
}

/** Serializer interface for chant specifications */
export interface Serializer {
  name: string;
  rulePrefix: string;
  serialize(entities: Map<string, Declarable>, outputs?: LexiconOutput[]): string;
  serializeCrossRef?(output: LexiconOutput): unknown;
}

/** Base interface for all declarable entities */
export interface Declarable {
  readonly lexicon: string;
  readonly entityType: string;
  readonly kind?: "resource" | "property";
}

/** Cross-lexicon output reference */
export interface LexiconOutput {
  readonly outputName: string;
  readonly sourceEntity: string;
  readonly sourceAttribute: string;
  readonly lexicon: string;
}

/** Top-level project configuration */
export interface ChantConfig {
  lexicons?: string[];
  lint?: {
    rules?: Record<string, string | [string, Record<string, unknown>]>;
    extends?: string[];
    plugins?: string[];
  };
}

/** Barrel proxy — lazy-loads all sibling exports */
export declare function barrel(dir: string): Record<string, unknown>;
`;
}

/**
 * Generate MCP config
 */
function generateMcpConfig(_ide: "claude-code" | "cursor" | "generic"): string {
  const config = {
    mcpServers: {
      chant: {
        command: "npx",
        args: ["chant", "serve", "mcp"],
      },
    },
  };

  return JSON.stringify(config, null, 2);
}

/**
 * Prompt user for install
 */
async function promptInstall(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question("Install dependencies? (Y/n) ", (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === "" || trimmed === "y" || trimmed === "yes");
    });
  });
}

/**
 * Write a file if it doesn't exist, tracking created files and warnings
 */
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

/**
 * Execute the init command
 */
export async function initCommand(options: InitOptions): Promise<InitResult> {
  const targetDir = resolve(options.path ?? ".");
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
        error: `Directory is not empty. Use --force to initialize anyway.`,
      };
    }

    if (nonHiddenFiles.length > 0) {
      warnings.push("Initializing in non-empty directory");
    }
  }

  // Create target directory if it doesn't exist
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Create src directory
  const srcDir = join(targetDir, "src");
  if (!existsSync(srcDir)) {
    mkdirSync(srcDir, { recursive: true });
  }

  // Generate package.json
  writeIfNotExists(
    join(targetDir, "package.json"),
    generatePackageJson(options.lexicon),
    "package.json",
    createdFiles,
    warnings,
  );

  // Generate tsconfig.json
  writeIfNotExists(
    join(targetDir, "tsconfig.json"),
    generateTsConfig(options.lexicon),
    "tsconfig.json",
    createdFiles,
    warnings,
  );

  // Generate chant.config.ts
  writeIfNotExists(
    join(targetDir, "chant.config.ts"),
    generateChantConfig(options.lexicon),
    "chant.config.ts",
    createdFiles,
    warnings,
  );

  // Generate .gitignore
  writeIfNotExists(
    join(targetDir, ".gitignore"),
    generateGitignore(),
    ".gitignore",
    createdFiles,
    warnings,
  );

  // Generate source files from plugin (or fallback to a minimal barrel)
  let sourceFiles: Record<string, string> = {};
  try {
    const plugin = await loadPlugin(options.lexicon);
    if (plugin.initTemplates) {
      sourceFiles = plugin.initTemplates();
    }
  } catch {
    // Plugin not yet installed — write a minimal barrel stub
    sourceFiles = {
      "_.ts": "// Barrel — re-export shared config here\n",
    };
  }
  for (const [filename, content] of Object.entries(sourceFiles)) {
    writeIfNotExists(
      join(srcDir, filename),
      content,
      `src/${filename}`,
      createdFiles,
      warnings,
    );
  }

  // Scaffold .chant/types/core/ with embedded type definitions
  const coreTypesDir = join(targetDir, ".chant", "types", "core");
  mkdirSync(coreTypesDir, { recursive: true });

  writeIfNotExists(
    join(coreTypesDir, "package.json"),
    JSON.stringify({ name: "@intentius/chant", version: "0.0.0", types: "./index.d.ts" }, null, 2),
    ".chant/types/core/package.json",
    createdFiles,
    warnings,
  );

  writeIfNotExists(
    join(coreTypesDir, "index.d.ts"),
    generateCoreTypeDefs(),
    ".chant/types/core/index.d.ts",
    createdFiles,
    warnings,
  );

  // Scaffold .chant/types/lexicon-{lexicon}/ stub
  const lexiconTypesDir = join(targetDir, ".chant", "types", `lexicon-${options.lexicon}`);
  mkdirSync(lexiconTypesDir, { recursive: true });

  writeIfNotExists(
    join(lexiconTypesDir, "package.json"),
    JSON.stringify(
      { name: `@intentius/chant-lexicon-${options.lexicon}`, version: "0.0.0", types: "./index.d.ts" },
      null,
      2,
    ),
    `.chant/types/lexicon-${options.lexicon}/package.json`,
    createdFiles,
    warnings,
  );

  writeIfNotExists(
    join(lexiconTypesDir, "index.d.ts"),
    `// Lexicon type stubs — run "chant update" to sync full types\nexport {};\n`,
    `.chant/types/lexicon-${options.lexicon}/index.d.ts`,
    createdFiles,
    warnings,
  );

  // Generate MCP config
  if (!options.skipMcp) {
    const ide = detectIdeEnvironment();
    const mcpDir = getMcpConfigDir(ide);

    if (!existsSync(mcpDir)) {
      mkdirSync(mcpDir, { recursive: true });
    }

    writeIfNotExists(
      join(mcpDir, "mcp.json"),
      generateMcpConfig(ide),
      `~/.${ide === "generic" ? "config/mcp" : ide}/mcp.json`,
      createdFiles,
      warnings,
    );
  }

  // Install skills from the lexicon's plugin
  try {
    const plugin = await loadPlugin(options.lexicon);
    if (plugin.skills) {
      const skills = plugin.skills();
      if (skills.length > 0) {
        const skillsDir = join(targetDir, ".chant", "skills", options.lexicon);
        mkdirSync(skillsDir, { recursive: true });
        for (const skill of skills) {
          const skillPath = join(skillsDir, `${skill.name}.md`);
          writeFileSync(skillPath, skill.content);
          createdFiles.push(`.chant/skills/${options.lexicon}/${skill.name}.md`);
        }
      }
    }
  } catch {
    // Skills are optional — don't fail init if plugin isn't installed yet
  }

  return {
    success: true,
    createdFiles,
    warnings,
  };
}

/**
 * Print init result and prompt for install
 */
export async function printInitResult(
  result: InitResult,
  options?: { skipInstall?: boolean; cwd?: string },
): Promise<void> {
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

  // Interactive install prompt
  if (!options?.skipInstall) {
    const shouldInstall = await promptInstall();
    if (shouldInstall) {
      const { execSync } = await import("child_process");
      const cwd = options?.cwd ?? ".";
      console.log("Installing dependencies...");
      try {
        execSync("npm install", { cwd, stdio: "inherit" });
      } catch {
        console.error(formatWarning({ message: "Install failed. Run 'npm install' manually." }));
      }
    }
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit src/config.ts");
  console.log("  2. Add resources in src/");
  console.log("  3. npm run build");
}

