/**
 * Auto-discovery for lint rules and post-synth checks.
 *
 * Scans directories for rule modules and loads exported rules/checks,
 * eliminating the need to manually list every rule in plugin.ts. A lexicon
 * run from source has `.ts` rule modules; one run compiled has `.js` modules
 * beside `.d.ts` declarations (#3981). Both are found, and tsx is registered
 * only when a module found is TypeScript.
 */

import { readdirSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import type { LintRule } from "./rule";
import type { PostSynthCheck } from "./post-synth";
import { ensureTypeScriptLoader } from "../ts-loader";
import { isTypeScriptModule } from "../module-source";

let cjsTypeScript = false;

/**
 * Register tsx so createRequire can load TypeScript files in Node.js ESM
 * context. Does nothing when tsx is not available; then only pre-compiled .js
 * files can be require()'d.
 *
 * From source this runs when the module loads, as it always has: vitest and
 * the source CLI rely on tsx's CommonJS hook being in place from then on. The
 * compiled CLI imports this module on every start and most commands read no
 * rule directory, so there it waits for the first directory that holds a
 * TypeScript rule module (#3878, #3981).
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
 * Load every rule module in `dir` and collect the exports `accept` takes.
 * Registers tsx first only when one of the modules is TypeScript.
 */
function discoverExports<T>(dir: string, importMetaUrl: string, accept: (value: unknown) => value is T): T[] {
  const files = listRuleFiles(dir);
  if (files.some(isTypeScriptModule)) registerTypeScriptRequire();
  const require = createRequire(importMetaUrl);
  const found: T[] = [];
  for (const file of files) {
    try {
      const mod = require(join(dir, file)) as Record<string, unknown>;
      for (const exp of Object.values(mod)) {
        if (accept(exp)) found.push(exp);
      }
    } catch {
      // Skip files that fail to load
    }
  }
  return found;
}

/**
 * Discover lint rules from a directory.
 *
 * Scans the directory for rule modules (see {@link listRuleFiles}), loads
 * each one, and collects any exported objects that look like a LintRule (has
 * `id`, `severity`, `category`, and `check` function).
 *
 * @param dir - Absolute path to the rules directory
 * @param importMetaUrl - The caller's import.meta.url (for createRequire)
 */
export function discoverLintRules(dir: string, importMetaUrl: string): LintRule[] {
  return discoverExports(dir, importMetaUrl, isLintRule).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Discover post-synth checks from a directory.
 *
 * Scans the directory for rule modules (see {@link listRuleFiles}), loads
 * each one, and collects any exported objects that look like a
 * PostSynthCheck (has `id`, `description`, and `check` function).
 *
 * @param dir - Absolute path to the post-synth rules directory
 * @param importMetaUrl - The caller's import.meta.url (for createRequire)
 */
export function discoverPostSynthChecks(dir: string, importMetaUrl: string): PostSynthCheck[] {
  return discoverExports(dir, importMetaUrl, isPostSynthCheck).sort((a, b) => a.id.localeCompare(b.id));
}

/** A rule module's name without its extension: `foo` for `foo.ts` and `foo.js`. */
export function ruleModuleBase(file: string): string {
  return file.replace(/\.(?:ts|js)$/, "");
}

/**
 * List rule modules in a directory: `.ts` source or compiled `.js`, leaving
 * out declarations (`.d.ts`), tests, helpers and the index. A directory
 * holding both `foo.ts` and `foo.js` lists `foo.ts` alone, so a rule is
 * never loaded twice.
 */
export function listRuleFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const modules = entries.filter((f) => {
    if (!f.endsWith(".ts") && !f.endsWith(".js")) return false;
    if (f.endsWith(".d.ts")) return false;
    if (/\.test\.[tj]s$/.test(f)) return false;
    if (f === "index.ts" || f === "index.js") return false;
    if (f.includes("helper")) return false;
    return true;
  });
  const sources = new Set(modules.filter((f) => f.endsWith(".ts")).map(ruleModuleBase));
  return modules.filter((f) => f.endsWith(".ts") || !sources.has(ruleModuleBase(f)));
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
    typeof o.severity !== "string" &&
    // A cross-root check (chant #1939) is not a per-build check.
    o.scope !== "cross-root"
  );
}
