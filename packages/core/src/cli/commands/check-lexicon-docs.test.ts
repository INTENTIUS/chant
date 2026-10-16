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

/**
 * chant #3993: inside the chant repository a lexicon's pages are generated
 * into the main docs site with a _sidebar.json beside them, and the audit
 * reads those instead of a docs app the lexicon no longer has.
 */
describe("auditDocsReachability for a section of the main site", () => {
  function mainSite(): void {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "package.json"), JSON.stringify({ name: "@intentius/chant-docs" }));
    writeFileSync(join(dir, "docs", "astro.config.mjs"), "export default {};\n");
  }

  function repoWithSection(pages: string[], group: unknown, hidden: string[] = []): string {
    mainSite();
    const section = join(dir, "docs", "src", "content", "docs", "lexicons", "fixture");
    mkdirSync(section, { recursive: true });
    for (const page of pages) writeFileSync(join(section, `${page}.mdx`), "body\n");
    writeFileSync(join(section, "_sidebar.json"), JSON.stringify({ group, hidden }));
    const lex = join(dir, "lexicons", "fixture");
    mkdirSync(join(lex, "docs", "pages"), { recursive: true });
    return lex;
  }

  test("every page in the fragment, or hidden by it, is reachable", () => {
    const lex = repoWithSection(
      ["index", "start", "secret"],
      {
        label: "Fixture",
        items: [
          { label: "Overview", slug: "lexicons/fixture" },
          { label: "Tutorials", items: [{ label: "Start", slug: "lexicons/fixture/start" }] },
        ],
      },
      ["lexicons/fixture/secret"],
    );
    expect(auditDocsReachability(lex)).toEqual({ hasSite: true, pages: ["index", "secret", "start"], unreachable: [] });
  });

  test("a page the fragment does not name is unreachable", () => {
    const lex = repoWithSection(["index", "orphan"], { label: "Fixture", items: [{ label: "Overview", slug: "lexicons/fixture" }] });
    expect(auditDocsReachability(lex).unreachable).toEqual(["orphan"]);
  });

  test("before the section is generated there is nothing to audit", () => {
    mainSite();
    const lex = join(dir, "lexicons", "fixture");
    mkdirSync(lex, { recursive: true });
    expect(auditDocsReachability(lex).hasSite).toBe(false);
  });
});
