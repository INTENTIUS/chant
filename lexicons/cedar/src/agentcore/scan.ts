/**
 * Finding embedded AgentCore policy statements in a build's emitted output
 * (#1660).
 *
 * The DWD walls read emitted *text* rather than the in-memory model, for the
 * reason `../dogwood/scan.ts` sets out: `chant audit` runs over artifacts chant
 * did not write, and a wall that only fires on chant's own output is not a
 * wall. An embedded statement is the same situation one lexicon further out —
 * the statement lands in whatever the aws lexicon emitted, so this reads the
 * emitted template rather than reaching for a resource class the cedar lexicon
 * deliberately does not import.
 *
 * Structural, not CloudFormation-specific. The thing being looked for is an
 * object with a `Definition.Policy.Statement` string, which is AgentCore's
 * language-agnostic arm wherever it appears — in a CFN template's
 * `Resources.<id>.Properties`, in a plan JSON, in a fixture. The nearest
 * enclosing key is carried along as the name to blame, which for a CFN template
 * is the logical id.
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { isRecord } from "../policy-text";

/** One `Definition.Policy.Statement` found in an emitted artifact. */
export interface EmbeddedAgentCoreStatement {
  /** The lexicon whose output carried it. */
  lexicon: string;
  /** The filename, or the lexicon's primary output when it had no name. */
  source: string;
  /** The nearest enclosing key — a CloudFormation logical id, in practice. */
  logicalId?: string;
  /** The statement text, verbatim. */
  statement: string;
}

/** The `Cedar` arm as well, for a check that needs to tell the two apart. */
export interface EmbeddedAgentCoreDefinition extends EmbeddedAgentCoreStatement {
  arm: "Cedar" | "Policy";
}

function walk(
  node: unknown,
  logicalId: string | undefined,
  found: Array<{ logicalId?: string; arm: "Cedar" | "Policy"; statement: string }>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, logicalId, found);
    return;
  }
  if (!isRecord(node)) return;

  const definition = node.Definition;
  if (isRecord(definition)) {
    for (const arm of ["Cedar", "Policy"] as const) {
      const value = definition[arm];
      if (isRecord(value) && typeof value.Statement === "string") {
        found.push({ ...(logicalId ? { logicalId } : {}), arm, statement: value.Statement });
      }
    }
  }

  for (const [key, value] of Object.entries(node)) {
    // `Properties` is CloudFormation's own wrapper, so it is not the name to
    // blame — the logical id one level up is.
    walk(value, key === "Properties" ? logicalId : key, found);
  }
}

/** Every emitted text in a build, with the lexicon and filename that carried it. */
function emittedTexts(ctx: PostSynthContext): Array<{ lexicon: string; source: string; text: string }> {
  const out: Array<{ lexicon: string; source: string; text: string }> = [];
  for (const [lexicon, output] of ctx.outputs) {
    if (typeof output === "string") {
      if (output.length > 0) out.push({ lexicon, source: lexicon, text: output });
      continue;
    }
    if (typeof output.primary === "string" && output.primary.length > 0) {
      out.push({ lexicon, source: lexicon, text: output.primary });
    }
    for (const [filename, content] of Object.entries(output.files ?? {})) {
      if (typeof content === "string") out.push({ lexicon, source: filename, text: content });
    }
  }
  return out;
}

/**
 * Every AgentCore policy definition embedded in a build's emitted output.
 *
 * Non-JSON output is skipped rather than reported: most emitted files are not
 * JSON, and a parse failure here says nothing about whether a statement is
 * there.
 */
export function embeddedAgentCoreDefinitions(ctx: PostSynthContext): EmbeddedAgentCoreDefinition[] {
  const results: EmbeddedAgentCoreDefinition[] = [];

  for (const { lexicon, source, text } of emittedTexts(ctx)) {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    const found: Array<{ logicalId?: string; arm: "Cedar" | "Policy"; statement: string }> = [];
    walk(parsed, undefined, found);
    for (const hit of found) results.push({ lexicon, source, ...hit });
  }

  return results;
}

/** Only the language-agnostic arm — the one a `.dw` statement travels in. */
export function embeddedAgentCorePolicyStatements(ctx: PostSynthContext): EmbeddedAgentCoreStatement[] {
  return embeddedAgentCoreDefinitions(ctx).filter((d) => d.arm === "Policy");
}
