import { existsSync, readFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import { checkVersionCompatibility } from "../../lexicon-manifest";
import { debug } from "../debug";
import { loadPlugins, resolveProjectLexicons } from "../plugins";

export interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn";
  message?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  success: boolean;
}

export async function doctorCommand(path: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const projectPath = path || ".";

  // Check 0: Bun is installed
  try {
    const bunVersion = execSync("bun --version", { encoding: "utf-8" }).trim();
    checks.push({ name: "bun-installed", status: "pass", message: `v${bunVersion}` });
  } catch (e) {
    debug("bun version check failed:", e);
    checks.push({ name: "bun-installed", status: "fail", message: "Bun is not installed — see https://bun.sh" });
  }

  // Check 1: Config exists and parses
  const configPaths = [
    join(projectPath, "chant.config.json"),
    join(projectPath, "chant.config.ts"),
  ];
  let config: Record<string, unknown> | null = null;
  const configFound = configPaths.find(p => existsSync(p));
  if (!configFound) {
    checks.push({ name: "config-exists", status: "fail", message: "No chant.config.json or chant.config.ts found" });
  } else {
    try {
      if (configFound.endsWith(".json")) {
        config = JSON.parse(readFileSync(configFound, "utf-8"));
      }
      checks.push({ name: "config-exists", status: "pass" });
    } catch (err) {
      checks.push({ name: "config-exists", status: "fail", message: `Config parse error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Check 2: src/ directory exists with .ts files
  const srcDir = join(projectPath, "src");
  if (!existsSync(srcDir)) {
    checks.push({ name: "src-directory", status: "fail", message: "src/ directory not found" });
  } else {
    try {
      const tsFiles = (readdirSync(srcDir, { recursive: true }) as string[]).filter(
        (f) => f.endsWith(".ts")
      );
      if (tsFiles.length === 0) {
        checks.push({ name: "src-directory", status: "warn", message: "src/ exists but contains no .ts files" });
      } else {
        checks.push({ name: "src-directory", status: "pass" });
      }
    } catch (e) {
      debug("src directory read failed:", e);
      checks.push({ name: "src-directory", status: "fail", message: "Cannot read src/ directory" });
    }
  }

  // Check 3: .chant/types/core/ exists and is not empty
  const coreTypesDir = join(projectPath, ".chant", "types", "core");
  if (!existsSync(coreTypesDir)) {
    checks.push({ name: "core-types", status: "fail", message: ".chant/types/core/ not found — run chant update" });
  } else {
    try {
      const files = readdirSync(coreTypesDir);
      if (files.length === 0) {
        checks.push({ name: "core-types", status: "fail", message: ".chant/types/core/ is empty" });
      } else {
        checks.push({ name: "core-types", status: "pass" });
      }
    } catch (e) {
      debug("core types directory read failed:", e);
      checks.push({ name: "core-types", status: "fail", message: "Cannot read .chant/types/core/" });
    }
  }

  // Check 4-6: Per-lexicon checks
  const lexicons = (config as any)?.lexicons as string[] | undefined;
  if (lexicons && Array.isArray(lexicons)) {
    for (const lex of lexicons) {
      const lexDir = join(projectPath, ".chant", "types", `lexicon-${lex}`);
      if (!existsSync(lexDir)) {
        checks.push({ name: `lexicon-${lex}-types`, status: "fail", message: `.chant/types/lexicon-${lex}/ not found — run chant update` });
      } else {
        const files = readdirSync(lexDir);
        if (files.length === 0) {
          checks.push({ name: `lexicon-${lex}-types`, status: "fail", message: `.chant/types/lexicon-${lex}/ is empty` });
        } else {
          checks.push({ name: `lexicon-${lex}-types`, status: "pass" });
        }
      }

      // Check manifest version compatibility
      const manifestPath = join(lexDir, "manifest.json");
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          if (manifest.chantVersion) {
            // Use a placeholder current version for now
            const currentVersion = "0.1.0";
            if (!checkVersionCompatibility(manifest.chantVersion, currentVersion)) {
              checks.push({ name: `lexicon-${lex}-compat`, status: "warn", message: `Lexicon ${lex} requires chant ${manifest.chantVersion}` });
            } else {
              checks.push({ name: `lexicon-${lex}-compat`, status: "pass" });
            }
          }
        } catch (e) {
          debug(`manifest read failed for lexicon ${lex}:`, e);
        }
      }
    }
  }

  // Check 7: No stale/orphaned lexicon directories
  const typesDir = join(projectPath, ".chant", "types");
  if (existsSync(typesDir)) {
    try {
      const dirs = readdirSync(typesDir);
      for (const dir of dirs) {
        if (dir === "core") continue;
        if (!dir.startsWith("lexicon-")) continue;
        const lexName = dir.replace("lexicon-", "");
        if (lexicons && !lexicons.includes(lexName)) {
          checks.push({ name: `stale-${dir}`, status: "warn", message: `Orphaned directory .chant/types/${dir}/ — lexicon "${lexName}" not in config` });
        }
      }
    } catch (e) {
      debug("types directory read failed:", e);
    }
  }

  // Check 8: tsconfig.json has paths
  const tsconfigPath = join(projectPath, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      // Simple JSON parse — tsconfig may have comments, but we try
      const raw = readFileSync(tsconfigPath, "utf-8");
      // Strip single-line comments for basic parsing
      const cleaned = raw.replace(/\/\/.*$/gm, "");
      const tsconfig = JSON.parse(cleaned);
      if (!tsconfig.compilerOptions?.paths) {
        checks.push({ name: "tsconfig-paths", status: "warn", message: "tsconfig.json missing compilerOptions.paths" });
      } else {
        checks.push({ name: "tsconfig-paths", status: "pass" });
      }
    } catch (e) {
      debug("tsconfig.json parse failed:", e);
      checks.push({ name: "tsconfig-paths", status: "warn", message: "Could not parse tsconfig.json" });
    }
  }

  // Check 9: .mcp.json exists and has chant entry
  const mcpPath = join(projectPath, ".mcp.json");
  if (!existsSync(mcpPath)) {
    checks.push({ name: "mcp-config", status: "warn", message: ".mcp.json not found — run chant agent setup" });
  } else {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf-8"));
      if (!mcp.mcpServers?.chant) {
        checks.push({ name: "mcp-config", status: "warn", message: ".mcp.json missing mcpServers.chant entry" });
      } else {
        checks.push({ name: "mcp-config", status: "pass" });
      }
    } catch (e) {
      debug(".mcp.json parse failed:", e);
      checks.push({ name: "mcp-config", status: "fail", message: ".mcp.json is invalid JSON" });
    }
  }

  // Check: Lexicon project docs/ directory
  const isLexiconProject = existsSync(join(projectPath, "src", "plugin.ts"));
  if (isLexiconProject) {
    if (existsSync(join(projectPath, "docs"))) {
      checks.push({ name: "lexicon-docs", status: "pass" });
    } else {
      checks.push({ name: "lexicon-docs", status: "warn", message: "docs/ directory not found — run `just docs` to generate" });
    }
  }

  // Check: Skills installed for each plugin
  try {
    const lexiconNames = await resolveProjectLexicons(resolve(projectPath));
    const plugins = await loadPlugins(lexiconNames);
    for (const plugin of plugins) {
      if (!plugin.skills) continue;
      const skills = plugin.skills();
      if (skills.length === 0) continue;
      const skillsDir = join(projectPath, ".chant", "skills", plugin.name);
      let missing = 0;
      for (const skill of skills) {
        if (!existsSync(join(skillsDir, `${skill.name}.md`))) {
          missing++;
        }
      }
      if (missing === 0) {
        checks.push({ name: `skills-${plugin.name}`, status: "pass", message: `${skills.length} skill(s) installed` });
      } else if (missing < skills.length) {
        checks.push({ name: `skills-${plugin.name}`, status: "warn", message: `${missing}/${skills.length} skill(s) missing — run chant update` });
      } else {
        checks.push({ name: `skills-${plugin.name}`, status: "warn", message: `No skills installed — run chant update` });
      }
    }
  } catch (e) {
    debug("skills check failed:", e);
  }

  return {
    checks,
    success: checks.every(c => c.status !== "fail"),
  };
}
