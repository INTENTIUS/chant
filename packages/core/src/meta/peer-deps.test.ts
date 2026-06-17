import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

/**
 * The lexicon packages are published in lockstep with core, so their
 * `@intentius/*` peerDependencies must track the current core version. They were
 * once frozen at `^0.1.0` while shipping at 0.7.0, which made a clean
 * `npm install` fail (#411). This locks the invariant so it can't drift again.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const coreVersion = JSON.parse(readFileSync(join(repoRoot, "packages/core/package.json"), "utf-8")).version as string;
const expected = `^${coreVersion}`;

const lexiconsDir = join(repoRoot, "lexicons");
const lexicons = readdirSync(lexiconsDir).filter((name) => existsSync(join(lexiconsDir, name, "package.json")));

describe("lexicon peerDependencies track the core version", () => {
  test.each(lexicons)("%s pins @intentius/* peers to the current version", (lexicon) => {
    const pkg = JSON.parse(readFileSync(join(lexiconsDir, lexicon, "package.json"), "utf-8"));
    const peers: Record<string, string> = pkg.peerDependencies ?? {};
    for (const [dep, range] of Object.entries(peers)) {
      if (dep.startsWith("@intentius/")) {
        expect(range, `${lexicon}: peer ${dep} should be ${expected}`).toBe(expected);
      }
    }
  });
});
