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
