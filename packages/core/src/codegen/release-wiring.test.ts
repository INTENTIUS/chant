/**
 * The release path is two hand-maintained halves that must agree: the
 * justfile recipes that create and push a tag, and publish.yml's tag
 * trigger that decides whether pushing it does anything.
 *
 * They disagreed. `just release-lexicon <name>` has always tagged
 * `lexicon-<name>-v<version>`, pushed it, and echoed "publish workflow
 * triggered" — while publish.yml matched only `chant-v*`. The tag landed,
 * no workflow ran, and the recipe reported success. fly's 0.33.0 shipped
 * with zero rules and zero skills and could not be patched by the one
 * recipe built for patching a single lexicon.
 *
 * A release that silently no-ops is worse than one that fails, so this
 * turns the next divergence into a PR-time failure.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function publishTagPatterns(): string[] {
  const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf-8");
  const match = workflow.match(/^\s*tags:\s*\[([^\]]+)\]/m);
  if (!match) throw new Error("publish.yml: `tags: [...]` trigger not found");
  return match[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
}

/** Tags the justfile actually creates, as literal-prefix + wildcard shapes. */
function releaseTagShapes(): Array<{ recipe: string; example: string }> {
  const justfile = readFileSync(join(repoRoot, "justfile"), "utf-8");
  const shapes: Array<{ recipe: string; example: string }> = [];

  // `git tag "chant-v$next"` / `git tag "lexicon-{{name}}-v$next"`
  for (const m of justfile.matchAll(/git tag "([^"]+)"/g)) {
    const raw = m[1];
    const example = raw
      .replace(/\{\{name\}\}/g, "docker")
      .replace(/\$\{?next\}?/g, "9.9.9");
    shapes.push({ recipe: raw, example });
  }
  return shapes;
}

/** Minimal glob match for the `prefix*` shapes these patterns use. */
function matchesGlob(pattern: string, value: string): boolean {
  const rx = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return rx.test(value);
}

describe("release wiring: justfile tags vs publish.yml trigger", () => {
  it("finds both halves", () => {
    expect(publishTagPatterns().length).toBeGreaterThan(0);
    expect(releaseTagShapes().length).toBeGreaterThan(0);
  });

  it("every tag a release recipe pushes triggers the publish workflow", () => {
    const patterns = publishTagPatterns();

    for (const { recipe, example } of releaseTagShapes()) {
      const hit = patterns.some((p) => matchesGlob(p, example));
      expect(
        hit,
        `justfile creates tag "${recipe}" (e.g. ${example}) but publish.yml triggers on ` +
          `[${patterns.join(", ")}] — pushing it would publish nothing while the recipe ` +
          `reports success`,
      ).toBe(true);
    }
  });

  it("covers the two shapes the repo releases by", () => {
    const examples = releaseTagShapes().map((s) => s.example);
    // Whole-repo release and single-lexicon patch. If a recipe stops
    // producing one of these, the assertion above would pass vacuously.
    expect(examples).toContain("chant-v9.9.9");
    expect(examples).toContain("lexicon-docker-v9.9.9");
  });
});

/**
 * The body of one justfile recipe, up to the next top-level recipe header.
 * Line-based on purpose: a recipe header sits at column 0 and every body line
 * is indented, which a regex over the whole file gets wrong (`^` under /m
 * matches the start of the slice too).
 */
const RECIPE_HEADER = /^[a-z_][a-z0-9_-]*(\s+[^:]*)?:/;

function recipeBody(name: string): string {
  const lines = readFileSync(join(repoRoot, "justfile"), "utf-8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^${name}(\\s|:)`).test(l));
  if (start === -1) throw new Error(`justfile: recipe "${name}" not found`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (RECIPE_HEADER.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * #1255.2 — `just release` rewrites the `@intentius/*` peer ranges alongside
 * `.version` (added in #411, because ranges frozen at `^0.1.0` break clean
 * installs). `release-lexicon` only set `.version`, so a single-lexicon patch
 * needing a newer core silently shipped a stale range.
 *
 * The two recipes pin to different things on purpose: a whole-repo release
 * moves everything together so `^$next` is right, while a single-lexicon
 * patch leaves core where it is, so the range must track the CURRENT core
 * version. Pinning it to `$next` would demand a core that does not exist —
 * which is why this asserts the mechanism, not a shared literal.
 */
describe("release wiring: peer ranges stay in lockstep (#1255)", () => {
  it("the whole-repo release rewrites both @intentius peer ranges", () => {
    const body = recipeBody("release");
    expect(body).toMatch(/peerDependencies\["@intentius\/chant"\]/);
    expect(body).toMatch(/peerDependencies\["@intentius\/chant-lexicon-github"\]/);
  });

  it("the single-lexicon release rewrites them too", () => {
    const body = recipeBody("release-lexicon");
    expect(
      body.includes('peerDependencies["@intentius/chant"]'),
      "release-lexicon sets .version without touching the @intentius/chant peer range — " +
        "a lexicon patch that needs a newer core would ship a stale range (#411, #1255)",
    ).toBe(true);
    expect(body).toMatch(/peerDependencies\["@intentius\/chant-lexicon-github"\]/);
  });

  it("the single-lexicon release pins peers to core, not to its own new version", () => {
    const body = recipeBody("release-lexicon");
    // It reads the current core version rather than reusing $next.
    expect(body).toMatch(/jq -r \.version packages\/core\/package\.json/);
    expect(
      /peerDependencies\["@intentius\/chant"\]\s*=\s*"\^"\s*\+\s*\$next/.test(body),
      "release-lexicon must not pin the core peer range to the lexicon's own new version",
    ).toBe(false);
  });

  it("both recipes keep the committed lockfile in step", () => {
    for (const recipe of ["release", "release-lexicon"]) {
      expect(recipeBody(recipe)).toMatch(/npm install --package-lock-only/);
    }
  });
});

/**
 * #1255.3 — both recipes pushed the bump commit straight to main, bypassing
 * branch protection, so a release tag could point at a commit CI never ran.
 */
describe("release wiring: preflight gates both recipes (#1255)", () => {
  it("every release recipe runs the preflight before tagging", () => {
    for (const recipe of ["release", "release-lexicon"]) {
      const body = recipeBody(recipe);
      expect(
        body.includes("scripts/release-preflight.sh"),
        `justfile recipe "${recipe}" tags and pushes without running the preflight — ` +
          "it could release a commit CI never ran (#1255)",
      ).toBe(true);
      // Ordering matters: a check that runs after `git tag` proves nothing.
      expect(body.indexOf("scripts/release-preflight.sh")).toBeLessThan(body.indexOf("git tag"));
    }
  });

  it("the whole-repo release requires main, since it pushes main", () => {
    expect(recipeBody("release")).toMatch(/release-preflight\.sh main/);
  });
});
