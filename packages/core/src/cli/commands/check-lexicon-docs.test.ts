/**
 * The docs-reachability half of the lexicon completeness contract (#1312).
 *
 * The contract previously judged documentation by counting `.mdx` files, which
 * treats a page nothing links to the same as one a reader can find. These
 * tests pin the behaviour that replaced it.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { auditDocsReachability, sidebarSlugs } from "./check-lexicon-docs";

let dir: string;

function lexicon(pages: string[], configSource: string): string {
  const contentDir = join(dir, "docs", "src", "content", "docs");
  mkdirSync(contentDir, { recursive: true });
  for (const page of pages) writeFileSync(join(contentDir, `${page}.mdx`), "body\n");
  writeFileSync(join(dir, "docs", "astro.config.mjs"), configSource);
  return dir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-docs-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sidebarSlugs", () => {
  test("reads the generator's own double-quoted JSON output", () => {
    expect(sidebarSlugs('{ "label": "A", "slug": "getting-started" }')).toEqual(
      new Set(["getting-started"]),
    );
  });

  test("reads a hand-edited config's single quotes and bare keys", () => {
    // A config may be edited by hand between regens; missing those entries
    // would report a reachable page as unreachable.
    expect(sidebarSlugs("{ slug: 'resources' }, { 'slug': \"skills\" }")).toEqual(
      new Set(["resources", "skills"]),
    );
  });

  test("descends into nested sidebar groups", () => {
    const cfg = `[
      { "label": "Live Cluster", "items": [
        { "label": "The API Client", "slug": "api-client" },
        { "label": "chant kube", "slug": "kube" }
      ]}
    ]`;
    expect(sidebarSlugs(cfg)).toEqual(new Set(["api-client", "kube"]));
  });
});

describe("auditDocsReachability", () => {
  test("a page in no sidebar entry is unreachable", () => {
    const d = lexicon(["index", "getting-started", "skills"], '[{ "slug": "getting-started" }]');
    expect(auditDocsReachability(d).unreachable).toEqual(["skills"]);
  });

  test("index needs no entry — it is the site root", () => {
    const d = lexicon(["index"], "[]");
    expect(auditDocsReachability(d).unreachable).toEqual([]);
  });

  test("a page reached only through a nested group still counts as reachable", () => {
    const d = lexicon(
      ["index", "api-client"],
      '[{ "label": "Live Cluster", "items": [{ "slug": "api-client" }] }]',
    );
    expect(auditDocsReachability(d).unreachable).toEqual([]);
  });

  test("a lexicon with no docs site is not a failure here", () => {
    // Tier 1's "at least 1 .mdx doc page" already covers a missing site;
    // reporting the same absence twice would be noise.
    const audit = auditDocsReachability(dir);
    expect(audit.hasSite).toBe(false);
    expect(audit.unreachable).toEqual([]);
  });

  test("reports every unreachable page, not just the first", () => {
    const d = lexicon(["index", "a", "b", "c"], '[{ "slug": "b" }]');
    expect(auditDocsReachability(d).unreachable).toEqual(["a", "c"]);
  });
});
