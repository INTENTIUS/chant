/**
 * Go template expression extraction and stripping.
 *
 * Strips Go template expressions (`{{ ... }}`) from Helm templates,
 * replacing them with placeholder values so the underlying YAML can be parsed.
 * Records the original expressions for later reconstruction as Helm intrinsics.
 */

export interface StrippedExpression {
  /** Placeholder key inserted into the YAML. */
  placeholder: string;
  /** Original Go template expression (without delimiters). */
  expression: string;
  /** Line number (1-based). */
  line: number;
}

export interface StripResult {
  /** YAML with template expressions replaced by placeholders. */
  yaml: string;
  /** Extracted expressions keyed by placeholder. */
  expressions: Map<string, StrippedExpression>;
  /** Block-level directives (if/range/with/end) that were removed entirely. */
  blockDirectives: Array<{ directive: string; line: number }>;
}

/**
 * Strip Go template expressions from a Helm template file.
 *
 * - Inline expressions (`{{ .Values.x }}`) are replaced with `__HELM_PLACEHOLDERn__`
 * - Block-level directives (`{{- if ... }}`, `{{- end }}`, `{{- range ... }}`) are removed
 * - Action pipelines are preserved in the expression map
 */
export function stripTemplateExpressions(template: string): StripResult {
  const expressions = new Map<string, StrippedExpression>();
  const blockDirectives: Array<{ directive: string; line: number }> = [];
  let counter = 0;

  const lines = template.split("\n");
  const outputLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check if this is a standalone block directive line
    const trimmed = line.trim();
    if (isBlockDirectiveLine(trimmed)) {
      blockDirectives.push({ directive: trimmed, line: lineNum });
      continue; // Remove entire line
    }

    // Replace inline expressions with placeholders
    const processed = line.replace(/\{\{-?\s*(.*?)\s*-?\}\}/g, (_match, expr: string) => {
      const placeholder = `__HELM_PLACEHOLDER${counter}__`;
      counter++;
      expressions.set(placeholder, { placeholder, expression: expr.trim(), line: lineNum });
      return placeholder;
    });

    outputLines.push(processed);
  }

  return {
    yaml: outputLines.join("\n"),
    expressions,
    blockDirectives,
  };
}

/**
 * Check if a line is a standalone block directive (if/else/end/range/with/define/block).
 */
function isBlockDirectiveLine(trimmed: string): boolean {
  if (!trimmed.startsWith("{{")) return false;

  // Extract the directive content
  const match = trimmed.match(/^\{\{-?\s*(if|else|else if|end|range|with|define|block|template)\b/);
  if (!match) return false;

  // Verify the line is ONLY the directive (not mixed with YAML)
  // A standalone directive line starts with {{ and ends with }}
  return /\}\}\s*$/.test(trimmed);
}

/**
 * Classify a Go template expression into a category for code generation.
 */
export type ExpressionKind =
  | "values"      // .Values.x.y
  | "release"     // .Release.Name, etc.
  | "chart"       // .Chart.Name, etc.
  | "include"     // include "name" .
  | "toYaml"      // toYaml .Values.x | nindent N
  | "required"    // required "msg" .Values.x
  | "default"     // default "val" .Values.x
  | "printf"      // printf "%s" .Values.x
  | "quote"       // .Values.x | quote
  | "lookup"      // lookup "v1" "Secret" "ns" "name"
  | "tpl"         // tpl .Values.x .
  | "pipe"        // any piped expression
  | "other";      // unclassified

export function classifyExpression(expr: string): ExpressionKind {
  const trimmed = expr.trim();

  if (trimmed.startsWith("include ")) return "include";
  if (trimmed.startsWith("toYaml ") || trimmed.includes("| toYaml")) return "toYaml";
  if (trimmed.startsWith("required ")) return "required";
  if (trimmed.startsWith("default ")) return "default";
  if (trimmed.startsWith("printf ")) return "printf";
  if (trimmed.startsWith("lookup ")) return "lookup";
  if (trimmed.startsWith("tpl ")) return "tpl";

  if (trimmed.includes("| quote")) return "quote";
  if (trimmed.includes("|")) return "pipe";

  if (trimmed.startsWith(".Values.")) return "values";
  if (trimmed.startsWith(".Release.")) return "release";
  if (trimmed.startsWith(".Chart.")) return "chart";

  return "other";
}
