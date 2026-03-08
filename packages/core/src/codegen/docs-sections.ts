/**
 * Section content generators for lexicon documentation pages.
 *
 * Each function produces a complete MDX page string with frontmatter.
 */

import { escapeMdx } from "./docs-file-markers";
import type { DocsConfig, ManifestJSON, MetaEntry, RuleMeta } from "./docs-types";

export function generateOverview(
  config: DocsConfig,
  manifest: ManifestJSON,
  resources: Map<string, MetaEntry>,
  properties: Map<string, MetaEntry>,
  serviceGroups: Map<string, Map<string, MetaEntry>>,
  rules: RuleMeta[],
): string {
  const lines: string[] = [
    "---",
    `title: "${config.displayName}"`,
    `description: "${config.description}"`,
    "---",
    "",
    config.overview ?? `Reference documentation for the **${config.displayName}** lexicon.`,
    "",
    "## At a Glance",
    "",
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Resources | ${resources.size} |`,
    `| Property types | ${properties.size} |`,
    `| Services | ${serviceGroups.size} |`,
    `| Intrinsic functions | ${manifest.intrinsics?.length ?? 0} |`,
    `| Pseudo-parameters | ${Object.keys(manifest.pseudoParameters ?? {}).length} |`,
    `| Lint rules | ${rules.length} |`,
    "",
    `**Lexicon version:** ${manifest.version}  `,
    `**Namespace:** \`${manifest.namespace ?? manifest.name}\``,
    "",
  ];

  const suppress = new Set(config.suppressPages ?? []);

  // Extra pages listed first in reference links
  if (config.extraPages && config.extraPages.length > 0) {
    for (const page of config.extraPages) {
      if (page.sidebar === false) continue;
      lines.push(`- [${page.title}](./${page.slug})`);
    }
  }

  if (!suppress.has("intrinsics") && manifest.intrinsics && manifest.intrinsics.length > 0) {
    lines.push(
      `- [Intrinsic Functions](./intrinsics) — ${manifest.intrinsics.length} built-in functions`,
    );
  }
  if (
    !suppress.has("pseudo-parameters") &&
    manifest.pseudoParameters &&
    Object.keys(manifest.pseudoParameters).length > 0
  ) {
    lines.push(
      `- [Pseudo-Parameters](./pseudo-parameters) — ${Object.keys(manifest.pseudoParameters).length} pseudo-parameters`,
    );
  }
  const overviewExtraSlugs = new Set((config.extraPages ?? []).map((p) => p.slug));
  if (!suppress.has("rules") && !overviewExtraSlugs.has("lint-rules") && rules.length > 0) {
    lines.push(`- [Lint Rules](./rules) — ${rules.length} rules`);
  }
  if (!suppress.has("serialization")) {
    lines.push(`- [Serialization](./serialization) — output format details`);
  }

  if (config.extraSections) {
    for (const section of config.extraSections) {
      lines.push("", `## ${section.title}`, "", section.content);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function generateIntrinsics(
  config: DocsConfig,
  manifest: ManifestJSON,
): string {
  const intrinsics = manifest.intrinsics!;
  const lines: string[] = [
    "---",
    `title: "Intrinsic Functions"`,
    `description: "Built-in intrinsic functions for the ${config.displayName} lexicon"`,
    "---",
    "",
    `The ${config.displayName} lexicon provides **${intrinsics.length}** intrinsic functions.`,
    "",
    "| Function | Description | Output Key | Tag? |",
    "|----------|-------------|------------|------|",
  ];

  for (const fn of intrinsics) {
    const tag = fn.isTag ? "Yes" : "No";
    lines.push(
      `| \`${fn.name}\` | ${escapeMdx(fn.description ?? "—")} | \`${fn.outputKey ?? fn.name}\` | ${tag} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

export function generatePseudoParameters(
  config: DocsConfig,
  manifest: ManifestJSON,
): string {
  const params = manifest.pseudoParameters!;
  const entries = Object.entries(params);
  const lines: string[] = [
    "---",
    `title: "Pseudo-Parameters"`,
    `description: "Pseudo-parameters available in the ${config.displayName} lexicon"`,
    "---",
    "",
    `The ${config.displayName} lexicon provides **${entries.length}** pseudo-parameters — predefined values available in every stack without explicit declaration.`,
    "",
    "| Name | Value |",
    "|------|-------|",
  ];

  for (const [name, value] of entries) {
    lines.push(`| \`${name}\` | \`${value}\` |`);
  }

  lines.push("");
  return lines.join("\n");
}

export function generateSerialization(config: DocsConfig): string {
  const lines: string[] = [
    "---",
    `title: "Serialization"`,
    `description: "Output format for the ${config.displayName} lexicon"`,
    "---",
    "",
  ];

  if (config.outputFormat) {
    lines.push(config.outputFormat);
  } else {
    lines.push(
      `The ${config.displayName} lexicon serializes resources into its native output format during the build step.`,
      "",
      "See the [Serialization](/serialization/output-formats) guide for general information about output formats in chant.",
    );
  }

  lines.push("");
  return lines.join("\n");
}
