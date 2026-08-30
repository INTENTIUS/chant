/**
 * Sidebar generation for Starlight docs sites.
 *
 * Grouped by Diátaxis quadrant (https://diataxis.fr), chant #1731. Every page
 * the pipeline knows about — authored under docs/pages/ and generated reference
 * tables — arrives as a {@link SidebarPage} with a quadrant; this module only sorts and nests. Empty quadrants are omitted.
 */

import { QUADRANTS, QUADRANT_LABELS } from "./docs-pages";
import type { DocsConfig, DocsResult, Quadrant, SidebarPage } from "./docs-types";

type Entry = Record<string, unknown>;

function byOrderThenLabel(a: SidebarPage, b: SidebarPage): number {
  const ao = a.order ?? Number.POSITIVE_INFINITY;
  const bo = b.order ?? Number.POSITIVE_INFINITY;
  if (ao !== bo) return ao - bo;
  return a.label.localeCompare(b.label);
}

/**
 * One quadrant's entries: ungrouped pages first (by order, then label), then
 * each nested `group` in order of its lowest-ordered member.
 */
export function quadrantItems(pages: SidebarPage[]): Entry[] {
  const loose = pages.filter((p) => !p.group).sort(byOrderThenLabel);
  const groups = new Map<string, SidebarPage[]>();
  for (const p of pages) {
    if (!p.group) continue;
    const list = groups.get(p.group) ?? [];
    list.push(p);
    groups.set(p.group, list);
  }
  const items: Entry[] = loose.map((p) => ({ label: p.label, slug: p.slug }));
  const grouped = [...groups.entries()]
    .map(([label, members]) => ({ label, members: members.sort(byOrderThenLabel) }))
    .sort((a, b) => byOrderThenLabel(a.members[0], b.members[0]));
  for (const g of grouped) {
    items.push({ label: g.label, items: g.members.map((p) => ({ label: p.label, slug: p.slug })) });
  }
  return items;
}

export function buildSidebar(
  config: DocsConfig,
  result: DocsResult,
): Entry[] {
  // Starlight prepends basePath to every sidebar `link`, so a site-root-relative
  // path like "/chant/" becomes "/chant/lexicons/aws/chant/" — a 404.  Instead
  // we use relative traversal: "../../" is prepended to become
  // "/chant/lexicons/aws/../../" which the browser resolves to "/chant/".
  const segments = (config.basePath ?? "/").replace(/^\/|\/$/g, "").split("/");
  const backLink = segments.length > 1 ? "../".repeat(segments.length - 1) : "/";

  const items: Entry[] = [
    { label: "← chant docs", link: backLink },
    { label: "Overview", slug: "index" },
  ];

  const byQuadrant = new Map<Quadrant, SidebarPage[]>();
  for (const page of result.sidebarPages) {
    if (page.hidden) continue;
    const list = byQuadrant.get(page.quadrant) ?? [];
    list.push(page);
    byQuadrant.set(page.quadrant, list);
  }

  for (const q of QUADRANTS) {
    const pages = byQuadrant.get(q);
    if (!pages || pages.length === 0) continue;
    items.push({ label: QUADRANT_LABELS[q], items: quadrantItems(pages) });
  }

  return items;
}
