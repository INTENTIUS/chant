import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";

const docsDir = join(import.meta.dir, "..", "..", "docs", "src", "content", "docs");
const docsSource = join(import.meta.dir, "docs.ts");

/**
 * Collect all page slugs from the generated docs directory.
 */
function getPageSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const file of readdirSync(docsDir)) {
    if (file.endsWith(".mdx")) {
      slugs.add(basename(file, ".mdx"));
    }
  }
  return slugs;
}

/**
 * Extract markdown links: [text](href)
 */
function extractMarkdownLinks(content: string): Array<{ text: string; href: string; line: number }> {
  const links: Array<{ text: string; href: string; line: number }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(lines[i])) !== null) {
      const href = match[2];
      if (href.startsWith("http://") || href.startsWith("https://")) continue;
      if (href.startsWith("#")) continue;
      links.push({ text: match[1], href, line: i + 1 });
    }
  }
  return links;
}

/**
 * Check if a relative link target exists as a page slug.
 */
function resolveTarget(href: string, slugs: Set<string>): string | null {
  const pathPart = href.split("#")[0].replace(/\/$/, "");
  if (!pathPart) return null;

  let target: string | undefined;
  if (pathPart.startsWith("./")) target = pathPart.slice(2);
  else if (pathPart.startsWith("../")) target = pathPart.slice(3);
  else if (pathPart.startsWith("/chant/lexicons/aws/")) {
    target = pathPart.replace("/chant/lexicons/aws/", "").replace(/\/$/, "") || "index";
  } else if (!pathPart.includes("/") && !pathPart.startsWith(".")) {
    target = pathPart;
  }

  if (target === undefined) return null;
  return slugs.has(target) ? null : `target page "${target}" does not exist`;
}

describe("docs internal links", () => {
  const slugs = getPageSlugs();

  test("page slugs are discovered", () => {
    expect(slugs.size).toBeGreaterThan(5);
    expect(slugs.has("composites")).toBe(true);
    expect(slugs.has("nested-stacks")).toBe(true);
    expect(slugs.has("index")).toBe(true);
  });

  // Validate generated MDX files
  for (const file of readdirSync(docsDir)) {
    if (!file.endsWith(".mdx")) continue;
    const slug = basename(file, ".mdx");

    test(`${slug}.mdx — internal links resolve to existing pages`, () => {
      const content = readFileSync(join(docsDir, file), "utf-8");
      const links = extractMarkdownLinks(content);
      const errors: string[] = [];
      for (const link of links) {
        const error = resolveTarget(link.href, slugs);
        if (error) errors.push(`line ${link.line}: [${link.text}](${link.href}) — ${error}`);
      }
      if (errors.length > 0) {
        throw new Error(`Broken links in ${file}:\n${errors.join("\n")}`);
      }
    });

    test(`${slug}.mdx — non-index pages use ../ not ./ for cross-page links`, () => {
      if (slug === "index") return;
      const content = readFileSync(join(docsDir, file), "utf-8");
      const links = extractMarkdownLinks(content);
      const errors: string[] = [];
      for (const link of links) {
        const pathPart = link.href.split("#")[0];
        if (pathPart.startsWith("./")) {
          const target = pathPart.slice(2).replace(/\/$/, "");
          if (slugs.has(target)) {
            errors.push(`line ${link.line}: [${link.text}](${link.href}) — use "../${target}/" instead`);
          }
        }
      }
      if (errors.length > 0) {
        throw new Error(`Broken ./ links in non-index page ${file}:\n${errors.join("\n")}`);
      }
    });
  }

  // Validate source docs.ts — catches broken links before regeneration
  test("docs.ts source — cross-page links use ../ not ./", () => {
    const content = readFileSync(docsSource, "utf-8");
    const links = extractMarkdownLinks(content);
    const errors: string[] = [];
    for (const link of links) {
      const pathPart = link.href.split("#")[0];
      // Links in docs.ts extraPages are rendered on non-index pages,
      // so they must use ../ to navigate to sibling pages
      if (pathPart.startsWith("./") && slugs.has(pathPart.slice(2).replace(/\/$/, ""))) {
        errors.push(`line ${link.line}: [${link.text}](${link.href}) — use "../" prefix for cross-page links`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`docs.ts has ./ links that will break on non-index pages:\n${errors.join("\n")}`);
    }
  });

  test("docs.ts source — link targets exist as pages", () => {
    const content = readFileSync(docsSource, "utf-8");
    const links = extractMarkdownLinks(content);
    const errors: string[] = [];
    for (const link of links) {
      const error = resolveTarget(link.href, slugs);
      if (error) errors.push(`line ${link.line}: [${link.text}](${link.href}) — ${error}`);
    }
    if (errors.length > 0) {
      throw new Error(`docs.ts has links to non-existent pages:\n${errors.join("\n")}`);
    }
  });
});
