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
