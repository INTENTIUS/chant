import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { docsPipeline, writeDocsSite } from "./docs";
import { DOCS_SITE_DEPENDENCIES, findChantDocsSite, rebaseImports, resolveDocsMode } from "./docs-in-site";
import type { DocsConfig } from "./docs-types";

/**
 * chant #3993: inside the chant repository a lexicon's docs are a section of
 * the main Starlight site. These run against a fake repository (a `docs/`
 * whose package.json is the chant docs package) with one lexicon under it.
 */

let repo: string;
let lex: string;

function config(overrides: Partial<DocsConfig> = {}): DocsConfig {
  return {
    name: "fixture",
    displayName: "Fixture",
    description: "fixture lexicon",
    distDir: join(lex, "dist"),
    outDir: join(lex, "docs"),
    srcDir: join(lex, "src"),
    basePath: "/chant/lexicons/fixture/",
    ...overrides,
  };
}

function page(name: string, frontmatter: string, body = "Body.\n"): void {
  mkdirSync(join(lex, "docs", "pages"), { recursive: true });
  writeFileSync(join(lex, "docs", "pages", name), `---\n${frontmatter}\n---\n\n${body}`);
}

const section = () => join(repo, "docs", "src", "content", "docs", "lexicons", "fixture");

beforeEach(() => {
  vi.stubEnv("CHANT_DOCS_MODE", "");
  vi.stubEnv("CHANT_DOCS_SITE", "");
  repo = mkdtempSync(join(tmpdir(), "chant-docs-in-site-"));
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "package.json"), JSON.stringify({ name: "@intentius/chant-docs" }));
  writeFileSync(join(repo, "docs", "astro.config.mjs"), "export default {};\n");
  lex = join(repo, "lexicons", "fixture");
  mkdirSync(join(lex, "dist"), { recursive: true });
  mkdirSync(join(lex, "src"), { recursive: true });
  writeFileSync(
    join(lex, "dist", "manifest.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", intrinsics: [{ name: "ref", description: "a ref" }] }),
  );
  writeFileSync(join(lex, "dist", "meta.json"), JSON.stringify({}));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(repo, { recursive: true, force: true });
});

describe("which mode writeDocsSite runs in", () => {
  test("a lexicon inside the chant repository goes in-site", () => {
    expect(findChantDocsSite(lex)).toBe(join(repo, "docs"));
    expect(resolveDocsMode(config())).toEqual({ mode: "in-site", siteDir: join(repo, "docs") });
  });

  test("a docs site that is not chant's does not count", () => {
    writeFileSync(join(repo, "docs", "package.json"), JSON.stringify({ name: "someone-elses-docs" }));
    expect(findChantDocsSite(lex)).toBeUndefined();
    expect(resolveDocsMode(config()).mode).toBe("standalone");
  });

  test("config.mode and CHANT_DOCS_MODE override the detection", () => {
    expect(resolveDocsMode(config({ mode: "standalone" })).mode).toBe("standalone");
    vi.stubEnv("CHANT_DOCS_MODE", "standalone");
    expect(resolveDocsMode(config()).mode).toBe("standalone");
  });

  test("in-site mode with no main site to write into is an error", () => {
    rmSync(join(repo, "docs"), { recursive: true });
    expect(() => resolveDocsMode(config({ mode: "in-site" }))).toThrow(/in-site mode needs the chant docs site/);
  });
});

describe("in-site mode", () => {
  test("writes pages and a sidebar fragment into the main site, and no app files", () => {
    page("start.mdx", "title: Start\ndiataxis: tutorial");
    page("secret.mdx", "title: Secret\ndiataxis: reference\nhidden: true");
    const cfg = config();
    writeDocsSite(cfg, docsPipeline(cfg));

    for (const f of ["index.mdx", "start.mdx", "secret.mdx", "intrinsics.mdx", "serialization.mdx"]) {
      expect(existsSync(join(section(), f)), f).toBe(true);
    }
    for (const f of ["package.json", "astro.config.mjs", "tsconfig.json", "src"]) {
      expect(existsSync(join(lex, "docs", f)), f).toBe(false);
    }

    const fragment = JSON.parse(readFileSync(join(section(), "_sidebar.json"), "utf-8"));
    expect(fragment.hidden).toEqual(["lexicons/fixture/secret"]);
    expect(fragment.group.label).toBe("Fixture");
    expect(fragment.group.collapsed).toBe(true);
    expect(fragment.group.items.map((i: { label: string }) => i.label)).toEqual(["Overview", "Tutorials", "Reference"]);
    expect(fragment.group.items[0]).toEqual({ label: "Overview", slug: "lexicons/fixture" });
    expect(fragment.group.items[1]).toEqual({
      label: "Tutorials",
      collapsed: true,
      items: [{ label: "Start", slug: "lexicons/fixture/start" }],
    });
  });

  test("generated reference tables get the diataxis field their sidebar group names", () => {
    const cfg = config();
    writeDocsSite(cfg, docsPipeline(cfg));
    expect(readFileSync(join(section(), "intrinsics.mdx"), "utf-8")).toMatch(/^---\n[\s\S]*\ndiataxis: reference\n---/);
    expect(readFileSync(join(section(), "index.mdx"), "utf-8")).not.toContain("diataxis:");
  });

  test("a page the pipeline stops emitting is gone after the next run", () => {
    page("start.mdx", "title: Start\ndiataxis: tutorial");
    const cfg = config();
    writeDocsSite(cfg, docsPipeline(cfg));
    rmSync(join(lex, "docs", "pages", "start.mdx"));
    writeDocsSite(cfg, docsPipeline(cfg));
    expect(existsSync(join(section(), "start.mdx"))).toBe(false);
  });

  test("a page's import of the app's Diagram component points at the main site's", () => {
    page("concepts.mdx", "title: Concepts\ndiataxis: explanation", "import Diagram from '../../components/Diagram.astro';\n\n<Diagram name=\"x\" alt=\"x\" />\n");
    const cfg = config();
    writeDocsSite(cfg, docsPipeline(cfg));
    expect(readFileSync(join(section(), "concepts.mdx"), "utf-8")).toContain(
      "import Diagram from '../../../../components/Diagram.astro';",
    );
  });
});

describe("rebaseImports", () => {
  test("re-points relative imports and leaves code fences and packages alone", () => {
    const outDir = "/r/lexicons/x/docs";
    const pageDir = "/r/docs/src/content/docs/lexicons/x";
    const src = [
      "import { Aside } from '@astrojs/starlight/components';",
      "import raw from '../../../../examples/a.ts?raw';",
      "```ts",
      "import { y } from '../src/y';",
      "```",
    ].join("\n");
    expect(rebaseImports(src, { outDir, siteDir: "/r/docs", pageDir }).split("\n")).toEqual([
      "import { Aside } from '@astrojs/starlight/components';",
      "import raw from '../../../../../../lexicons/x/examples/a.ts?raw';",
      "```ts",
      "import { y } from '../src/y';",
      "```",
    ]);
  });
});

describe("standalone docs app pins", () => {
  test("match the main docs site's Starlight and Astro", () => {
    const docsPkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "docs", "package.json"), "utf-8"));
    for (const dep of ["@astrojs/starlight", "astro", "sharp"]) {
      expect(DOCS_SITE_DEPENDENCIES[dep], dep).toBe(docsPkg.dependencies[dep]);
    }
  });
});
