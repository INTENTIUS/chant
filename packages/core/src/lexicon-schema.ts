/**
 * Zod schemas for lexicon manifest and registry validation.
 */

import { z } from "zod";
import type { LexiconManifest, IntrinsicDef } from "./lexicon";

// ---------------------------------------------------------------------------
// Intrinsic definitions
// ---------------------------------------------------------------------------

export const IntrinsicDefSchema = z.object({
  name: z.string().min(1, "intrinsic name must not be empty"),
  description: z.string().optional(),
  outputKey: z.string().optional(),
  isTag: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Lexicon manifest
// ---------------------------------------------------------------------------

const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/;

export const LexiconManifestSchema = z.object({
  name: z.string().min(1, "manifest name must not be empty"),
  version: z.string().regex(semverRegex, "version must be valid semver (X.Y.Z)"),
  chantVersion: z.string().optional(),
  namespace: z.string().optional(),
  intrinsics: z.array(IntrinsicDefSchema).optional(),
  pseudoParameters: z.record(z.string(), z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Extension constraint schema (matches ExtensionConstraint from lexicon packages)
// ---------------------------------------------------------------------------

const ExtensionConstraintSchema = z.object({
  name: z.string(),
  type: z.enum(["if_then", "dependent_excluded", "required_or", "required_xor"]),
  condition: z.unknown().optional(),
  requirement: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Property constraints schema (matches PropertyConstraints from lexicon packages)
// ---------------------------------------------------------------------------

const PropertyConstraintsSchema = z.object({
  pattern: z.string().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  format: z.string().optional(),
  const: z.unknown().optional(),
  default: z.unknown().optional(),
  enum: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Lexicon entry (registry entry for a resource or property type)
// ---------------------------------------------------------------------------

export const LexiconEntrySchema = z.object({
  resourceType: z.string(),
  kind: z.enum(["resource", "property"]),
  lexicon: z.string(),
  attrs: z.record(z.string(), z.string()).optional(),
  constraints: z.array(ExtensionConstraintSchema).optional(),
  propertyConstraints: z.record(z.string(), PropertyConstraintsSchema).optional(),
  createOnly: z.array(z.string()).optional(),
  writeOnly: z.array(z.string()).optional(),
  primaryIdentifier: z.array(z.string()).optional(),
  runtimeDeprecations: z.record(z.string(), z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Inferred types (useful for consumers who don't import the interface types)
// ---------------------------------------------------------------------------

export type LexiconEntryParsed = z.infer<typeof LexiconEntrySchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a manifest from unknown input (object or JSON string).
 * Throws a descriptive error on invalid input.
 */
export function validateManifest(data: unknown): LexiconManifest {
  if (data === null || data === undefined) {
    throw new Error("manifest data is empty");
  }

  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (err) {
      const msg = err instanceof SyntaxError ? err.message : String(err);
      throw new Error(`invalid JSON in manifest: ${msg}`);
    }
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("manifest must be a JSON object");
  }

  const result = LexiconManifestSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const prefix = path ? `manifest field ${path}` : "manifest";
    throw new Error(`${prefix}: ${issue.message}`);
  }

  return result.data as LexiconManifest;
}

/**
 * Validate a registry JSON string into a typed record.
 * Throws a descriptive error on invalid input.
 */
export function validateRegistry(json: string): Record<string, LexiconEntryParsed> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof SyntaxError ? err.message : String(err);
    throw new Error(`invalid JSON in registry: ${msg}`);
  }

  const schema = z.record(z.string(), LexiconEntrySchema);
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const prefix = path ? `registry[${path}]` : "registry";
    throw new Error(`${prefix}: ${issue.message}`);
  }

  return result.data;
}
