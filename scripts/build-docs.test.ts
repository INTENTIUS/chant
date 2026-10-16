import { describe, test, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LEXICONS = join(ROOT, "lexicons");
const SCRIPT = readFileSync(join(ROOT, "scripts", "build-docs.sh"), "utf-8");

/** Every lexicon with docs: the ones whose section the site must contain. */
function lexiconsWithDocs(): string[] {
  return readdirSync(LEXICONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(LEXICONS, d.name, "src", "codegen", "docs-cli.ts")))
    .map((d) => d.name)
    .sort();
}

/**
 * chant #1720 — `scripts/build-docs.sh` used to carry one hardcoded
 * `cd`/`prepack`/`build`/`cp` block per lexicon, thirteen of them, and k3d and
 * k3s were simply not among them. Both have a complete docs tree; neither was
 * ever built, so `/chant/lexicons/k3d/` 404'd on the published site and lychee
 * failed any page linking to it. Nobody noticed because nothing linked to it
 * until a tutorial tried.
 *
 * The script derives its list from the filesystem now, so absence is not
 * possible — these assert the things that still can go wrong.
 */
describe("unified docs cover every lexicon that has docs (#1720)", () => {
  test("build-docs.sh derives which lexicons it generates from the filesystem", () => {
    // Membership comes from the glob. AFTER is a sequencing hint (forgejo's
    // bundle imports github's generated surface) and a lexicon absent from it
    // gets a job of its own, not skipped.
    expect(SCRIPT).toMatch(/lexicons_with_docs\(\)/);
    expect(SCRIPT).toMatch(/for d in lexicons\/\*\//);

    // A hardcoded `cd lexicons/<name>` is how the old shape looked. One is a
    // regression; the loop uses a variable.
    const hardcoded = [...SCRIPT.matchAll(/^\s*cd lexicons\/([a-z0-9]+)\s*$/gm)].map((m) => m[1]);
    expect(
      hardcoded,
      `build-docs.sh hardcodes these lexicons again — a new lexicon's docs would be ` +
        `silently left out of the site, which is #1720`,
    ).toEqual([]);
  });

  test("the ordering hint names only lexicons that exist, and runs forgejo after github", () => {
    const after = (SCRIPT.match(/^AFTER="([^"]*)"/m)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const have = new Set(lexiconsWithDocs());
    const stale = after.flatMap((pair) => pair.split(":")).filter((lex) => !have.has(lex));
    expect(stale, `AFTER names lexicons that have no docs: ${stale.join(", ")}`).toEqual([]);

    // forgejo's bundle imports lexicons/github/src/generated; run alone on a
    // clean tree it dies with ERR_MODULE_NOT_FOUND (chant #3993 measured it).
    expect(after).toContain("forgejo:github");
  });
});

/**
 * chant #3993 — every lexicon's docs are a section of the main Starlight site,
 * built by one `astro build` of docs/. The 21 per-lexicon Astro apps are gone.
 */
describe("one docs site (#3993)", () => {
  test("no lexicon ships a docs app of its own", () => {
    const apps = readdirSync(LEXICONS).filter((lex) =>
      ["astro.config.mjs", "package.json", "package-lock.json", "src"].some((f) => existsSync(join(LEXICONS, lex, "docs", f))),
    );
    expect(apps, `these lexicons still carry a docs app under docs/: ${apps.join(", ")}`).toEqual([]);
  });

  test("build-docs.sh runs one Astro build, of docs/", () => {
    expect([...SCRIPT.matchAll(/npm run --prefix docs build/g)]).toHaveLength(1);
    expect(SCRIPT).not.toMatch(/cd docs && npm/);
  });

  test("lexicons generate their pages in-site, from generate and bundle only", () => {
    expect(SCRIPT).toMatch(/CHANT_DOCS_MODE=in-site npx tsx src\/codegen\/docs-cli\.ts/);
    expect(SCRIPT).not.toMatch(/npm run prepack/);
  });
});
