import { describe, test, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LEXICONS = join(ROOT, "lexicons");

/** Every lexicon that ships a docs site — the set the unified site must contain. */
function lexiconsWithDocs(): string[] {
  return readdirSync(LEXICONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(LEXICONS, d.name, "docs", "astro.config.mjs")))
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
 * possible — these assert the two things that still can go wrong: a docs site
 * that cannot be placed in the unified tree because it declares no base, and a
 * regression to the hardcoded shape.
 */
describe("unified docs cover every lexicon that has a docs site (#1720)", () => {
  test("build-docs.sh derives the lexicon list rather than listing them", () => {
    const script = readFileSync(join(ROOT, "scripts", "build-docs.sh"), "utf-8");
    expect(script).toMatch(/for lex_dir in lexicons\/\*\//);

    // A hardcoded `cd lexicons/<name>` is how the old shape looked. One is a
    // regression; the loop uses a variable.
    const hardcoded = [...script.matchAll(/^\s*cd lexicons\/([a-z0-9]+)\s*$/gm)].map((m) => m[1]);
    expect(
      hardcoded,
      `build-docs.sh hardcodes these lexicons again — a new lexicon's docs would be ` +
        `silently left out of the site, which is #1720`,
    ).toEqual([]);
  });

  test("every lexicon docs site declares the base its published path needs", () => {
    const missing: string[] = [];
    for (const lex of lexiconsWithDocs()) {
      const config = readFileSync(join(LEXICONS, lex, "docs", "astro.config.mjs"), "utf-8");
      if (!config.includes(`base: '/chant/lexicons/${lex}/'`)) missing.push(lex);
    }
    expect(
      missing,
      `these docs sites do not set base: '/chant/lexicons/<name>/', so every asset and ` +
        `internal link resolves to the wrong path once copied into the unified site:\n  ` +
        missing.join("\n  "),
    ).toEqual([]);
  });
});
