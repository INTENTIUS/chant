import { existsSync } from "fs";
import { join } from "path";

/**
 * Issue found during project structure check
 */
export interface ProjectIssue {
  /** Severity: "error" blocks commands, "warning" is advisory */
  severity: "error" | "warning";
  /** Human-readable message */
  message: string;
}

/**
 * Result of project structure validation
 */
export interface ProjectValidation {
  /** Whether the project structure is valid (no errors, warnings OK) */
  valid: boolean;
  /** Issues found */
  issues: ProjectIssue[];
}

/**
 * Validate project structure.
 *
 * Checks that required files and directories exist for a chant project.
 *
 * @param projectDir - Root directory of the chant project
 * @param lexicons - Lexicon names from config (e.g. ["aws"])
 */
export function validateProjectStructure(
  projectDir: string,
  lexicons: string[] = [],
): ProjectValidation {
  const issues: ProjectIssue[] = [];

  // Check for config file
  const hasTsConfig = existsSync(join(projectDir, "chant.config.ts"));
  const hasJsonConfig = existsSync(join(projectDir, "chant.config.json"));
  if (!hasTsConfig && !hasJsonConfig) {
    issues.push({
      severity: "warning",
      message: "No chant config found. Run \"chant init\" to create one.",
    });
  }

  // Check for src directory
  if (!existsSync(join(projectDir, "src"))) {
    issues.push({
      severity: "warning",
      message: "No src/ directory found.",
    });
  }

  // Check for .chant/types/core/
  if (!existsSync(join(projectDir, ".chant", "types", "core", "index.d.ts"))) {
    issues.push({
      severity: "warning",
      message: "Core types not installed in .chant/types/core/. Run \"chant update\" to sync.",
    });
  }

  // Check for lexicon type stubs
  for (const lexicon of lexicons) {
    const lexiconDir = join(projectDir, ".chant", "types", `lexicon-${lexicon}`);
    if (!existsSync(lexiconDir)) {
      issues.push({
        severity: "warning",
        message: `Lexicon types not installed for "${lexicon}". Run "chant update" to sync.`,
      });
    }
  }

  return {
    valid: issues.every((i) => i.severity !== "error"),
    issues,
  };
}
