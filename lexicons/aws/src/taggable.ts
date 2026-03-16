/**
 * Shared taggable resource lookup — loads from the generated lexicon JSON.
 *
 * Lazy-loaded and cached for the lifetime of the process.
 */

import { readFileSync } from "fs";
import { join } from "path";

interface LexiconEntry {
  kind: string;
  resourceType: string;
  tagging?: { taggable: boolean; tagOnCreate: boolean; tagUpdatable: boolean };
  [key: string]: unknown;
}

let _cached: Set<string> | undefined;

/**
 * Load taggable resource types from the lexicon JSON.
 * Result is cached after first call.
 */
export function loadTaggableResources(): Set<string> {
  if (_cached) return _cached;

  const set = new Set<string>();
  try {
    const pkgDir = join(__dirname, "..");
    const lexiconPath = join(pkgDir, "src", "generated", "lexicon-aws.json");
    const content = readFileSync(lexiconPath, "utf-8");
    const data = JSON.parse(content) as Record<string, LexiconEntry>;

    for (const [_name, entry] of Object.entries(data)) {
      if (entry.kind === "resource" && entry.resourceType && entry.tagging?.taggable) {
        set.add(entry.resourceType);
      }
    }
  } catch {
    // Lexicon not available — skip
  }

  _cached = set;
  return set;
}
