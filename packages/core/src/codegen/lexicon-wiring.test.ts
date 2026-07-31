/**
 * chant — the root package.json lexicon list is hand-maintained, and it drifted.
 *
 * `chant dev onboard` adds `@intentius/chant-lexicon-<name>` to the root
 * `dependencies`, but three lexicons (fly, forgejo, fountain) were never added
 * and nobody noticed, because nothing checks. That is the same shape as the
 * lexicon-upgrade miswiring (#1218/#1226) and the missing publish wiring that
 * stranded two packages: a list a human has to remember, with no gate.
 *
 * Resolution itself does not depend on this list — `workspaces: ["lexicons/*"]`
 * symlinks every lexicon into node_modules regardless, which is why the three
 * omissions never broke anything. The entry is an explicit declaration, and the
 * point of this test is that it either applies to every lexicon or to none,
 * rather than silently landing somewhere in between.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function publishableLexicons(): string[] {
  return readdirSync(join(repoRoot, "lexicons"))
    .filter((name) => {
      const manifest = join(repoRoot, "lexicons", name, "package.json");
      if (!existsSync(manifest)) return false;
      return JSON.parse(readFileSync(manifest, "utf-8")).private !== true;
    })
    .sort();
}

function rootLexiconDeps(): string[] {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  return Object.keys(root.dependencies ?? {})
    .filter((dep) => dep.startsWith("@intentius/chant-lexicon-"))
    .map((dep) => dep.replace("@intentius/chant-lexicon-", ""))
    .sort();
}

describe("root package.json lexicon wiring", () => {
  it("lists every publishable lexicon", () => {
    expect(rootLexiconDeps()).toEqual(publishableLexicons());
  });

  it("lists no lexicon that does not exist", () => {
    const onDisk = new Set(readdirSync(join(repoRoot, "lexicons")));
    for (const name of rootLexiconDeps()) {
      expect(onDisk.has(name), `root package.json depends on a missing lexicon "${name}"`).toBe(true);
    }
  });
});
