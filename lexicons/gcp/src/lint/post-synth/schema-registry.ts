/**
 * Schema registry for GCP Config Connector resources.
 *
 * Loads lexicon-gcp.json and builds a lookup from CRD kind to field schema,
 * used by post-synth rules to validate YAML against known CRD schemas.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

export interface FieldSchema {
  type: string;
  required: boolean;
  enum?: string[];
  ref?: boolean;
}

export interface ResourceSchema {
  fields: Record<string, FieldSchema>;
  required: string[];
}

interface LexiconEntry {
  kind: "resource" | "property";
  gvkKind?: string;
  schema?: ResourceSchema;
}

let cachedRegistry: Map<string, ResourceSchema> | null = null;

/**
 * Get the schema registry: Map<gvkKind, ResourceSchema>.
 */
export function getSchemaRegistry(): Map<string, ResourceSchema> {
  if (cachedRegistry) return cachedRegistry;

  cachedRegistry = new Map();
  try {
    const lexicon = require("../../generated/lexicon-gcp.json") as Record<string, LexiconEntry>;
    for (const entry of Object.values(lexicon)) {
      if (entry.kind === "resource" && entry.gvkKind && entry.schema) {
        cachedRegistry.set(entry.gvkKind, entry.schema);
      }
    }
  } catch {
    // Lexicon JSON not yet generated — return empty registry
  }

  return cachedRegistry;
}

/**
 * Levenshtein distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return dp[m][n];
}

/**
 * Find the closest field name by Levenshtein distance.
 * Returns the suggestion if distance ≤ 3, otherwise undefined.
 */
export function suggestField(unknown: string, knownFields: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 4; // threshold

  for (const field of knownFields) {
    const dist = levenshtein(unknown.toLowerCase(), field.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = field;
    }
  }

  return best;
}
