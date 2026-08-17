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
  test("build-docs.sh derives which lexicons it builds from the filesystem", () => {
    const script = readFileSync(join(ROOT, "scripts", "build-docs.sh"), "utf-8");

    // Membership comes from the glob. `ORDER` in that script is a sequencing
    // hint — forgejo and gitlab import github's generated surface at prepack
    // time — and a lexicon absent from it is appended, not skipped.
    expect(script).toMatch(/lexicons_with_docs\(\)/);
    expect(script).toMatch(/for d in lexicons\/\*\//);

    // A hardcoded `cd lexicons/<name>` is how the old shape looked. One is a
    // regression; the loop uses a variable.
    const hardcoded = [...script.matchAll(/^\s*cd lexicons\/([a-z0-9]+)\s*$/gm)].map((m) => m[1]);
    expect(
      hardcoded,
      `build-docs.sh hardcodes these lexicons again — a new lexicon's docs would be ` +
        `silently left out of the site, which is #1720`,
    ).toEqual([]);
  });

  test("the ordering hint names only lexicons that exist", () => {
    const script = readFileSync(join(ROOT, "scripts", "build-docs.sh"), "utf-8");
    const order = (script.match(/^ORDER="([^"]*)"/m)?.[1] ?? "").split(/\s+/).filter(Boolean);
    expect(order.length).toBeGreaterThan(0);
    const have = new Set(lexiconsWithDocs());
    const stale = order.filter((lex) => !have.has(lex));
    expect(
      stale,
      `ORDER names lexicons that no longer have a docs site: ${stale.join(", ")}`,
    ).toEqual([]);

    // forgejo's prepack imports lexicons/github/src/generated, so github has to
    // be generated first — the alphabetical order this replaced put forgejo
    // first and died with ERR_MODULE_NOT_FOUND. gitlab imports github too but
    // has always been built before it without complaint, so that edge is not
    // asserted: only the one CI actually proved.
    expect(order.indexOf("github")).toBeLessThan(order.indexOf("forgejo"));
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
