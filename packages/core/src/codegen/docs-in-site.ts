/**
 * The in-site mode of the lexicon docs pipeline (chant #3993).
 *
 * Inside the chant repository every lexicon's docs are a section of the main
 * Starlight site in `docs/`: one Astro build, one search index, one design.
 * `writeDocsSite` writes a lexicon's pages to
 * `docs/src/content/docs/lexicons/<name>/` and, beside them, `_sidebar.json`,
 * the lexicon's collapsed sidebar group with its Diátaxis subgroups. The main
 * site's `astro.config.mjs` reads every fragment through
 * `docs/src/lexicon-sidebar.mjs`. Nothing else is written: no package.json, no
 * Astro config, no components.
 *
 * Outside the repository (a third-party lexicon, a project scaffolded by
 * `chant init-lexicon`) the pipeline keeps writing a standalone Starlight app
 * into the lexicon's own `docs/`, as it always has.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve, sep } from "path";

import { QUADRANT_LABELS, QUADRANTS } from "./docs-pages";
import { quadrantItems } from "./docs-sidebar";
import type { DocsConfig, DocsResult, Quadrant, SidebarPage } from "./docs-types";

export type DocsSiteMode = "in-site" | "standalone";

/**
 * The dependencies a standalone lexicon docs app installs. They match
 * `docs/package.json`, so a lexicon built on its own renders with the same
 * Starlight and Astro as the main site; a test holds the two together.
 */
export const DOCS_SITE_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@astrojs/starlight": "^0.37.6",
  astro: "5.6.1",
  sharp: "^0.34.2",
};

/** Package name of the main docs site, `docs/package.json` in the chant repository. */
const CHANT_DOCS_PACKAGE = "@intentius/chant-docs";

/**
 * The chant repository's main docs site (`<repo>/docs`) above `start`, or
 * undefined. A directory qualifies when its `docs/package.json` is the chant
 * docs package and `docs/astro.config.mjs` exists beside it, so a third-party
 * repository with a docs site of its own is never mistaken for chant.
 */
export function findChantDocsSite(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const docs = join(dir, "docs");
    const pkg = join(docs, "package.json");
    if (existsSync(pkg) && existsSync(join(docs, "astro.config.mjs"))) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf-8")) as { name?: unknown }).name === CHANT_DOCS_PACKAGE) return docs;
      } catch {
        // Not JSON: not chant's docs site. Keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Which mode `writeDocsSite` runs in, and the main site's directory for
 * in-site mode. `config.mode` wins, then `CHANT_DOCS_MODE`; with neither, a
 * lexicon inside the chant repository goes in-site and any other standalone.
 * `config.siteDir` or `CHANT_DOCS_SITE` names the main site when the walk up
 * from `outDir` would not find it.
 */
export function resolveDocsMode(config: DocsConfig): { mode: DocsSiteMode; siteDir?: string } {
  const env = process.env.CHANT_DOCS_MODE;
  const requested = config.mode ?? (env === "in-site" || env === "standalone" ? env : undefined);
  if (requested === "standalone") return { mode: "standalone" };
  const siteDir = config.siteDir || process.env.CHANT_DOCS_SITE || findChantDocsSite(config.outDir);
  if (requested === "in-site") {
    if (!siteDir) {
      throw new Error(
        `[docs:${config.name}] in-site mode needs the chant docs site: none above ${resolve(config.outDir)}. ` +
          `Set siteDir or CHANT_DOCS_SITE, or use standalone mode.`,
      );
    }
    return { mode: "in-site", siteDir: resolve(siteDir) };
  }
  return siteDir ? { mode: "in-site", siteDir: resolve(siteDir) } : { mode: "standalone" };
}

/** Where a lexicon's section lives inside the main site's content collection. */
export function sectionContentDir(siteDir: string, name: string): string {
  return join(siteDir, "src", "content", "docs", "lexicons", name);
}

/**
 * The lexicon's sidebar group for the main site: the lexicon's display name,
 * collapsed, holding its overview and one collapsed group per non-empty
 * Diátaxis quadrant. Slugs are prefixed with `lexicons/<name>/`.
 */
export function buildSectionGroup(config: DocsConfig, result: DocsResult): Record<string, unknown> {
  const prefix = `lexicons/${config.name}`;
  const byQuadrant = new Map<Quadrant, SidebarPage[]>();
  for (const page of result.sidebarPages) {
    if (page.hidden) continue;
    const list = byQuadrant.get(page.quadrant) ?? [];
    list.push({ ...page, slug: `${prefix}/${page.slug}` });
    byQuadrant.set(page.quadrant, list);
  }
  const items: Array<Record<string, unknown>> = [{ label: "Overview", slug: prefix }];
  for (const q of QUADRANTS) {
    const pages = byQuadrant.get(q);
    if (!pages || pages.length === 0) continue;
    items.push({ label: QUADRANT_LABELS[q], collapsed: true, items: collapseGroups(quadrantItems(pages)) });
  }
  return { label: config.displayName, collapsed: true, items };
}

/** Every nested group starts collapsed, as on the rest of the main site. */
function collapseGroups(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items.map((item) =>
    Array.isArray(item.items)
      ? { label: item.label, collapsed: true, items: collapseGroups(item.items as Array<Record<string, unknown>>) }
      : item,
  );
}

/** Slugs of pages written but kept out of the sidebar, prefixed for the main site. */
export function hiddenSectionSlugs(config: DocsConfig, result: DocsResult): string[] {
  const listed = new Set(result.sidebarPages.map((p) => p.slug));
  return [...result.pages.keys()]
    .map((f) => f.replace(/\.mdx?$/, ""))
    .filter((slug) => slug !== "index" && !listed.has(slug))
    .sort()
    .map((slug) => `lexicons/${config.name}/${slug}`);
}

/**
 * Give a page the `diataxis` field of the quadrant the sidebar files it under,
 * when it has none. Authored pages always carry one; the generated reference
 * tables do not, and the main site's Diátaxis check reads the field.
 */
export function withQuadrant(content: string, quadrant: Quadrant | undefined): string {
  if (!quadrant || !content.startsWith("---\n")) return content;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return content;
  if (/^diataxis:/m.test(content.slice(4, end))) return content;
  return `${content.slice(0, end)}\ndiataxis: ${quadrant}${content.slice(end)}`;
}

const IMPORT_RE = /^(\s*import\s[^'"]*?\sfrom\s+|\s*import\s+)(['"])(\.\.?\/[^'"]+)\2(.*)$/;

/**
 * Re-point a page's relative ESM imports from where the standalone app kept
 * the page (`<outDir>/src/content/docs/`) to where the main site keeps it.
 * An import of the app's own components (`<outDir>/src/components/X`) goes to
 * the main site's `src/components/X`, which holds the one shared copy.
 * Fenced code blocks are left alone; their `import` lines are examples.
 */
export function rebaseImports(content: string, opts: { outDir: string; siteDir: string; pageDir: string }): string {
  const fromDir = join(resolve(opts.outDir), "src", "content", "docs");
  const appComponents = join(resolve(opts.outDir), "src", "components") + sep;
  const siteComponents = join(opts.siteDir, "src", "components");
  let fence: string | null = null;
  return content
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker) {
        if (fence === null) fence = marker[0];
        else if (marker[0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const m = line.match(IMPORT_RE);
      if (!m) return line;
      let target = resolve(fromDir, m[3]);
      if (target.startsWith(appComponents)) target = join(siteComponents, target.slice(appComponents.length));
      let spec = relative(opts.pageDir, target).split(sep).join("/");
      if (!spec.startsWith(".")) spec = `./${spec}`;
      return `${m[1]}${m[2]}${spec}${m[2]}${m[4]}`;
    })
    .join("\n");
}
