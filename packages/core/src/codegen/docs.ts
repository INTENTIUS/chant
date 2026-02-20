/**
 * Generic documentation pipeline for lexicons.
 *
 * Reads manifest.json and meta.json from a packaged lexicon's dist/ directory,
 * collects rule metadata from source, and generates structured MDX reference
 * pages. Individual lexicons supply callbacks for provider-specific formatting
 * (service grouping, resource type URLs, custom overview content).
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────────────

export interface DocsConfig {
  /** Lexicon name (used for page titles and paths) */
  name: string;
  /** Display name (e.g. "AWS CloudFormation") */
  displayName: string;
  /** Short description of what this lexicon targets */
  description: string;
  /** Path to dist/ directory containing manifest.json and meta.json */
  distDir: string;
  /** Output directory for generated .mdx files */
  outDir: string;
  /** Lexicon-specific overview content (markdown) */
  overview?: string;
  /** Output format description (e.g. "CloudFormation JSON template") */
  outputFormat?: string;
  /** Custom service grouping from resource type (e.g. "AWS::S3::Bucket" → "S3") */
  serviceFromType?: (resourceType: string) => string;
  /** Custom sections to append to overview page */
  extraSections?: Array<{ title: string; content: string }>;
  /** Standalone pages added to the sidebar after Overview */
  extraPages?: Array<{ slug: string; title: string; description?: string; content: string }>;
  /** Slugs of auto-generated pages to suppress (e.g. "pseudo-parameters") */
  suppressPages?: string[];
  /** Source directory for scanning rule files (defaults to srcDir sibling of distDir) */
  srcDir?: string;
  /** Base path for the generated Astro site (e.g. '/lexicons/aws/') */
  basePath?: string;
  /** Root directory for resolving {{file:...}} markers in extra page content */
  examplesDir?: string;
}

export interface DocsResult {
  pages: Map<string, string>;
  stats: {
    resources: number;
    properties: number;
    services: number;
    rules: number;
    intrinsics: number;
  };
}

interface ManifestJSON {
  name: string;
  version: string;
  namespace?: string;
  intrinsics?: Array<{
    name: string;
    description?: string;
    outputKey?: string;
    isTag?: boolean;
  }>;
  pseudoParameters?: Record<string, string>;
}

interface MetaEntry {
  resourceType: string;
  kind: "resource" | "property";
  lexicon: string;
  attrs?: Record<string, string>;
  propertyConstraints?: Record<string, unknown>;
  createOnly?: string[];
  writeOnly?: string[];
  primaryIdentifier?: string[];
}

interface RuleMeta {
  id: string;
  severity: string;
  category: string;
  description: string;
  type: "lint" | "post-synth";
}

// ── File marker interpolation ──────────────────────────────────────

/**
 * Expand `{{file:path.ts}}` markers in content with fenced code blocks.
 *
 * Supported forms:
 * - `{{file:path.ts}}` — full file
 * - `{{file:path.ts:5-12}}` — lines 5–12 (1-based, inclusive)
 * - `{{file:path.ts|title=custom.ts}}` — override the code block title
 * - `{{file:path.ts:5-12|title=custom.ts}}` — both
 */
export function expandFileMarkers(content: string, examplesDir: string): string {
  return content.replace(
    /\{\{file:([^}]+)\}\}/g,
    (_match, spec: string) => {
      // Parse options after |
      let filePart = spec;
      let title: string | undefined;
      const pipeIdx = spec.indexOf("|");
      if (pipeIdx !== -1) {
        filePart = spec.substring(0, pipeIdx);
        const opts = spec.substring(pipeIdx + 1);
        const titleMatch = opts.match(/title=([^\s|]+)/);
        if (titleMatch) title = titleMatch[1];
      }

      // Parse line range after :digits-digits at end of filePart
      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      const rangeMatch = filePart.match(/^(.+):(\d+)-(\d+)$/);
      if (rangeMatch) {
        filePart = rangeMatch[1];
        lineStart = parseInt(rangeMatch[2], 10);
        lineEnd = parseInt(rangeMatch[3], 10);
      }

      const filePath = join(examplesDir, filePart);
      let fileContent: string;
      try {
        fileContent = readFileSync(filePath, "utf-8");
      } catch {
        throw new Error(`File marker {{file:${spec}}} — file not found: ${filePath}`);
      }

      // Extract line range if specified
      if (lineStart !== undefined && lineEnd !== undefined) {
        const lines = fileContent.split("\n");
        fileContent = lines.slice(lineStart - 1, lineEnd).join("\n");
      }

      // Determine language from extension
      const ext = filePart.substring(filePart.lastIndexOf(".") + 1);
      const lang = ext === "ts" || ext === "tsx" ? "typescript" : ext;
      const displayTitle = title ?? filePart.substring(filePart.lastIndexOf("/") + 1);

      return `\`\`\`${lang} title="${displayTitle}"\n${fileContent.trimEnd()}\n\`\`\``;
    },
  );
}

// ── Pipeline ───────────────────────────────────────────────────────

/**
 * Run the documentation pipeline with the supplied config.
 */
export function docsPipeline(config: DocsConfig): DocsResult {
  const manifest = JSON.parse(
    readFileSync(join(config.distDir, "manifest.json"), "utf-8"),
  ) as ManifestJSON;

  const meta = JSON.parse(
    readFileSync(join(config.distDir, "meta.json"), "utf-8"),
  ) as Record<string, MetaEntry>;

  const rules = scanRules(config.srcDir ?? join(config.distDir, "..", "src"));

  // Separate resources and properties
  const resources = new Map<string, MetaEntry>();
  const properties = new Map<string, MetaEntry>();
  for (const [className, entry] of Object.entries(meta)) {
    if (entry.kind === "resource") {
      resources.set(className, entry);
    } else {
      properties.set(className, entry);
    }
  }

  // Group resources by service
  const serviceFromType =
    config.serviceFromType ?? ((t: string) => t.split("::")[1] ?? "Other");
  const serviceGroups = new Map<string, Map<string, MetaEntry>>();
  for (const [className, entry] of resources) {
    const service = serviceFromType(entry.resourceType);
    let group = serviceGroups.get(service);
    if (!group) {
      group = new Map();
      serviceGroups.set(service, group);
    }
    group.set(className, entry);
  }

  // Generate pages
  const pages = new Map<string, string>();

  pages.set(
    "index.mdx",
    generateOverview(config, manifest, resources, properties, serviceGroups, rules),
  );
  const suppress = new Set(config.suppressPages ?? []);

  // Extra pages from lexicon config
  if (config.extraPages) {
    for (const page of config.extraPages) {
      let content = page.content;
      if (config.examplesDir) {
        content = expandFileMarkers(content, config.examplesDir);
      }
      pages.set(
        `${page.slug}.mdx`,
        [
          "---",
          `title: "${page.title}"`,
          page.description ? `description: "${page.description}"` : "",
          "---",
          "",
          content,
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  if (!suppress.has("intrinsics") && manifest.intrinsics && manifest.intrinsics.length > 0) {
    pages.set("intrinsics.mdx", generateIntrinsics(config, manifest));
  }

  if (
    !suppress.has("pseudo-parameters") &&
    manifest.pseudoParameters &&
    Object.keys(manifest.pseudoParameters).length > 0
  ) {
    pages.set(
      "pseudo-parameters.mdx",
      generatePseudoParameters(config, manifest),
    );
  }

  if (!suppress.has("rules") && rules.length > 0) {
    pages.set("rules.mdx", generateRules(config, rules));
  }

  if (!suppress.has("serialization")) {
    pages.set("serialization.mdx", generateSerialization(config));
  }

  return {
    pages,
    stats: {
      resources: resources.size,
      properties: properties.size,
      services: serviceGroups.size,
      rules: rules.length,
      intrinsics: manifest.intrinsics?.length ?? 0,
    },
  };
}

/**
 * Write generated docs pages to disk.
 */
export function writeDocsPages(result: DocsResult, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const [filename, content] of result.pages) {
    const filePath = join(outDir, filename);
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content);
  }
}

/**
 * Scaffold a standalone Starlight docs site from pipeline results.
 *
 * Writes: package.json, astro.config.mjs, tsconfig.json, and all content
 * pages under src/content/docs/. The resulting directory can be built with
 * `bun install && bun run build`.
 */
export function writeDocsSite(config: DocsConfig, result: DocsResult): void {
  const outDir = config.outDir;
  const contentDir = join(outDir, "src", "content", "docs");

  // Clear stale content and Astro caches so changes are picked up on next build
  rmSync(contentDir, { recursive: true, force: true });
  rmSync(join(outDir, ".astro"), { recursive: true, force: true });
  rmSync(join(outDir, "node_modules", ".astro"), { recursive: true, force: true });

  // Write content pages
  writeDocsPages(result, contentDir);

  // Build sidebar from generated pages
  const sidebar = buildSidebar(config, result);

  // package.json
  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify(
      {
        name: `@intentius/chant-lexicon-${config.name}-docs`,
        type: "module",
        version: "0.0.1",
        private: true,
        scripts: {
          dev: "astro dev",
          build: "astro build",
          preview: "astro preview",
        },
        dependencies: {
          "@astrojs/starlight": "^0.37.6",
          astro: "^5.6.1",
          sharp: "^0.34.2",
        },
      },
      null,
      2,
    ) + "\n",
  );

  // tsconfig.json
  writeFileSync(
    join(outDir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: "astro/tsconfigs/strict",
        include: [".astro/types.d.ts", "**/*"],
        exclude: ["dist"],
      },
      null,
      2,
    ) + "\n",
  );

  // src/content.config.ts (required by Astro 5+ / Starlight 0.37+)
  mkdirSync(join(outDir, "src"), { recursive: true });
  writeFileSync(
    join(outDir, "src", "content.config.ts"),
    `import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
`,
  );

  // astro.config.mjs
  writeFileSync(
    join(outDir, "astro.config.mjs"),
    `// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({${config.basePath ? `\n  base: '${config.basePath}',` : ""}
  integrations: [
    starlight({
      title: '${config.displayName}',
      sidebar: ${JSON.stringify(sidebar, null, 6).replace(/\n/g, "\n      ")},
    }),
  ],
});
`,
  );
}

function buildSidebar(
  config: DocsConfig,
  result: DocsResult,
): Array<Record<string, unknown>> {
  // Starlight prepends basePath to every sidebar `link`, so a site-root-relative
  // path like "/chant/" becomes "/chant/lexicons/aws/chant/" — a 404.  Instead
  // we use relative traversal: "../../" is prepended to become
  // "/chant/lexicons/aws/../../" which the browser resolves to "/chant/".
  const segments = (config.basePath ?? "/").replace(/^\/|\/$/g, "").split("/");
  const backLink = segments.length > 1 ? "../".repeat(segments.length - 1) : "/";

  const items: Array<Record<string, unknown>> = [
    { label: "← chant docs", link: backLink },
    { label: "Overview", slug: "index" },
  ];

  const suppress = new Set(config.suppressPages ?? []);
  const extraSlugs = new Set((config.extraPages ?? []).map((p) => p.slug));

  // Extra pages from lexicon config (appear after Overview)
  if (config.extraPages) {
    for (const page of config.extraPages) {
      items.push({ label: page.title, slug: page.slug });
    }
  }

  if (!suppress.has("intrinsics") && !extraSlugs.has("intrinsics") && result.pages.has("intrinsics.mdx")) {
    items.push({ label: "Intrinsics", slug: "intrinsics" });
  }

  if (!suppress.has("pseudo-parameters") && !extraSlugs.has("pseudo-parameters") && result.pages.has("pseudo-parameters.mdx")) {
    items.push({ label: "Pseudo-Parameters", slug: "pseudo-parameters" });
  }

  if (!suppress.has("rules") && !extraSlugs.has("rules") && result.pages.has("rules.mdx")) {
    items.push({ label: "Lint Rules", slug: "rules" });
  }

  if (!suppress.has("serialization") && !extraSlugs.has("serialization") && result.pages.has("serialization.mdx")) {
    items.push({ label: "Serialization", slug: "serialization" });
  }

  return items;
}

// ── Page generators ────────────────────────────────────────────────

function generateOverview(
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
  if (!suppress.has("rules") && rules.length > 0) {
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

function generateIntrinsics(
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
      `| \`${fn.name}\` | ${fn.description ?? "—"} | \`${fn.outputKey ?? fn.name}\` | ${tag} |`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function generatePseudoParameters(
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

function generateRules(config: DocsConfig, rules: RuleMeta[]): string {
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
        `| \`${rule.id}\` | ${rule.severity} | ${rule.category} | ${rule.description} |`,
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
      lines.push(`| \`${rule.id}\` | ${rule.description} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateSerialization(config: DocsConfig): string {
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

// ── Rule scanning ──────────────────────────────────────────────────

/**
 * Scan lint rule and post-synth check source files to extract metadata.
 * Uses regex to find id, severity, category, and description from source.
 */
function scanRules(srcDir: string): RuleMeta[] {
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
