/**
 * The release path is two halves that must agree: the tag a release pushes
 * and publish.yml's tag trigger that decides whether pushing it does anything.
 *
 * They once disagreed: a recipe tagged `lexicon-<name>-v<version>`, pushed it,
 * and echoed "publish workflow triggered" while publish.yml matched only
 * `chant-v*`. The tag landed, no workflow ran, and the recipe reported
 * success. A release that silently no-ops is worse than one that fails, so
 * this turns the next divergence into a PR-time failure.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The tag triggers of the generated train workflow (#5154). */
function publishTagPatterns(): string[] {
  return ["publish.yml"].flatMap((file) => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", file), "utf-8");
    const match = workflow.match(/^\s*tags:\s*\[([^\]]+)\]/m);
    if (!match) throw new Error(`${file}: \`tags: [...]\` trigger not found`);
    return match[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  });
}

/**
 * Tags a release pushes. A release train (#5154): `chant workspace train cut
 * npm` tags the commit release-train/npm/<id>, which publish.yml runs on. Each
 * member's own release/npm/<member>/<label> tag publishes nothing by design.
 */
function releaseTagShapes(): Array<{ recipe: string; example: string }> {
  return [{ recipe: "release-train/<env>/<id> (chant workspace train cut npm)", example: "release-train/npm/train-x" }];
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

  it("no justfile recipe pushes a release tag of its own", () => {
    // Every release goes through the train; a recipe that tags would need a
    // trigger here too.
    const justfile = readFileSync(join(repoRoot, "justfile"), "utf-8");
    expect(justfile).not.toMatch(/git tag "/);
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

describe("release wiring: main's chant run", () => {
  it("a push to main does not cancel main's chant run; PR runs still cancel", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "chant.yml"), "utf-8");
    const block = workflow.match(/^concurrency:\n((?:[ ]+.*\n)+)/m)?.[1] ?? "";
    // One group per commit on main, so a later push neither cancels a running
    // run nor replaces a queued one.
    expect(block).toMatch(/group:.*github\.ref == 'refs\/heads\/main' && github\.sha \|\| github\.ref/);
    expect(block).toMatch(/cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
  });
});

/**
 * #5154 — `just release` dispatches the generated publish.yml with the
 * levels, and --dry-run plans the train at the newest green commit here,
 * cutting and pushing nothing. The train itself is chant's: release.train in
 * release/chant.config.ts, and publish.yml is what `chant release workflow`
 * writes from it.
 */
describe("release wiring: just release dispatches the release train (#5154)", () => {
  const body = () => recipeBody("release");

  it("dispatches publish.yml on main with the levels", () => {
    expect(body()).toMatch(/gh workflow run publish\.yml --ref main -f levels="\$l"/);
    expect(body()).toMatch(/l="\$\{levels\[\*\]:-auto\}"/);
  });

  it("a dry run plans the train at the newest green commit without --yes", () => {
    expect(body()).toMatch(/ci last-green --from origin\/main/);
    expect(body()).toMatch(/workspace train cut npm --at "\$sha" --levels "\$l"$/m);
    expect(body()).not.toMatch(/--yes/);
  });

  it("publish.yml is generated from release/chant.config.ts", () => {
    const workflow = readFileSync(join(repoRoot, ".github", "workflows", "publish.yml"), "utf-8");
    expect(workflow.split("\n")[0]).toMatch(/^# Generated by chant .*Regenerate with: chant release workflow/);
    expect(workflow).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}levels:/);
  });
});
