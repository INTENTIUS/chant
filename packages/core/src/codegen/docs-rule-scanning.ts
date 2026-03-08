/**
 * Rule scanning and rule page generation for lexicon documentation.
 *
 * Scans lint rule and post-synth check source files to extract metadata,
 * and generates an MDX page listing them.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";

import { escapeMdx } from "./docs-file-markers";
import type { DocsConfig, RuleMeta } from "./docs-types";

/**
 * Scan lint rule and post-synth check source files to extract metadata.
 * Uses regex to find id, severity, category, and description from source.
 */
export function scanRules(srcDir: string): RuleMeta[] {
  const rules: RuleMeta[] = [];

  // Scan lint rules
  scanDir(join(srcDir, "lint", "rules"), "lint", rules);

  // Scan post-synth checks
  scanDir(join(srcDir, "lint", "post-synth"), "post-synth", rules);

  return rules;
}

function scanDir(dir: string, type: "lint" | "post-synth", out: RuleMeta[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (entry === "index.ts") continue;
    // Skip utility files (no rule definitions)
    if (entry === "cf-refs.ts") continue;

    let content: string;
    try {
      content = readFileSync(join(dir, entry), "utf-8");
    } catch {
      continue;
    }

    if (type === "lint") {
      // Extract from LintRule objects: id, severity, category
      const idMatch = content.match(/id:\s*"([^"]+)"/);
      const severityMatch = content.match(/severity:\s*"([^"]+)"/);
      const categoryMatch = content.match(/category:\s*"([^"]+)"/);

      if (idMatch) {
        // Try to get description from JSDoc comment
        const descMatch = content.match(
          new RegExp(`\\*\\s*${idMatch[1]}:\\s*(.+?)\\n`),
        );

        out.push({
          id: idMatch[1],
          severity: severityMatch?.[1] ?? "warning",
          category: categoryMatch?.[1] ?? "general",
          description:
            descMatch?.[1]?.trim() ??
            extractDescriptionFromComment(content, idMatch[1]),
          type: "lint",
        });
      }
    } else {
      // Extract from PostSynthCheck objects: id, description
      const idMatch = content.match(/id:\s*"([^"]+)"/);
      const descMatch = content.match(/description:\s*"([^"]+)"/);

      if (idMatch) {
        out.push({
          id: idMatch[1],
          severity: "error",
          category: "post-synth",
          description: descMatch?.[1] ?? idMatch[1],
          type: "post-synth",
        });
      }
    }
  }
}

function extractDescriptionFromComment(
  content: string,
  ruleId: string,
): string {
  // Try to extract from the first line after the rule ID in JSDoc
  const pattern = new RegExp(
    `${ruleId}[:\\s]+([^\\n]+?)\\n\\s*\\*\\s*\\n\\s*\\*\\s*(.+?)\\n`,
  );
  const match = content.match(pattern);
  if (match) return match[1].trim();

  // Fallback: use text after "ruleId:" in JSDoc
  const simpleMatch = content.match(
    new RegExp(`\\*\\s*${ruleId}:\\s*(.+?)(?:\\n|\\*)`),
  );
  if (simpleMatch) return simpleMatch[1].trim();

  return ruleId;
}

export function generateRules(config: DocsConfig, rules: RuleMeta[]): string {
  const lintRules = rules.filter((r) => r.type === "lint");
  const postSynthRules = rules.filter((r) => r.type === "post-synth");

  const lines: string[] = [
    "---",
    `title: "Lint Rules"`,
    `description: "Lint rules and post-synth checks provided by the ${config.displayName} lexicon"`,
    "---",
    "",
    `The ${config.displayName} lexicon provides **${rules.length}** rules: ${lintRules.length} lint rules and ${postSynthRules.length} post-synth checks.`,
    "",
  ];

  if (lintRules.length > 0) {
    lines.push(
      "## Lint Rules",
      "",
      "| ID | Severity | Category | Description |",
      "|----|----------|----------|-------------|",
    );
    for (const rule of lintRules.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(
        `| \`${rule.id}\` | ${rule.severity} | ${rule.category} | ${escapeMdx(rule.description)} |`,
      );
    }
    lines.push("");
  }

  if (postSynthRules.length > 0) {
    lines.push(
      "## Post-Synth Checks",
      "",
      "Post-synth checks validate the serialized output after the build pipeline completes.",
      "",
      "| ID | Description |",
      "|----|-------------|",
    );
    for (const rule of postSynthRules.sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      lines.push(`| \`${rule.id}\` | ${escapeMdx(rule.description)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
