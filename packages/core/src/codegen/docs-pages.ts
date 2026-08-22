/**
 * Authored lexicon doc pages (chant #1731 / #1733).
 *
 * A lexicon's prose lives as `.mdx` files under `lexicons/<name>/docs/pages/`.
 * Each carries a `diataxis` frontmatter field naming its Diátaxis quadrant
 * (https://diataxis.fr). The pipeline expands `{{file:...}}` markers, stamps a
 * provenance marker and writes the result into `src/content/docs/`, and the
 * sidebar is grouped from the field. This replaces the two older modes — prose
 * inside `docs.ts` template literals (`extraPages`) and hand-written content
 * pages wired through `sidebarExtra` — which are still read but deprecated.
 *
 * Frontmatter recognised here, on top of Starlight's `title` / `description`:
 *
 * - `diataxis`: `tutorial | how-to | reference | explanation`. Required.
 * - `label`: sidebar label; defaults to `title`.
 * - `group`: a nested subgroup label inside the quadrant (e.g. "Vendor Composites").
 * - `order`: number; lower sorts first within its group. Unordered pages follow, by label.
 * - `hidden`: `true` keeps the page out of the sidebar (reachable by URL only).
 *
 * `group` / `order` / `hidden` / `label` are stripped from the written copy so
 * Starlight's schema never sees them; `diataxis` stays, and the generated
 * `content.config.ts` declares it.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

import { expandFileMarkers } from "./docs-file-markers";
import type { DocsConfig, Quadrant, SidebarPage } from "./docs-types";

export const QUADRANTS: readonly Quadrant[] = ["tutorial", "how-to", "reference", "explanation"];

/** Sidebar group label for each quadrant, in display order. */
export const QUADRANT_LABELS: Record<Quadrant, string> = {
  tutorial: "Tutorials",
  "how-to": "How-to guides",
  reference: "Reference",
  explanation: "Explanation",
};

export interface AuthoredPage extends SidebarPage {
  /** Source file name under `pagesDir`, e.g. `getting-started.mdx`. */
  file: string;
  /** Page body with the rewritten frontmatter, markers expanded. */
  content: string;
}

interface Frontmatter {
  fields: Map<string, string>;
  /** Raw frontmatter lines, in order, so unknown keys survive the rewrite. */
  lines: string[];
  body: string;
}

function parseFrontmatter(text: string, file: string): Frontmatter {
  if (!text.startsWith("---\n")) {
    throw new Error(`${file}: authored doc page must start with a frontmatter block`);
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) throw new Error(`${file}: unterminated frontmatter`);
  const lines = text.slice(4, end).split("\n");
  const fields = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fields.set(m[1], m[2].trim());
  }
  // Skip the closing `---` and the newline after it.
  const afterClose = text.indexOf("\n", end + 1);
  const body = afterClose === -1 ? "" : text.slice(afterClose + 1);
  return { fields, lines, body };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    try {
      return v.startsWith('"') ? (JSON.parse(v) as string) : v.slice(1, -1);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Keys this module consumes and removes from the written page. */
const SIDEBAR_KEYS = new Set(["label", "group", "order", "hidden"]);

/**
 * Read every authored page under `pagesDir`. Returns an empty list when the
 * directory does not exist, which is every lexicon before it migrates.
 */
export function readAuthoredPages(config: DocsConfig): AuthoredPage[] {
  const pagesDir = config.pagesDir ?? join(config.outDir, "pages");
  if (!existsSync(pagesDir)) return [];

  const pages: AuthoredPage[] = [];
  for (const file of readdirSync(pagesDir).sort()) {
    if (!file.endsWith(".mdx") && !file.endsWith(".md")) continue;
    const path = join(pagesDir, file);
    const { fields, lines, body } = parseFrontmatter(readFileSync(path, "utf-8"), path);

    const title = fields.get("title");
    if (!title) throw new Error(`${path}: frontmatter needs a title`);
    const quadrant = fields.get("diataxis");
    if (!quadrant) {
      throw new Error(
        `${path}: frontmatter needs \`diataxis: ${QUADRANTS.join(" | ")}\` (https://diataxis.fr)`,
      );
    }
    if (!QUADRANTS.includes(quadrant as Quadrant)) {
      throw new Error(`${path}: diataxis "${quadrant}" is not one of ${QUADRANTS.join(", ")}`);
    }

    const orderRaw = fields.get("order");
    const order = orderRaw === undefined ? undefined : Number(orderRaw);
    if (order !== undefined && Number.isNaN(order)) {
      throw new Error(`${path}: order must be a number, got "${orderRaw}"`);
    }

    const kept = lines.filter((line) => {
      const key = line.match(/^([A-Za-z_][\w-]*):/)?.[1];
      return !(key && SIDEBAR_KEYS.has(key));
    });
    let content = body;
    if (config.examplesDir) content = expandFileMarkers(content, config.examplesDir);

    pages.push({
      file,
      slug: file.replace(/\.mdx?$/, ""),
      label: unquote(fields.get("label") ?? title),
      quadrant: quadrant as Quadrant,
      group: fields.has("group") ? unquote(fields.get("group") as string) : undefined,
      order,
      hidden: fields.get("hidden") === "true",
      content: ["---", ...kept, "---", "", content].join("\n"),
    });
  }
  return pages;
}
