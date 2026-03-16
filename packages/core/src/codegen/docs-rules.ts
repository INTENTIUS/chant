/**
 * Rule documentation auto-generation.
 *
 * Generates MDX pages from a RuleEntry registry:
 * - A catalog page with all rules grouped by category
 * - Per-rule detail pages with configuration examples and disable syntax
 */

import type { RuleEntry } from "../lint/rule-registry";

/**
 * Generate a rule catalog MDX page with all rules grouped by category.
 */
export function generateRuleCatalog(
  entries: RuleEntry[],
  displayName = "chant",
): string {
  const lines: string[] = [
    "---",
    `title: "Rule Reference"`,
    `description: "Complete reference of all lint rules and post-synth checks"`,
    "---",
    "",
    `This page lists all **${entries.length}** rules available in ${displayName}.`,
    "",
  ];

  // Group by category
  const byCategory = new Map<string, RuleEntry[]>();
  for (const entry of entries) {
    const cat = entry.category;
    const existing = byCategory.get(cat) ?? [];
    existing.push(entry);
    byCategory.set(cat, existing);
  }

  // Render each category
  const categoryOrder = ["correctness", "security", "style", "performance"];
  const sortedCategories = [...byCategory.keys()].sort(
    (a, b) => (categoryOrder.indexOf(a) ?? 99) - (categoryOrder.indexOf(b) ?? 99),
  );

  for (const cat of sortedCategories) {
    const catEntries = byCategory.get(cat)!;
    const title = cat.charAt(0).toUpperCase() + cat.slice(1);

    lines.push(
      `## ${title}`,
      "",
      "| ID | Description | Severity | Phase | Fix |",
      "|----|-------------|----------|-------|-----|",
    );

    for (const entry of catEntries.sort((a, b) => a.id.localeCompare(b.id))) {
      const fix = entry.hasAutoFix ? "Yes" : "";
      const link = entry.helpUri
        ? `[\`${entry.id}\`](${entry.helpUri})`
        : `\`${entry.id}\``;
      lines.push(
        `| ${link} | ${entry.description} | ${entry.defaultSeverity} | ${entry.phase} | ${fix} |`,
      );
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate a per-rule detail MDX page.
 */
export function generateRuleDetailPage(entry: RuleEntry): string {
  const lines: string[] = [
    "---",
    `title: "${entry.id}: ${entry.description}"`,
    `description: "${entry.description}"`,
    "---",
    "",
    `# ${entry.id}`,
    "",
    entry.description,
    "",
    "| Property | Value |",
    "|----------|-------|",
    `| **ID** | \`${entry.id}\` |`,
    `| **Severity** | ${entry.defaultSeverity} |`,
    `| **Category** | ${entry.category} |`,
    `| **Phase** | ${entry.phase} |`,
    `| **Source** | ${entry.source} |`,
    `| **Auto-fix** | ${entry.hasAutoFix ? "Yes" : "No"} |`,
    "",
  ];

  // Configuration example
  lines.push(
    "## Configuration",
    "",
    "Override severity in your `chant.config.ts`:",
    "",
    "```ts",
    "// chant.config.ts",
    `rules: {`,
    `  "${entry.id}": "warning",  // or "error", "info", "off"`,
    `}`,
    "```",
    "",
  );

  // Disable syntax
  lines.push(
    "## Disabling",
    "",
    "Suppress this rule with inline comments:",
    "",
    "```ts",
    `// chant-disable ${entry.id}`,
    `// ... entire file suppressed for ${entry.id}`,
    "",
    `const x = 1; // chant-disable-line ${entry.id}`,
    "",
    `// chant-disable-next-line ${entry.id} -- reason for suppression`,
    `const y = 2;`,
    "```",
    "",
  );

  return lines.join("\n");
}
