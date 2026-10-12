/**
 * Auto-discovery for lint rules and post-synth checks.
 *
 * Scans directories for .ts files and loads exported rules/checks,
 * eliminating the need to manually list every rule in plugin.ts.
 */

import { readdirSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import type { LintRule } from "./rule";
import type { PostSynthCheck } from "./post-synth";
import { ensureTypeScriptLoader } from "../ts-loader";

let cjsTypeScript = false;

/**
 * Register tsx so createRequire can load TypeScript files in Node.js ESM
 * context. Does nothing when tsx is not available; then only pre-compiled .js
 * files can be require()'d.
 *
 * From source this runs when the module loads, as it always has: vitest and
 * the source CLI rely on tsx's CommonJS hook being in place from then on. The
 * compiled CLI imports this module on every start and most commands read no
 * rule directory, so there it waits for the first one (#3878).
 */
function registerTypeScriptRequire(): void {
  if (cjsTypeScript) return;
  cjsTypeScript = true;
  if (ensureTypeScriptLoader()) return;
  try {
    const _req = createRequire(import.meta.url);
    const { register } = _req("tsx/cjs/api") as { register: () => void };
    register();
  } catch {
    // tsx not available; only pre-compiled .js files can be require()'d
  }
}

if (!import.meta.url.endsWith(".js")) registerTypeScriptRequire();

/**
 * Discover lint rules from a directory.
 *
 * Scans the directory for .ts files (excluding tests, helpers, and index files),
 * loads each module, and collects any exported objects that look like a LintRule
 * (has `id`, `severity`, `category`, and `check` function).
 *
 * @param dir - Absolute path to the rules directory
 * @param importMetaUrl - The caller's import.meta.url (for createRequire)
 */
export function discoverLintRules(dir: string, importMetaUrl: string): LintRule[] {
  registerTypeScriptRequire();
  const require = createRequire(importMetaUrl);
  const rules: LintRule[] = [];

  for (const file of listRuleFiles(dir)) {
    try {
      // Strip .ts extension — require() resolves without it
      const modPath = join(dir, file.replace(/\.ts$/, ""));
      const mod = require(modPath);
      for (const exp of Object.values(mod)) {
        if (isLintRule(exp)) rules.push(exp);
      }
    } catch {
      // Skip files that fail to load
    }
  }

  return rules.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Discover post-synth checks from a directory.
 *
 * Scans the directory for .ts files (excluding tests, helpers, and index files),
 * loads each module, and collects any exported objects that look like a PostSynthCheck
 * (has `id`, `description`, and `check` function).
 *
 * @param dir - Absolute path to the post-synth rules directory
 * @param importMetaUrl - The caller's import.meta.url (for createRequire)
 */
export function discoverPostSynthChecks(dir: string, importMetaUrl: string): PostSynthCheck[] {
  registerTypeScriptRequire();
  const require = createRequire(importMetaUrl);
  const checks: PostSynthCheck[] = [];

  for (const file of listRuleFiles(dir)) {
    try {
      // Strip .ts extension — require() resolves without it
      const modPath = join(dir, file.replace(/\.ts$/, ""));
      const mod = require(modPath);
      for (const exp of Object.values(mod)) {
        if (isPostSynthCheck(exp)) checks.push(exp);
      }
    } catch {
      // Skip files that fail to load
    }
  }

  return checks.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * List rule files in a directory (excluding tests, helpers, index).
 */
export function listRuleFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => {
      if (!f.endsWith(".ts")) return false;
      if (f.endsWith(".test.ts")) return false;
      if (f === "index.ts") return false;
      if (f.includes("helper")) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function isLintRule(obj: unknown): obj is LintRule {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.severity === "string" &&
    typeof o.category === "string" &&
    typeof o.check === "function"
  );
}

function isPostSynthCheck(obj: unknown): obj is PostSynthCheck {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.description === "string" &&
    typeof o.check === "function" &&
    // Exclude LintRules (which also have check) by checking for PostSynthCheck-specific fields
    typeof o.severity !== "string"
  );
}
