/**
 * Docs reachability audit for the lexicon completeness contract (#1312).
 *
 * The contract used to check documentation by counting files — "at least 1
 * .mdx page" at tier 1, "at least 8" at tier 2 — and never opened one. That
 * counts a page nothing links to exactly the same as a page a reader can
 * actually find, so azure, helm and github each accumulated
 * hand-added pages that appear in no sidebar and are reachable only by typing
 * their URL. Azure's getting-started, resource reference and composites pages
 * were all invisible while its ≥8-page check passed comfortably — the count
 * check was, if anything, rewarded by the orphans.
 *
 * Starlight does not auto-discover pages (see docs/README.md), so sidebar
 * membership is the whole of reachability for a lexicon site.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";

import { collectSidebarSlugs } from "../../codegen/docs";
import { findChantDocsSite, sectionContentDir } from "../../codegen/docs-in-site";

export interface DocsReachability {
  /** Whether this lexicon ships a Starlight site at all. */
  hasSite: boolean;
  /** Every content page slug found on disk, `index` included. */
  pages: string[];
  /** Page slugs no sidebar entry points at, `index` excluded. */
  unreachable: string[];
}

/**
 * Slugs the sidebar reaches, including nested group `items`.
 *
 * Read textually rather than by importing the config: `astro.config.mjs` is an
 * ESM module that imports `@astrojs/starlight`, which a lexicon under check is
 * not required to have installed. The generator emits `JSON.stringify` output
 * (double-quoted), but a hand-edited config may use single quotes or a bare
 * key, so accept all three.
 */
export function sidebarSlugs(configSource: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of configSource.matchAll(/["']?slug["']?\s*:\s*["']([^"']+)["']/g)) {
    slugs.add(match[1]);
  }
  return slugs;
}

/**
 * Audit one lexicon directory for doc pages nothing links to.
 *
 * A lexicon with no docs site is not a failure here — tier 1's "at least 1
 * .mdx doc page" already covers that case, and reporting the same absence
 * twice would just be noise.
 */
export function auditDocsReachability(lexiconDir: string): DocsReachability {
  const contentDir = join(lexiconDir, "docs", "src", "content", "docs");
  const configPath = join(lexiconDir, "docs", "astro.config.mjs");

  if (!existsSync(contentDir) || !existsSync(configPath)) {
    return auditSectionReachability(lexiconDir);
  }

  const slugs = sidebarSlugs(readFileSync(configPath, "utf-8"));
  const pages = readdirSync(contentDir)
    .filter((f) => f.endsWith(".mdx") || f.endsWith(".md"))
    .map((f) => f.replace(/\.mdx?$/, ""))
    .sort();

  // `index` is the site root; Starlight reaches it without a sidebar entry.
  const unreachable = pages.filter((slug) => slug !== "index" && !slugs.has(slug));

  return { hasSite: true, pages, unreachable };
}

export interface DocsClassification {
  /** Whether this lexicon has a docs/pages/ directory at all. */
  hasPages: boolean;
  /** Authored page files under docs/pages/ that lack a valid `diataxis` field. */
  unclassified: string[];
}

const QUADRANTS = new Set(["tutorial", "how-to", "reference", "explanation"]);

/**
 * Audit docs/pages/ for authored pages with no Diátaxis quadrant (#1731).
 *
 * The docs pipeline throws on the same condition, so this is the cheap
 * pre-flight that reports every offender at once instead of the first one.
 */
export function auditDocsClassification(lexiconDir: string): DocsClassification {
  const pagesDir = join(lexiconDir, "docs", "pages");
  if (!existsSync(pagesDir)) return { hasPages: false, unclassified: [] };
  const unclassified: string[] = [];
  for (const file of readdirSync(pagesDir).sort()) {
    if (!file.endsWith(".mdx") && !file.endsWith(".md")) continue;
    const text = readFileSync(join(pagesDir, file), "utf-8");
    const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
    const fm = end === -1 ? "" : text.slice(4, end);
    const value = fm.match(/^diataxis:\s*(.+)$/m)?.[1].trim();
    if (!value || !QUADRANTS.has(value)) unclassified.push(file);
  }
  return { hasPages: true, unclassified };
}

/**
 * Reachability for a lexicon whose docs are a section of the chant main site
 * (chant #3993): its generated pages under
 * `docs/src/content/docs/lexicons/<name>/` against the `_sidebar.json` the
 * pipeline wrote beside them. A page the fragment lists as hidden is
 * deliberately URL-only and does not count. Before the section has been
 * generated there is nothing to audit, which reads as no site, like a
 * lexicon with no docs.
 */
function auditSectionReachability(lexiconDir: string): DocsReachability {
  const site = findChantDocsSite(lexiconDir);
  const name = basename(resolve(lexiconDir));
  const dir = site ? sectionContentDir(site, name) : undefined;
  const fragmentPath = dir ? join(dir, "_sidebar.json") : undefined;
  if (!dir || !fragmentPath || !existsSync(fragmentPath)) return { hasSite: false, pages: [], unreachable: [] };

  const fragment = JSON.parse(readFileSync(fragmentPath, "utf-8")) as {
    group: Record<string, unknown>;
    hidden?: string[];
  };
  const prefix = `lexicons/${name}/`;
  const reached = new Set(
    [...collectSidebarSlugs([fragment.group]), ...(fragment.hidden ?? [])].map((slug) =>
      slug.startsWith(prefix) ? slug.slice(prefix.length) : slug,
    ),
  );
  const pages = readdirSync(dir)
    .filter((f) => f.endsWith(".mdx") || f.endsWith(".md"))
    .map((f) => f.replace(/\.mdx?$/, ""))
    .sort();
  const unreachable = pages.filter((slug) => slug !== "index" && !reached.has(slug));
  return { hasSite: true, pages, unreachable };
}
