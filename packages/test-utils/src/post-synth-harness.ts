/**
 * PostSynthTestHarness — shared test helpers for post-synth rule testing.
 *
 * Normalizes the different makeCtx patterns across lexicons into a single
 * consistent interface. Supports YAML/JSON string outputs and SerializerResult
 * (multi-file) outputs.
 */

import type { PostSynthContext, PostSynthCheck, PostSynthDiagnostic } from "../../core/src/lint/post-synth";
import type { SerializerResult } from "../../core/src/serializer";
import type { Declarable } from "../../core/src/declarable";

/**
 * Create a PostSynthContext from a string output (YAML, JSON, TOML, etc.).
 *
 * @param lexicon - The lexicon name (e.g. "aws", "k8s", "helm")
 * @param output - The serialized output string
 * @param entities - Optional entity map
 */
export function makePostSynthCtx(
  lexicon: string,
  output: string,
  entities?: Map<string, Declarable>,
): PostSynthContext {
  const entityMap = entities ?? new Map();
  const outputs = new Map<string, string | SerializerResult>();
  outputs.set(lexicon, output);
  return {
    outputs,
    entities: entityMap,
    buildResult: {
      outputs,
      entities: entityMap,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

/**
 * Create a PostSynthContext from a multi-file SerializerResult.
 *
 * Used by lexicons like Helm that produce multiple output files.
 *
 * @param lexicon - The lexicon name
 * @param files - Record of filename → content
 * @param primary - The primary output content (default: first file or empty)
 * @param entities - Optional entity map
 */
export function makePostSynthCtxFromFiles(
  lexicon: string,
  files: Record<string, string>,
  primary?: string,
  entities?: Map<string, Declarable>,
): PostSynthContext {
  const entityMap = entities ?? new Map();
  const result: SerializerResult = {
    primary: primary ?? Object.values(files)[0] ?? "",
    files,
  };
  const outputs = new Map<string, string | SerializerResult>();
  outputs.set(lexicon, result);
  return {
    outputs,
    entities: entityMap,
    buildResult: {
      outputs,
      entities: entityMap,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

/**
 * Create a PostSynthContext from a JSON object (auto-serialized).
 *
 * Useful for JSON-based lexicons like AWS CloudFormation.
 *
 * @param lexicon - The lexicon name
 * @param template - Object to JSON.stringify
 * @param entities - Optional entity map
 */
export function makePostSynthCtxFromJSON(
  lexicon: string,
  template: object,
  entities?: Map<string, Declarable>,
): PostSynthContext {
  return makePostSynthCtx(lexicon, JSON.stringify(template), entities);
}

/**
 * Run a single post-synth check and return its diagnostics.
 *
 * Convenience wrapper for testing individual rules.
 */
export function runCheck(
  check: PostSynthCheck,
  ctx: PostSynthContext,
): PostSynthDiagnostic[] {
  return check.check(ctx);
}

/**
 * Assert that a check produces no diagnostics for the given context.
 */
export function expectNoDiagnostics(
  check: PostSynthCheck,
  ctx: PostSynthContext,
): void {
  const diags = check.check(ctx);
  if (diags.length > 0) {
    const msgs = diags.map((d) => `  ${d.checkId} [${d.severity}]: ${d.message}`).join("\n");
    throw new Error(`Expected no diagnostics from ${check.id}, but got ${diags.length}:\n${msgs}`);
  }
}

/**
 * Assert that a check produces at least one diagnostic matching the given criteria.
 */
export function expectDiagnostic(
  check: PostSynthCheck,
  ctx: PostSynthContext,
  match: {
    checkId?: string;
    severity?: string;
    messageContains?: string;
  },
): PostSynthDiagnostic[] {
  const diags = check.check(ctx);
  if (diags.length === 0) {
    throw new Error(`Expected diagnostics from ${check.id}, but got none`);
  }
  if (match.checkId) {
    const found = diags.some((d) => d.checkId === match.checkId);
    if (!found) {
      throw new Error(`Expected diagnostic with checkId "${match.checkId}", got: ${diags.map((d) => d.checkId).join(", ")}`);
    }
  }
  if (match.severity) {
    const found = diags.some((d) => d.severity === match.severity);
    if (!found) {
      throw new Error(`Expected diagnostic with severity "${match.severity}", got: ${diags.map((d) => d.severity).join(", ")}`);
    }
  }
  if (match.messageContains) {
    const found = diags.some((d) => d.message.includes(match.messageContains!));
    if (!found) {
      throw new Error(`Expected diagnostic message containing "${match.messageContains}", got: ${diags.map((d) => d.message).join("; ")}`);
    }
  }
  return diags;
}
