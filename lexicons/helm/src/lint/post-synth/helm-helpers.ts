/**
 * Shared helpers for Helm post-synth checks.
 *
 * Provides utilities to extract and parse the Helm chart files
 * from the serializer's SerializerResult output.
 */

import type { SerializerResult } from "@intentius/chant/serializer";
import { getPrimaryOutput } from "@intentius/chant/lint/post-synth";

/**
 * Extract the files map from a serializer output.
 * Returns empty object if output is a plain string.
 */
export function getChartFiles(output: string | SerializerResult): Record<string, string> {
  if (typeof output === "string") return {};
  return output.files ?? {};
}

/**
 * Parse Chart.yaml content into key-value pairs.
 * Lightweight parser — not a full YAML parser.
 */
export function parseChartYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^([a-zA-Z]+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].replace(/^'(.*)'$/, "$1").trim();
    }
  }
  return result;
}

/**
 * Check if a string contains balanced Go template braces.
 */
export function hasBalancedBraces(content: string): boolean {
  let depth = 0;
  for (let i = 0; i < content.length - 1; i++) {
    if (content[i] === "{" && content[i + 1] === "{") {
      depth++;
      i++; // skip next char
    } else if (content[i] === "}" && content[i + 1] === "}") {
      depth--;
      i++;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Extract all Go template expressions from content.
 */
export function extractTemplateExpressions(content: string): string[] {
  const regex = /\{\{-?\s*(.*?)\s*-?\}\}/g;
  const matches: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}
