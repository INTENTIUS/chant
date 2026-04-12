/**
 * Generic documentation pipeline for lexicons.
 *
 * Reads manifest.json and meta.json from a packaged lexicon's dist/ directory,
 * collects rule metadata from source, and generates structured MDX reference
 * pages. Individual lexicons supply callbacks for provider-specific formatting
 * (service grouping, resource type URLs, custom overview content).
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { expandFileMarkers } from "./docs-file-markers";
import { scanRules, generateRules } from "./docs-rule-scanning";
import { buildSidebar } from "./docs-sidebar";
import { generateOverview, generateIntrinsics, generatePseudoParameters, generateSerialization } from "./docs-sections";
import type { DocsConfig, DocsResult, ManifestJSON, MetaEntry } from "./docs-types";

// Re-export all public types and functions so existing importers continue to work.
export { expandFileMarkers } from "./docs-file-markers";
export type { DocsConfig, DocsResult } from "./docs-types";

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

  let overviewContent = generateOverview(config, manifest, resources, properties, serviceGroups, rules);
  if (config.examplesDir) {
    overviewContent = expandFileMarkers(overviewContent, config.examplesDir);
  }
  pages.set("index.mdx", overviewContent);
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
 * `npm install && npm run build`.
 */
export function writeDocsSite(config: DocsConfig, result: DocsResult): void {
  const outDir = config.outDir;
  const contentDir = join(outDir, "src", "content", "docs");

  // Clear stale generated content and Astro caches so changes are picked up on next build.
  // Only remove files that will be regenerated — preserve hand-written pages.
  for (const filename of result.pages.keys()) {
    const filePath = join(contentDir, filename);
    rmSync(filePath, { force: true });
  }
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
