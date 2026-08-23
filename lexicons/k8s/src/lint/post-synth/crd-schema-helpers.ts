/**
 * Shared helpers for the custom-resource spec checks (WK8501, WK8502) — chant #1372.
 *
 * A CRD's constructor takes `spec: Record<string, unknown>`, so a misspelled
 * or wrong-typed field type-checks, serializes, and is accepted by the API
 * server (which prunes what the structural schema does not know) — the
 * controller then runs with a default nobody chose. The generated lexicon JSON
 * carries each CRD's `spec` field schema (`specSchema`); these helpers walk a
 * synthesized manifest against it and report what the schema would reject.
 *
 * Excluded from check auto-discovery by the "helper" filename filter.
 */

import { createRequire } from "module";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { CrdFieldSchema } from "../../spec/parse";
import { getPrimaryOutput, parseK8sManifests, type K8sManifest } from "./k8s-helpers";

export type { CrdFieldSchema };

interface LexiconEntry {
  kind: "resource" | "property";
  apiVersion?: string;
  gvkKind?: string;
  specSchema?: CrdFieldSchema;
}

let cachedRegistry: Map<string, CrdFieldSchema> | null = null;

/** Registry key: `<apiVersion>/<kind>`, the pair a manifest carries verbatim. */
function registryKey(apiVersion: string, kind: string): string {
  return `${apiVersion}/${kind}`;
}

/**
 * Spec schemas of every CRD the lexicon ships, keyed by `apiVersion/kind`.
 * Built-in kinds carry no `specSchema` and are never in the map.
 */
export function getCrdSchemaRegistry(): Map<string, CrdFieldSchema> {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = new Map();
  try {
    // Built lazily so importing this module stays edge-safe: `createRequire`
    // throws where import.meta.url is undefined (bundled Workers), and there
    // the registry is simply empty.
    const require = createRequire(import.meta.url);
    const lexicon = require("../../generated/lexicon-k8s.json") as Record<string, LexiconEntry>;
    for (const entry of Object.values(lexicon)) {
      if (entry.kind === "resource" && entry.apiVersion && entry.gvkKind && entry.specSchema) {
        cachedRegistry.set(registryKey(entry.apiVersion, entry.gvkKind), entry.specSchema);
      }
    }
  } catch {
    // Lexicon JSON not yet generated — empty registry, checks pass.
  }
  return cachedRegistry;
}

/** Test seam: replace the registry (pass `null` to reload from the lexicon JSON). */
export function setCrdSchemaRegistry(registry: Map<string, CrdFieldSchema> | null): void {
  cachedRegistry = registry;
}

/** The schema for a manifest's `apiVersion`/`kind`, if the lexicon ships one. */
export function specSchemaFor(manifest: K8sManifest): CrdFieldSchema | undefined {
  if (typeof manifest.apiVersion !== "string" || typeof manifest.kind !== "string") return undefined;
  return getCrdSchemaRegistry().get(registryKey(manifest.apiVersion, manifest.kind));
}

/** Every manifest in the build that has a shipped spec schema, with that schema. */
export function customResources(ctx: PostSynthContext): Array<{ manifest: K8sManifest; schema: CrdFieldSchema }> {
  const out: Array<{ manifest: K8sManifest; schema: CrdFieldSchema }> = [];
  for (const [, output] of ctx.outputs) {
    for (const manifest of parseK8sManifests(getPrimaryOutput(output))) {
      const schema = specSchemaFor(manifest);
      if (schema) out.push({ manifest, schema });
    }
  }
  return out;
}

export interface SpecFinding {
  kind: "unknown-field" | "type-mismatch";
  /** Dotted path under `spec`, e.g. `spec.source.s3bucket`. Array elements use `[i]`. */
  path: string;
  message: string;
}

/**
 * Walk `value` against `schema` and report every field the schema does not
 * list (unless the enclosing object is `open`) and every scalar whose type or
 * enum membership the schema rejects. Untyped nodes pass anything.
 */
export function validateSpec(value: unknown, schema: CrdFieldSchema, path = "spec"): SpecFinding[] {
  const findings: SpecFinding[] = [];
  walk(value, schema, path, findings);
  return findings;
}

function walk(value: unknown, schema: CrdFieldSchema, path: string, out: SpecFinding[]): void {
  if (value === null || value === undefined) return;

  // int-or-string and other deliberately untyped nodes accept anything.
  if (!schema.type) return;

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        out.push(mismatch(path, "an object", value));
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const [name, child] of Object.entries(obj)) {
        const childSchema = schema.fields?.[name];
        if (childSchema) {
          walk(child, childSchema, `${path}.${name}`, out);
          continue;
        }
        if (schema.open) continue;
        const known = Object.keys(schema.fields ?? {});
        const suggestion = suggestField(name, known);
        const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
        out.push({
          kind: "unknown-field",
          path: `${path}.${name}`,
          message: `unknown field "${path}.${name}"${hint}`,
        });
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        out.push(mismatch(path, "an array", value));
        return;
      }
      if (schema.items) {
        value.forEach((item, i) => walk(item, schema.items!, `${path}[${i}]`, out));
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        // `x-kubernetes-int-or-string` never reaches here (untyped); a plain
        // string field given a number is a real mismatch the server coerces
        // or rejects depending on version, so say so.
        out.push(mismatch(path, "a string", value));
        return;
      }
      checkEnum(value, schema, path, out);
      return;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || (schema.type === "integer" && !Number.isInteger(value))) {
        out.push(mismatch(path, schema.type === "integer" ? "an integer" : "a number", value));
        return;
      }
      checkEnum(value, schema, path, out);
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") out.push(mismatch(path, "a boolean", value));
      return;
    }
  }
}

function checkEnum(value: string | number, schema: CrdFieldSchema, path: string, out: SpecFinding[]): void {
  if (!schema.enum || schema.enum.length === 0) return;
  if (schema.enum.includes(String(value))) return;
  out.push({
    kind: "type-mismatch",
    path,
    message: `"${path}" must be one of ${schema.enum.map((v) => `"${v}"`).join(", ")}, got ${describe(value)}`,
  });
}

function mismatch(path: string, expected: string, value: unknown): SpecFinding {
  return {
    kind: "type-mismatch",
    path,
    message: `"${path}" expects ${expected}, got ${describe(value)}`,
  };
}

function describe(value: unknown): string {
  if (typeof value === "string") return `string "${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value} ${String(value)}`;
  if (Array.isArray(value)) return "an array";
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
}

/** Levenshtein distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
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

/** Closest known field within Levenshtein distance 3 (case-insensitive), if any. */
export function suggestField(unknown: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 4;
  for (const field of known) {
    const dist = levenshtein(unknown.toLowerCase(), field.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = field;
    }
  }
  return best;
}

/** `metadata.name` or the kind, for diagnostics. */
export function resourceLabel(manifest: K8sManifest): string {
  return manifest.metadata?.name ?? manifest.kind ?? "resource";
}
