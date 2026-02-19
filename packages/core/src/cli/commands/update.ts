import { existsSync, mkdirSync, writeFileSync, cpSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { formatSuccess, formatWarning, formatError } from "../format";
import { loadChantConfig } from "../../config";
import { loadPlugins } from "../plugins";

/**
 * Update command options
 */
export interface UpdateOptions {
  /** Project directory (defaults to cwd) */
  path: string;
}

/**
 * Update command result
 */
export interface UpdateResult {
  /** Whether update succeeded */
  success: boolean;
  /** Synced items */
  synced: string[];
  /** Warning messages */
  warnings: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Copy directory contents recursively, filtering to .ts and .d.ts files
 */
function copyTypeFiles(src: string, dest: string): number {
  if (!existsSync(src)) return 0;
  mkdirSync(dest, { recursive: true });

  let count = 0;
  const entries = readdirSync(src);

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      // Skip node_modules, tests, examples
      if (entry === "node_modules" || entry === "__test__") continue;
      count += copyTypeFiles(srcPath, destPath);
    } else if (
      entry.endsWith(".d.ts") ||
      entry.endsWith(".json")
    ) {
      cpSync(srcPath, destPath);
      count++;
    }
  }

  return count;
}

/**
 * Resolve the path to a package in node_modules
 */
function resolvePackagePath(packageName: string, projectDir: string): string | undefined {
  // Try resolve from project dir
  try {
    const entryPoint = require.resolve(packageName, { paths: [projectDir] });
    // Walk up from entry point to find package root
    let dir = entryPoint;
    while (dir !== "/") {
      dir = join(dir, "..");
      if (existsSync(join(dir, "package.json"))) {
        const pkg = JSON.parse(require("fs").readFileSync(join(dir, "package.json"), "utf-8"));
        if (pkg.name === packageName) return dir;
      }
    }
  } catch {
    // Package not installed
  }

  // Fallback: check common node_modules locations
  const candidates = [
    join(projectDir, "node_modules", ...packageName.split("/")),
    join(projectDir, "..", "node_modules", ...packageName.split("/")),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Execute the update command — sync lexicon types into .chant/
 */
export async function updateCommand(options: UpdateOptions): Promise<UpdateResult> {
  const projectDir = resolve(options.path);
  const synced: string[] = [];
  const warnings: string[] = [];

  // Load config to get lexicons
  const { config } = await loadChantConfig(projectDir);
  const lexicons = config.lexicons ?? [];

  if (lexicons.length === 0) {
    return {
      success: false,
      synced: [],
      warnings: [],
      error: "No lexicons configured. Add lexicons to chant.config.ts.",
    };
  }

  const typesDir = join(projectDir, ".chant", "types");

  // Sync core types
  const corePkgPath = resolvePackagePath("@intentius/chant", projectDir);
  if (corePkgPath) {
    const coreDestDir = join(typesDir, "core");
    const srcDir = join(corePkgPath, "src");
    if (existsSync(srcDir)) {
      const count = copyTypeFiles(srcDir, coreDestDir);
      // Also copy package.json
      if (existsSync(join(corePkgPath, "package.json"))) {
        cpSync(join(corePkgPath, "package.json"), join(coreDestDir, "package.json"));
      }
      synced.push(`@intentius/chant (${count} files)`);
    }
  } else {
    warnings.push("@intentius/chant not found in node_modules");
  }

  // Sync each lexicon
  for (const lexicon of lexicons) {
    const pkgName = `@intentius/chant-lexicon-${lexicon}`;
    const pkgPath = resolvePackagePath(pkgName, projectDir);

    if (!pkgPath) {
      warnings.push(`${pkgName} not found in node_modules. Run "npm install" first.`);
      continue;
    }

    const lexiconDestDir = join(typesDir, `lexicon-${lexicon}`);
    const srcDir = join(pkgPath, "src");
    if (existsSync(srcDir)) {
      const count = copyTypeFiles(srcDir, lexiconDestDir);
      if (existsSync(join(pkgPath, "package.json"))) {
        cpSync(join(pkgPath, "package.json"), join(lexiconDestDir, "package.json"));
      }
      synced.push(`${pkgName} (${count} files)`);
    } else {
      warnings.push(`${pkgName} has no src/ directory`);
    }
  }

  // Install skills from plugins
  try {
    const plugins = await loadPlugins(lexicons);
    for (const plugin of plugins) {
      if (plugin.skills) {
        const skills = plugin.skills();
        if (skills.length > 0) {
          const skillsDir = join(projectDir, ".chant", "skills", plugin.name);
          mkdirSync(skillsDir, { recursive: true });
          for (const skill of skills) {
            writeFileSync(join(skillsDir, `${skill.name}.md`), skill.content);
          }
          synced.push(`${plugin.name} skills (${skills.length})`);
        }
      }
    }
  } catch {
    // Skills are optional — don't fail the update if plugin loading fails
    warnings.push("Could not load plugins for skill installation");
  }

  return {
    success: true,
    synced,
    warnings,
  };
}

/**
 * Print update result
 */
export function printUpdateResult(result: UpdateResult): void {
  if (!result.success) {
    console.error(formatError({ message: result.error ?? "Update failed" }));
    return;
  }

  for (const warning of result.warnings) {
    console.error(formatWarning({ message: warning }));
  }

  if (result.synced.length > 0) {
    console.log(formatSuccess("Synced types:"));
    for (const item of result.synced) {
      console.log(`  ${item}`);
    }
  } else {
    console.log("No types synced.");
  }
}
