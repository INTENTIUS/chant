/**
 * cfn-lint extension constraints — cross-property validation rules.
 *
 * Downloads extension schemas from the same cfn-lint tarball and parses
 * them into typed constraint objects for inclusion in lexicon JSON.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { fetchAndExtractTar } from "@intentius/chant/codegen/fetch";
import { typeNameToPatchDir } from "./patches";
import { cfnLintTarballUrl } from "./versions";

const CFN_LINT_TARBALL_URL = cfnLintTarballUrl();
const EXTENSIONS_DEST_DIR = join(homedir(), ".chant", "cfn-lint-extensions");
const EXTENSIONS_TAR_PREFIX = "src/cfnlint/data/schemas/extensions/";

/**
 * A single cross-property constraint extracted from a cfn-lint extension schema.
 */
export interface ExtensionConstraint {
  name: string;
  type: "if_then" | "dependent_excluded" | "required_or" | "required_xor";
  condition?: unknown;
  requirement?: unknown;
}

/**
 * Fetch cfn-lint extensions from GitHub tarball and extract to cache.
 */
export async function fetchCfnLintExtensions(force = false): Promise<string> {
  return fetchAndExtractTar(
    { url: CFN_LINT_TARBALL_URL, destDir: EXTENSIONS_DEST_DIR },
    EXTENSIONS_TAR_PREFIX,
    force,
  );
}

/**
 * Load extension schemas for known resource types.
 * Returns a map of CFN type name → extension constraints.
 */
export function loadExtensionSchemas(
  extensionsDir: string,
  knownTypes: Set<string>
): Map<string, ExtensionConstraint[]> {
  // Build reverse map: directory name → CFN type name
  const dirToType = new Map<string, string>();
  for (const typeName of knownTypes) {
    dirToType.set(typeNameToPatchDir(typeName), typeName);
  }

  const result = new Map<string, ExtensionConstraint[]>();

  let entries: string[];
  try {
    entries = readdirSync(extensionsDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(extensionsDir, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const cfnType = dirToType.get(entry);
    if (!cfnType) continue;

    const constraints = loadDirectoryConstraints(fullPath);
    if (constraints.length > 0) {
      result.set(cfnType, constraints);
    }
  }

  return result;
}

/**
 * Load all constraints from JSON files in a directory.
 */
function loadDirectoryConstraints(dir: string): ExtensionConstraint[] {
  const constraints: ExtensionConstraint[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return constraints;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;

    let data: string;
    try {
      data = readFileSync(join(dir, entry), "utf-8");
    } catch {
      continue;
    }

    try {
      const parsed = parseExtensionSchema(entry, data);
      constraints.push(...parsed);
    } catch {
      // Skip files that don't parse as constraints
    }
  }

  return constraints;
}

/**
 * Parse a single extension JSON Schema file into constraint objects.
 */
function parseExtensionSchema(fileName: string, data: string): ExtensionConstraint[] {
  const raw = JSON.parse(data) as Record<string, unknown>;
  const name = fileName.replace(/\.json$/, "");
  const constraints: ExtensionConstraint[] = [];

  // Check for allOf containing multiple constraints
  if ("allOf" in raw && Array.isArray(raw.allOf)) {
    for (let i = 0; i < raw.allOf.length; i++) {
      const item = raw.allOf[i] as Record<string, unknown>;
      try {
        const c = classifySingleConstraint(`${name}_${i}`, item);
        constraints.push(c);
      } catch {
        // Skip unrecognized items
      }
    }
    if (constraints.length > 0) return constraints;
  }

  // Single top-level constraint
  const c = classifySingleConstraint(name, raw);
  return [c];
}

/**
 * Classify a single JSON Schema document into an ExtensionConstraint.
 */
function classifySingleConstraint(
  name: string,
  raw: Record<string, unknown>
): ExtensionConstraint {
  const hasIf = "if" in raw;
  const hasThen = "then" in raw;
  const hasDependentExcluded = "dependentExcluded" in raw;
  const hasRequiredOr = "requiredOr" in raw;
  const hasRequiredXor = "requiredXor" in raw;

  if (hasRequiredXor) {
    return { name, type: "required_xor", requirement: raw.requiredXor };
  }
  if (hasRequiredOr) {
    return { name, type: "required_or", requirement: raw.requiredOr };
  }
  if (hasDependentExcluded) {
    return { name, type: "dependent_excluded", requirement: raw.dependentExcluded };
  }
  if (hasIf && hasThen) {
    return { name, type: "if_then", condition: raw.if, requirement: raw.then };
  }

  throw new Error(`unrecognized constraint pattern in ${name}`);
}
