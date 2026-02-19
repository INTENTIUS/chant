/**
 * Generic lexicon-based LSP completion and hover providers.
 *
 * Provides LexiconIndex for looking up resources/properties by class name,
 * and helper functions that implement the common completion/hover patterns
 * shared across lexicons.
 */

import type { CompletionContext, CompletionItem, HoverContext, HoverInfo } from "./types";

// ── Lexicon Entry ──────────────────────────────────────────────────

export interface LexiconEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: string;
  attrs?: Record<string, string>;
  propertyConstraints?: Record<string, unknown>;
  createOnly?: string[];
  writeOnly?: string[];
  primaryIdentifier?: string[];
}

// ── LexiconIndex ───────────────────────────────────────────────────

/**
 * Indexed access to lexicon entries for LSP features.
 */
export class LexiconIndex {
  constructor(private entries: Record<string, LexiconEntry>) {}

  /** All resource class names with their backing type names. */
  getResourceNames(): Array<{ className: string; resourceType: string }> {
    const results: Array<{ className: string; resourceType: string }> = [];
    for (const [name, entry] of Object.entries(this.entries)) {
      if (entry.kind === "resource") {
        results.push({ className: name, resourceType: entry.resourceType });
      }
    }
    return results;
  }

  /** Property names available on a given resource class. */
  getPropertyNames(className: string): string[] {
    const entry = this.entries[className];
    if (!entry || entry.kind !== "resource") return [];

    const props: string[] = [];
    if (entry.propertyConstraints) {
      props.push(...Object.keys(entry.propertyConstraints));
    }
    if (entry.createOnly) {
      for (const p of entry.createOnly) {
        if (!props.includes(p)) props.push(p);
      }
    }
    if (entry.writeOnly) {
      for (const p of entry.writeOnly) {
        if (!props.includes(p)) props.push(p);
      }
    }
    return props;
  }

  /** Look up a single entry by class name. */
  getEntry(name: string): LexiconEntry | undefined {
    return this.entries[name];
  }
}

// ── Completion helper ──────────────────────────────────────────────

/**
 * Provide completions from a lexicon index.
 *
 * Handles two contexts:
 * - After `new ` — suggests resource class names
 * - Inside constructor props — suggests property names
 *
 * @param importSource - Human-readable source label for documentation
 *   (e.g. "AWS CloudFormation resource")
 */
export function lexiconCompletions(
  ctx: CompletionContext,
  index: LexiconIndex,
  importSource: string,
): CompletionItem[] {
  const { linePrefix, wordAtCursor } = ctx;

  // After `new ` — suggest resource class names
  if (/\bnew\s+\w*$/.test(linePrefix)) {
    const resources = index.getResourceNames();
    const filtered = wordAtCursor
      ? resources.filter((r) => r.className.toLowerCase().startsWith(wordAtCursor.toLowerCase()))
      : resources;

    return filtered.slice(0, 50).map((r) => ({
      label: r.className,
      insertText: r.className,
      kind: "resource" as const,
      detail: r.resourceType,
      documentation: `${importSource}: ${r.resourceType}`,
    }));
  }

  // Inside constructor props — look for `new ClassName({` pattern
  const constructorMatch = ctx.content.slice(0, ctx.content.split("\n").slice(0, ctx.position.line + 1).join("\n").length)
    .match(/\bnew\s+(\w+)\s*\(\s*(?:["'][^"']*["']\s*,\s*)?{[^}]*$/s);

  if (constructorMatch) {
    const className = constructorMatch[1];
    const props = index.getPropertyNames(className);
    if (props.length > 0) {
      const filtered = wordAtCursor
        ? props.filter((p) => p.toLowerCase().startsWith(wordAtCursor.toLowerCase()))
        : props;
      return filtered.map((p) => ({
        label: p,
        insertText: p,
        kind: "property" as const,
        detail: `Property of ${className}`,
      }));
    }
  }

  return [];
}

// ── Hover helper ───────────────────────────────────────────────────

/**
 * Provide hover information from a lexicon index.
 *
 * @param formatHover - Lexicon-specific hover content formatter.
 *   If not provided, uses a generic format.
 */
export function lexiconHover(
  ctx: HoverContext,
  index: LexiconIndex,
  formatHover?: (className: string, entry: LexiconEntry) => HoverInfo | undefined,
): HoverInfo | undefined {
  const { word } = ctx;
  if (!word) return undefined;

  const entry = index.getEntry(word);
  if (!entry) return undefined;

  if (formatHover) {
    return formatHover(word, entry);
  }

  // Default hover format for resource entries
  if (entry.kind === "resource") {
    return defaultResourceHover(word, entry);
  }

  return undefined;
}

function defaultResourceHover(className: string, entry: LexiconEntry): HoverInfo {
  const lines: string[] = [];

  lines.push(`**${className}**`);
  lines.push("");
  lines.push(`Resource type: \`${entry.resourceType}\``);

  if (entry.attrs && Object.keys(entry.attrs).length > 0) {
    lines.push("");
    lines.push("**Attributes:**");
    for (const [key, value] of Object.entries(entry.attrs)) {
      lines.push(`- \`${key}\` → \`${value}\``);
    }
  }

  if (entry.primaryIdentifier && entry.primaryIdentifier.length > 0) {
    lines.push("");
    lines.push(`**Primary identifier:** ${entry.primaryIdentifier.map((p) => `\`${p}\``).join(", ")}`);
  }

  if (entry.createOnly && entry.createOnly.length > 0) {
    lines.push("");
    lines.push(`**Create-only:** ${entry.createOnly.map((p) => `\`${p}\``).join(", ")}`);
  }

  if (entry.writeOnly && entry.writeOnly.length > 0) {
    lines.push("");
    lines.push(`**Write-only:** ${entry.writeOnly.map((p) => `\`${p}\``).join(", ")}`);
  }

  return { contents: lines.join("\n") };
}
