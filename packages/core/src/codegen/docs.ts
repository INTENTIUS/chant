/**
 * Generic documentation pipeline for lexicons.
 *
 * Reads manifest.json and meta.json from a packaged lexicon's dist/ directory,
 * collects rule metadata from source, and generates structured MDX reference
 * pages. Individual lexicons supply callbacks for provider-specific formatting
 * (service grouping, resource type URLs, custom overview content).
 */

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

import { expandFileMarkers } from "./docs-file-markers";
import { readAuthoredPages } from "./docs-pages";
import { scanRules, generateRules } from "./docs-rule-scanning";
import { buildSidebar } from "./docs-sidebar";
import { generateOverview, generateIntrinsics, generatePseudoParameters, generateSerialization } from "./docs-sections";
import type { DocsConfig, DocsResult, ManifestJSON, MetaEntry, SidebarPage } from "./docs-types";

// Re-export all public types and functions so existing importers continue to work.
export { expandFileMarkers } from "./docs-file-markers";
export type { DocsConfig, DocsResult, Quadrant, SidebarPage } from "./docs-types";
export { QUADRANTS, QUADRANT_LABELS, readAuthoredPages } from "./docs-pages";

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
  const sidebarPages: SidebarPage[] = [];

  // Authored pages under docs/pages/ (#1733). Each names its Diátaxis
  // quadrant; the sidebar is grouped from that. Written with a provenance
  // marker that points back at the source file.
  const authored = readAuthoredPages(config);
  const authoredSources = new Map<string, string>();
  for (const page of authored) {
    pages.set(`${page.slug}.mdx`, page.content);
    authoredSources.set(`${page.slug}.mdx`, page.file);
    if (!page.hidden) sidebarPages.push(page);
  }

  const extraSlugs = new Set([
    ...(config.extraPages ?? []).map((p) => p.slug),
    ...authored.map((p) => p.slug),
  ]);

  // Extra pages from lexicon config. Deprecated in favour of docs/pages/
  // (#1731): prose in a template literal is prose nobody can edit as
  // markdown. Still honoured so a lexicon can migrate page by page.
  if (config.extraPages && config.extraPages.length > 0) {
    console.warn(
      `[docs:${config.name}] extraPages is deprecated — move these ${config.extraPages.length} page(s) to docs/pages/*.mdx with a \`diataxis\` field (chant #1731).`,
    );
    for (const page of config.extraPages) {
      if (authoredSources.has(`${page.slug}.mdx`)) {
        console.warn(`[docs:${config.name}] docs/pages/${page.slug}.mdx overrides the extraPages entry of the same slug.`);
        continue;
      }
      if (page.sidebar !== false) {
        sidebarPages.push({ slug: page.slug, label: page.title, quadrant: "reference" });
      }
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

  // A generated page must not overwrite one the lexicon explicitly declared.
  // The extraPages above are written into `pages` first, so an unguarded
  // `pages.set` below silently discards them: helm declared its own
  // "Intrinsics Reference" and pre-synth rules pages and shipped neither for
  // as long as both slugs collided (#1312). Explicit authorship wins, and the
  // collision is reported rather than resolved in silence.
  const claimed = (slug: string): boolean => {
    if (suppress.has(slug)) return true;
    if (!extraSlugs.has(slug)) return false;
    console.warn(
      `[docs:${config.name}] extraPages declares "${slug}", which is also a generated page — keeping the declared one.\n` +
        `  Add "${slug}" to suppressPages to make that explicit, or rename the extraPage if both are wanted.`,
    );
    return true;
  };

  // Generated reference tables sort after authored reference pages, in the
  // order the old flat sidebar listed them.
  let generatedOrder = 1000;
  const generated = (slug: string, label: string): void => {
    sidebarPages.push({ slug, label, quadrant: "reference", order: generatedOrder++ });
  };

  if (!claimed("intrinsics") && manifest.intrinsics && manifest.intrinsics.length > 0) {
    pages.set("intrinsics.mdx", generateIntrinsics(config, manifest));
    generated("intrinsics", "Intrinsics");
  }

  if (
    !claimed("pseudo-parameters") &&
    manifest.pseudoParameters &&
    Object.keys(manifest.pseudoParameters).length > 0
  ) {
    pages.set(
      "pseudo-parameters.mdx",
      generatePseudoParameters(config, manifest),
    );
    generated("pseudo-parameters", "Pseudo-Parameters");
  }

  // Every lexicon links its generated rules table, whether or not it also
  // ships a prose `lint-rules` page. Skipping it when one existed was how gcp
  // ended up emitting a page nothing pointed at (#1312). The label
  // distinguishes the generated table from a prose page.
  if (!claimed("rules") && rules.length > 0) {
    pages.set("rules.mdx", generateRules(config, rules));
    generated("rules", "All Rules");
  }

  if (!claimed("serialization")) {
    pages.set("serialization.mdx", generateSerialization(config));
    generated("serialization", "Serialization");
  }

  // Stamp every emitted page with its provenance. These files look exactly
  // like the hand-written pages sitting beside them, and without a marker they
  // get edited directly — the k8s "Live Cluster" sidebar group and the AWS
  // intrinsics guide's #1044 claim were both fixed in the emitted `.mdx` and
  // silently reverted by the next regen (#1312).
  for (const [filename, content] of pages) {
    pages.set(filename, withGeneratedMarker(config, content, authoredSources.get(filename)));
  }

  return {
    pages,
    sidebarPages,
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
 * Insert a provenance comment directly after a page's frontmatter.
 *
 * MDX parses `<!-- -->` as JSX rather than a comment, so this uses the
 * `{/* … *\/}` form the rest of the docs already use for generated markers.
 */
function withGeneratedMarker(config: DocsConfig, content: string, source?: string): string {
  const edit = source
    ? `Edit lexicons/${config.name}/docs/pages/${source} instead`
    : `Edit lexicons/${config.name}/src/codegen/docs.ts instead`;
  const marker = `{/* ${GENERATED_MARKER_TAG} by \`npm run docs -w @intentius/chant-lexicon-${config.name}\` — DO NOT EDIT.\n    ${edit}; changes here are overwritten. */}`;
  const lines = content.split("\n");
  // Frontmatter is the leading `---` … `---` block; the marker goes after it.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      lines.splice(close + 1, 0, "", marker);
      return lines.join("\n");
    }
  }
  return `${marker}\n\n${content}`;
}

/**
 * Render the complete rules table for a lexicon that has no {@link docsPipeline}
 * site of its own.
 *
 * The docker lexicon hand-authors its docs, which left its rule table the only
 * one in the repo that could drift from source without anything noticing
 * (#1312). This is the one page worth generating even when the rest of a site
 * is hand-written; the caller writes the result to `rules.mdx` and links it.
 * Returns null when the lexicon declares no rules.
 */
export function generateRulesPage(
  config: DocsConfig,
  srcDir: string,
): string | null {
  const rules = scanRules(srcDir);
  if (rules.length === 0) return null;
  return withGeneratedMarker(config, generateRules(config, rules));
}

/**
 * Marks a page as pipeline output. Used both to warn readers off editing the
 * file and, in {@link writeDocsSite}, to tell a page this pipeline owns from a
 * hand-written one when reaping pages it no longer emits.
 */
export const GENERATED_MARKER_TAG = "GENERATED-BY-CHANT-DOCS";

/**
 * Every slug a Starlight sidebar reaches, including nested group items.
 */
export function collectSidebarSlugs(items: Array<Record<string, unknown>>): Set<string> {
  const slugs = new Set<string>();
  const walk = (list: Array<Record<string, unknown>>): void => {
    for (const item of list) {
      if (typeof item.slug === "string") slugs.add(item.slug);
      if (Array.isArray(item.items)) walk(item.items as Array<Record<string, unknown>>);
    }
  };
  walk(items);
  return slugs;
}

/**
 * Content pages that no sidebar entry points at.
 *
 * `index` is always the site root and never needs an entry of its own.
 */
export function unreachablePages(
  contentDir: string,
  sidebar: Array<Record<string, unknown>>,
): string[] {
  if (!existsSync(contentDir)) return [];
  const slugs = collectSidebarSlugs(sidebar);
  return readdirSync(contentDir)
    .filter((f) => f.endsWith(".mdx") || f.endsWith(".md"))
    .map((f) => f.replace(/\.mdx?$/, ""))
    .filter((slug) => slug !== "index" && !slugs.has(slug))
    .sort();
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

  // Reap pages this pipeline used to emit and no longer does. Suppressing a
  // page only stops it being written; the copy from the last run stayed on
  // disk, unreferenced by the sidebar and indistinguishable from a
  // hand-written page — which is how azure, gcp and helm each kept a `rules`
  // page after adopting their own (#1312). The provenance marker is what makes
  // this safe: only a file this pipeline stamped is ever removed.
  if (existsSync(contentDir)) {
    for (const filename of readdirSync(contentDir)) {
      if (!filename.endsWith(".mdx") && !filename.endsWith(".md")) continue;
      if (result.pages.has(filename)) continue;
      const filePath = join(contentDir, filename);
      if (readFileSync(filePath, "utf-8").includes(GENERATED_MARKER_TAG)) {
        rmSync(filePath, { force: true });
      }
    }
  }
  rmSync(join(outDir, ".astro"), { recursive: true, force: true });
  rmSync(join(outDir, "node_modules", ".astro"), { recursive: true, force: true });

  // Write content pages
  writeDocsPages(result, contentDir);

  // Build sidebar from generated pages
  const sidebar = buildSidebar(config, result);

  // Starlight does not auto-discover pages, so a page absent from the sidebar
  // is reachable only by typing its URL. The pipeline deliberately preserves
  // hand-written pages it did not emit (above), which makes it easy to add one
  // and never wire it up — azure, temporal, helm and github each accumulated
  // several that way (#1312). Report them; `chant dev check-lexicon` gates on
  // the same condition.
  const unreachable = unreachablePages(contentDir, sidebar);
  if (unreachable.length > 0) {
    console.warn(
      `[docs:${config.name}] ${unreachable.length} page(s) in no sidebar entry — reachable only by direct URL: ${unreachable.join(", ")}.\n` +
        `  Move them to docs/pages/ with a \`diataxis\` field to surface them (chant #1731).`,
    );
  }

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
    `import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        // Diátaxis quadrant (https://diataxis.fr), chant #1731.
        diataxis: z.enum(['tutorial', 'how-to', 'reference', 'explanation']).optional(),
      }),
    }),
  }),
};
`,
  );

  // src/rehype-base-url.mjs — copied from chant core so Astro can import it
  // without the generated docs site needing a workspace dep on @intentius/chant.
  const pluginSrcPath = fileURLToPath(
    new URL("./rehype-base-url.mjs", import.meta.url),
  );
  copyFileSync(pluginSrcPath, join(outDir, "src", "rehype-base-url.mjs"));

  // astro.config.mjs
  const rehypeLine = config.basePath
    ? `\n  markdown: {\n    rehypePlugins: [[rehypeBaseUrl, { base: '${config.basePath}', projectBase: '/chant' }]],\n  },`
    : "";
  writeFileSync(
    join(outDir, "astro.config.mjs"),
    `// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseUrl from './src/rehype-base-url.mjs';

export default defineConfig({${config.basePath ? `\n  base: '${config.basePath}',` : ""}${rehypeLine}
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
