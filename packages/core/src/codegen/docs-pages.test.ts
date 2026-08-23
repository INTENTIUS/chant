import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { readAuthoredPages } from "./docs-pages";
import { docsPipeline, writeDocsSite, GENERATED_MARKER_TAG } from "./docs";
import { buildSidebar, quadrantItems } from "./docs-sidebar";
import type { DocsConfig, DocsResult, SidebarPage } from "./docs-types";

let root: string;

function config(overrides: Partial<DocsConfig> = {}): DocsConfig {
  return {
    name: "fixture",
    displayName: "Fixture",
    description: "fixture lexicon",
    distDir: join(root, "dist"),
    outDir: join(root, "docs"),
    srcDir: join(root, "src"),
    examplesDir: join(root, "examples"),
    basePath: "/chant/lexicons/fixture/",
    ...overrides,
  };
}

function page(name: string, frontmatter: string, body = "Body.\n"): void {
  mkdirSync(join(root, "docs", "pages"), { recursive: true });
  writeFileSync(join(root, "docs", "pages", name), `---\n${frontmatter}\n---\n\n${body}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chant-docs-pages-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "examples"), { recursive: true });
  writeFileSync(
    join(root, "dist", "manifest.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", intrinsics: [{ name: "ref", description: "a ref" }] }),
  );
  writeFileSync(join(root, "dist", "meta.json"), JSON.stringify({}));
  writeFileSync(join(root, "examples", "snippet.ts"), "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readAuthoredPages", () => {
  test("returns nothing when docs/pages/ does not exist", () => {
    expect(readAuthoredPages(config())).toEqual([]);
  });

  test("reads frontmatter, expands file markers, strips sidebar-only keys", () => {
    page(
      "getting-started.mdx",
      'title: "Getting Started"\ndescription: "Start here"\ndiataxis: tutorial\norder: 1\ngroup: "Intro"\nlabel: "Start"\nhidden: false',
      "Before\n\n{{file:snippet.ts}}\n\nAfter\n",
    );
    const [p] = readAuthoredPages(config());
    expect(p.slug).toBe("getting-started");
    expect(p.quadrant).toBe("tutorial");
    expect(p.order).toBe(1);
    expect(p.group).toBe("Intro");
    expect(p.label).toBe("Start");
    expect(p.hidden).toBe(false);
    expect(p.content).toContain('```typescript title="snippet.ts"\nexport const x = 1;\n```');
    expect(p.content).toContain("diataxis: tutorial");
    expect(p.content).not.toMatch(/^(order|group|label|hidden):/m);
    expect(p.content).toContain('title: "Getting Started"');
  });

  test("label defaults to title", () => {
    page("x.mdx", "title: Plain Title\ndiataxis: reference");
    expect(readAuthoredPages(config())[0].label).toBe("Plain Title");
  });

  test("missing diataxis throws with the file path", () => {
    page("untagged.mdx", "title: Untagged");
    expect(() => readAuthoredPages(config())).toThrow(/untagged\.mdx.*diataxis/);
  });

  test("unknown diataxis value throws", () => {
    page("bad.mdx", "title: Bad\ndiataxis: guide");
    expect(() => readAuthoredPages(config())).toThrow(/"guide" is not one of/);
  });
});

describe("docsPipeline with authored pages", () => {
  test("authored page wins a slug collision with a generated page", () => {
    page("intrinsics.mdx", "title: My Intrinsics\ndiataxis: reference", "Hand-written.\n");
    const result = docsPipeline(config());
    expect(result.pages.get("intrinsics.mdx")).toContain("Hand-written.");
    expect(result.sidebarPages.filter((p) => p.slug === "intrinsics")).toHaveLength(1);
  });

  test("generated reference pages land in the reference quadrant after authored ones", () => {
    page("howto.mdx", "title: Do It\ndiataxis: how-to");
    const result = docsPipeline(config());
    const ref = result.sidebarPages.filter((p) => p.quadrant === "reference").map((p) => p.slug);
    expect(ref).toEqual(["intrinsics", "serialization"]);
    expect(result.sidebarPages.find((p) => p.slug === "howto")?.quadrant).toBe("how-to");
  });

  test("hidden pages are written but kept out of the sidebar", () => {
    page("secret.mdx", "title: Secret\ndiataxis: reference\nhidden: true");
    const result = docsPipeline(config());
    expect(result.pages.has("secret.mdx")).toBe(true);
    expect(result.sidebarPages.some((p) => p.slug === "secret")).toBe(false);
  });

  test("authored pages carry a provenance marker naming the source file", () => {
    page("howto.mdx", "title: Do It\ndiataxis: how-to");
    const result = docsPipeline(config());
    const out = result.pages.get("howto.mdx") as string;
    expect(out).toContain(GENERATED_MARKER_TAG);
    expect(out).toContain("docs/pages/howto.mdx");
  });

  test("writeDocsSite reaps the written copy once the source is removed", () => {
    page("howto.mdx", "title: Do It\ndiataxis: how-to");
    const cfg = config();
    writeDocsSite(cfg, docsPipeline(cfg));
    const written = join(root, "docs", "src", "content", "docs", "howto.mdx");
    expect(existsSync(written)).toBe(true);
    rmSync(join(root, "docs", "pages", "howto.mdx"));
    writeDocsSite(cfg, docsPipeline(cfg));
    expect(existsSync(written)).toBe(false);
    const astro = readFileSync(join(root, "docs", "astro.config.mjs"), "utf-8");
    expect(astro).not.toContain("howto");
    const schema = readFileSync(join(root, "docs", "src", "content.config.ts"), "utf-8");
    expect(schema).toContain("diataxis");
  });
});

describe("buildSidebar", () => {
  const sb = (pages: SidebarPage[]) =>
    buildSidebar(config(), { pages: new Map(), sidebarPages: pages, stats: { resources: 0, properties: 0, services: 0, rules: 0, intrinsics: 0 } } satisfies DocsResult);

  test("groups in fixed quadrant order and omits empty quadrants", () => {
    const items = sb([
      { slug: "why", label: "Why", quadrant: "explanation" },
      { slug: "start", label: "Start", quadrant: "tutorial" },
      { slug: "rules", label: "All Rules", quadrant: "reference", order: 1000 },
    ]);
    expect(items.map((i) => i.label)).toEqual(["← chant docs", "Overview", "Tutorials", "Reference", "Explanation"]);
  });

  test("orders by order then label and nests groups after loose pages", () => {
    const items = quadrantItems([
      { slug: "b", label: "Bravo", quadrant: "reference" },
      { slug: "a", label: "Alpha", quadrant: "reference" },
      { slug: "z", label: "Zulu", quadrant: "reference", order: 0 },
      { slug: "eks", label: "EKS", quadrant: "reference", group: "Vendor" },
      { slug: "aks", label: "AKS", quadrant: "reference", group: "Vendor" },
    ]);
    expect(items).toEqual([
      { label: "Zulu", slug: "z" },
      { label: "Alpha", slug: "a" },
      { label: "Bravo", slug: "b" },
      { label: "Vendor", items: [{ label: "AKS", slug: "aks" }, { label: "EKS", slug: "eks" }] },
    ]);
  });
});

/**
 * chant #1377 — `dist/manifest.json` is written by `npm run bundle` (prepack
 * only), so its version is whatever was last bundled on the machine; on one
 * checkout it put the fountain docs two minor versions behind what was
 * already committed. `package.json` is the source of truth, so the rendered
 * version comes from there and the manifest is only a fallback.
 */
describe("lexicon version in generated docs comes from package.json (#1377)", () => {
  test("package.json beside dist/ wins over a stale manifest", () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.37.2" }));
    const index = docsPipeline(config()).pages.get("index.mdx");
    expect(index).toContain("**Lexicon version:** 0.37.2");
    expect(index).not.toContain("0.0.0");
  });

  test("packageJsonPath overrides the default location", () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "package.json"), JSON.stringify({ version: "1.2.3" }));
    const index = docsPipeline(config({ packageJsonPath: join(root, "elsewhere", "package.json") })).pages.get(
      "index.mdx",
    );
    expect(index).toContain("**Lexicon version:** 1.2.3");
  });

  test("falls back to the manifest when no package.json is present", () => {
    const index = docsPipeline(config()).pages.get("index.mdx");
    expect(index).toContain("**Lexicon version:** 0.0.0");
  });
});
