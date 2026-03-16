/**
 * Sidebar generation for Starlight docs sites.
 */

import type { DocsConfig, DocsResult } from "./docs-types";

export function buildSidebar(
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
      if (page.sidebar === false) continue;
      items.push({ label: page.title, slug: page.slug });
    }
  }

  if (!suppress.has("intrinsics") && !extraSlugs.has("intrinsics") && result.pages.has("intrinsics.mdx")) {
    items.push({ label: "Intrinsics", slug: "intrinsics" });
  }

  if (!suppress.has("pseudo-parameters") && !extraSlugs.has("pseudo-parameters") && result.pages.has("pseudo-parameters.mdx")) {
    items.push({ label: "Pseudo-Parameters", slug: "pseudo-parameters" });
  }

  if (!suppress.has("rules") && !extraSlugs.has("rules") && !extraSlugs.has("lint-rules") && result.pages.has("rules.mdx")) {
    items.push({ label: "Lint Rules", slug: "rules" });
  }

  if (!suppress.has("serialization") && !extraSlugs.has("serialization") && result.pages.has("serialization.mdx")) {
    items.push({ label: "Serialization", slug: "serialization" });
  }

  // Append raw sidebar entries (supports groups and nested items)
  if (config.sidebarExtra) {
    items.push(...config.sidebarExtra);
  }

  return items;
}
