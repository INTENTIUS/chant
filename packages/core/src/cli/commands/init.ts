import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { formatSuccess, formatWarning } from "../format";
import { loadPlugin, recordProjectLexicons } from "../plugins";
import { lexiconModulePath, lexiconSourceLabel } from "../../lexicon-module";
import { MCP_CONFIG_FILENAME, detectPackageManager, generateMcpConfig, mcpConfigPath } from "../mcp-config";

/** Read the current chant package version from our own package.json. */
export function getChantVersion(): string {
  try {
    const pkgDir = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.13";
  } catch {
    return "0.0.13";
  }
}

/**
 * Init command options
 */
export interface InitOptions {
  /** Target directory (defaults to cwd) */
  path?: string;
  /** Lexicon to use */
  lexicon: string;
  /** Template name (e.g. "node-pipeline", "docker-build") */
  template?: string;
  /** Force init even in non-empty directory */
  force?: boolean;
  /** Skip writing the project's `.mcp.json` (`--skip-mcp`) */
  skipMcp?: boolean;
  /** Skip interactive install prompt */
  skipInstall?: boolean;
  /**
   * If set, install only the named skill (e.g. "chant-gitlab-migrate")
   * rather than every skill the plugin exports. Useful for incremental
   * skill installation without re-scaffolding the project.
   */
  skill?: string;
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
  /**
   * chant#2578 — where the lexicon loads from when the directory's existing
   * chant.config declares it by path. There is no package to depend on or
   * install for it.
   */
  lexiconModule?: string;
}

/**
 * Generate package.json content
 */
function generatePackageJson(
  lexicon: string,
  extraScripts?: Record<string, string>,
  lexiconIsPackage = true,
): string {
  const ver = getChantVersion();
  const dependencies: Record<string, string> = {
    "@intentius/chant": `^${ver}`,
    // chant#2578 — a lexicon declared by path is not a package to depend on.
    ...(lexiconIsPackage ? { [`@intentius/chant-lexicon-${lexicon}`]: `^${ver}` } : {}),
  };

  const pkg = {
    name: "chant-project",
    version: ver,
    type: "module" as const,
    scripts: {
      build: `chant build src --lexicon ${lexicon}`,
      lint: "chant lint src",
      dev: `chant build src --lexicon ${lexicon} --watch`,
      ...extraScripts,
    },
    dependencies,
    devDependencies: {
      typescript: "^5.0.0",
    },
  };

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
skills/
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

`;
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

  // chant#2578 — `--force` into an existing project keeps its chant.config.
  // When that config declares the lexicon by path, it loads from the module
  // and there is no package to depend on or install.
  let lexiconModule: string | undefined;
  if (existsSync(join(targetDir, "chant.config.ts")) || existsSync(join(targetDir, "chant.config.json"))) {
    await recordProjectLexicons(targetDir);
    if (lexiconModulePath(options.lexicon) !== undefined) {
      lexiconModule = lexiconSourceLabel(options.lexicon, targetDir);
    }
  }

  // Load plugin early to get template set (used for scripts + source files)
  let templateSet: import("../../lexicon").InitTemplateSet | undefined;
  try {
    const plugin = await loadPlugin(options.lexicon);
    if (plugin.initTemplates) {
      templateSet = plugin.initTemplates(options.template);
    }
  } catch {
    // Plugin not yet installed — no source files to scaffold
  }

  // Create src directory
  const srcDir = join(targetDir, "src");
  if (!existsSync(srcDir)) {
    mkdirSync(srcDir, { recursive: true });
  }

  // Generate package.json
  writeIfNotExists(
    join(targetDir, "package.json"),
    generatePackageJson(options.lexicon, templateSet?.scripts, lexiconModule === undefined),
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

  // Generate chant.config.ts. A template that ships its own wins: core's
  // version knows only the lexicon name, while a template that declares a
  // config namespace (fountain's steward scaffold and its `fountain.profiles`
  // block, chant #2129) is scaffolding a project that needs it to run at all.
  // The root-file loop below runs *after* this write, and `writeIfNotExists`
  // keeps the first file, so a template's config would otherwise be discarded
  // in silence — see lexicons/cedar/src/init-templates.ts, which documents
  // having had to work around exactly that.
  writeIfNotExists(
    join(targetDir, "chant.config.ts"),
    templateSet?.root?.["chant.config.ts"] ?? generateChantConfig(options.lexicon),
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

  // Write source files from plugin template set
  if (templateSet) {
    for (const [filename, content] of Object.entries(templateSet.src)) {
      writeIfNotExists(
        join(srcDir, filename),
        content,
        `src/${filename}`,
        createdFiles,
        warnings,
      );
    }
    // Write root scaffold files (e.g. index.js, test.js, Dockerfile).
    // `chant.config.ts` is skipped: it was already written above, from this
    // same template set, and re-offering it here would only produce an
    // "already exists, skipping" warning about a file the template supplied.
    if (templateSet.root) {
      for (const [filename, content] of Object.entries(templateSet.root)) {
        if (filename === "chant.config.ts") continue;
        writeIfNotExists(
          join(targetDir, filename),
          content,
          filename,
          createdFiles,
          warnings,
        );
      }
    }
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

  // Scaffold .chant/types/lexicon-{lexicon}/ stub. A lexicon declared by path
  // is imported by its path, so it has no package name to stub (chant#2578).
  if (lexiconModule === undefined) {
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
  }

  // Generate the project's MCP config. It lands in the directory init was
  // pointed at, like everything else init produces, and at the path
  // `chant doctor` checks — see ../mcp-config.ts for why project scope, and
  // chant #2383 for the three-way disagreement that came of writing it into
  // the user's home directory instead.
  if (!options.skipMcp) {
    writeIfNotExists(
      mcpConfigPath(targetDir),
      generateMcpConfig(detectPackageManager(targetDir)),
      MCP_CONFIG_FILENAME,
      createdFiles,
      warnings,
    );
  }

  // Install skills from the lexicon's plugin. With --skill, install only
  // the matching skill; without, install all.
  try {
    const plugin = await loadPlugin(options.lexicon);
    if (plugin.skills) {
      const all = plugin.skills();
      const skills = options.skill ? all.filter((s) => s.name === options.skill) : all;
      if (options.skill && skills.length === 0) {
        warnings.push(`No skill named "${options.skill}" in lexicon ${options.lexicon}; nothing installed`);
      }
      for (const skill of skills) {
        const skillDir = join(targetDir, "skills", skill.name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), skill.content);
        createdFiles.push(`skills/${skill.name}/SKILL.md`);
      }
    }
  } catch {
    // Skills are optional — don't fail init if plugin isn't installed yet
  }

  // `--template` records where the files came from (#2540, ws-047). Plain
  // init writes no lock and never loads the lineage module.
  if (options.template && templateSet) {
    const { writeTemplateLock } = await import("../../workspace/lineage-init");
    const lock = writeTemplateLock({
      targetDir,
      lexicon: options.lexicon,
      template: options.template,
      createdFiles,
      chantVersion: getChantVersion(),
      lexiconModule,
    });
    if (lock) createdFiles.push(lock);
    else warnings.push(".chant/workspace.lock.json already exists, skipping");
  }

  return {
    success: true,
    createdFiles,
    warnings,
    ...(lexiconModule !== undefined ? { lexiconModule } : {}),
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

  if (result.lexiconModule !== undefined) {
    console.log(`The lexicon loads from ${result.lexiconModule}, as chant.config.ts declares. It has no package to install.`);
    console.log("");
  }

  const pm = detectPackageManager(options?.cwd);

  // Interactive install prompt
  if (!options?.skipInstall) {
    const shouldInstall = await promptInstall();
    if (shouldInstall) {
      const { execSync } = await import("child_process");
      const cwd = options?.cwd ?? ".";
      console.log("Installing dependencies...");
      try {
        execSync(`${pm} install`, { cwd, stdio: "inherit" });
      } catch {
        console.error(formatWarning({ message: `Install failed. Run '${pm} install' manually.` }));
      }
    }
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit src/config.ts");
  console.log("  2. Add resources in src/");
  console.log(`  3. ${pm} run build`);
}

