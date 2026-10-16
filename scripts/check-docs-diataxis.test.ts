import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const SCRIPT = join(import.meta.dirname, "check-docs-diataxis.mjs");

let docs: string;
let content: string;

function page(slug: string, frontmatter: string): void {
  const file = join(content, `${slug}.mdx`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\n\nBody.\n`);
}

function sidebar(items: string): void {
  writeFileSync(
    join(docs, "astro.config.mjs"),
    `export default {\n  integrations: [{ sidebar: [\n${items}\n  ] }],\n};\n`,
  );
}

function run(): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, CHANT_DOCS_DIR: docs },
    encoding: "utf-8",
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), "chant-docs-check-"));
  content = join(docs, "src", "content", "docs");
  mkdirSync(content, { recursive: true });
  page("index", "title: Home");
  page("reference/cli", "title: CLI\ndiataxis: reference");
  sidebar(`    { label: "Reference", items: [{ label: "CLI", slug: "reference/cli" }] },`);
});

afterEach(() => {
  rmSync(docs, { recursive: true, force: true });
});

/**
 * chant #1417 — Starlight has no page auto-discovery, so a page without a
 * sidebar entry is reachable only by typing its URL. Every lexicon site is
 * gated on this by `chant dev check-lexicon`; the main site is gated here.
 * Three orphans (`cli/emulator`, `cli/migrate`, `lint-rules/composition`)
 * shipped before this check existed and were found by reading.
 */
describe("main docs site is gated on sidebar reachability (#1417)", () => {
  test("a fully listed site passes", () => {
    const r = run();
    expect(r.out).not.toContain("violation");
    expect(r.status).toBe(0);
  });

  test("a page with no sidebar entry fails, even with a valid quadrant", () => {
    page("reference/orphan", "title: Orphan\ndiataxis: reference");
    const r = run();
    expect(r.out).toContain("reference/orphan: in no sidebar group");
    expect(r.status).toBe(1);
  });

  test("a page nested under a sub-group is reachable", () => {
    page("reference/deep/page", "title: Deep\ndiataxis: reference");
    sidebar(
      `    { label: "Reference", items: [
        { label: "CLI", slug: "reference/cli" },
        { label: "Deep", items: [{ label: "Page", slug: "reference/deep/page" }] },
      ] },`,
    );
    expect(run().status).toBe(0);
  });

  test("index.mdx is the site root and needs no sidebar entry", () => {
    expect(run().status).toBe(0);
  });

  test("a sidebar entry with no page fails", () => {
    sidebar(
      `    { label: "Reference", items: [
        { label: "CLI", slug: "reference/cli" },
        { label: "Gone", slug: "reference/gone" },
      ] },`,
    );
    const r = run();
    expect(r.out).toContain("reference/gone: sidebar entry has no page");
    expect(r.status).toBe(1);
  });
});

/**
 * chant #3993: every lexicon's docs are a section of the main site. The
 * pipeline writes the pages under lexicons/<name>/ and a _sidebar.json beside
 * them; the config's sidebar calls lexiconGroups(), which the check evaluates
 * with the generated fragments.
 */
describe("lexicon sections", () => {
  function fragment(name: string, group: unknown, hidden: string[] = []): void {
    mkdirSync(join(content, "lexicons", name), { recursive: true });
    writeFileSync(join(content, "lexicons", name, "_sidebar.json"), JSON.stringify({ group, hidden }));
  }

  const fixtureGroup = (quadrant = "How-to guides") => ({
    label: "Fixture",
    collapsed: true,
    items: [
      { label: "Overview", slug: "lexicons/fixture" },
      { label: quadrant, collapsed: true, items: [{ label: "Do", slug: "lexicons/fixture/do" }] },
    ],
  });

  beforeEach(() => {
    page("lexicons/fixture/index", "title: Fixture");
    page("lexicons/fixture/do", "title: Do\ndiataxis: how-to");
    sidebar(
      `    { label: "Reference", items: [{ label: "CLI", slug: "reference/cli" }] },
    { label: "Lexicons", collapsed: true, items: lexiconGroups() },`,
    );
  });

  test("a page in the subgroup its quadrant names passes", () => {
    fragment("fixture", fixtureGroup());
    const r = run();
    expect(r.out).toContain("lexicons: 1 sections");
    expect(r.status).toBe(0);
  });

  test("a page in another quadrant's subgroup fails", () => {
    fragment("fixture", fixtureGroup("Reference"));
    const r = run();
    expect(r.out).toContain('lexicons/fixture/do: diataxis "how-to" but lexicon subgroup "Reference"');
    expect(r.status).toBe(1);
  });

  test("a page the fragment leaves out fails unless it is hidden", () => {
    page("lexicons/fixture/secret", "title: Secret\ndiataxis: reference");
    fragment("fixture", fixtureGroup());
    expect(run().out).toContain("lexicons/fixture/secret: in no sidebar group");
    fragment("fixture", fixtureGroup(), ["lexicons/fixture/secret"]);
    expect(run().status).toBe(0);
  });

  test("--require-lexicons fails when no section was generated", () => {
    rmSync(join(content, "lexicons"), { recursive: true, force: true });
    const r = spawnSync(process.execPath, [SCRIPT, "--require-lexicons"], {
      env: { ...process.env, CHANT_DOCS_DIR: docs },
      encoding: "utf-8",
    });
    expect(r.stdout).toContain("no lexicon sections");
    expect(r.status).toBe(1);
  });
});
