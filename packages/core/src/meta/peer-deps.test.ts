import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { join } from "path";

/**
 * The lexicon packages declare `@intentius/*` peers, and a range frozen at an
 * old version makes a clean `npm install` fail — they were once stuck at
 * `^0.1.0` while shipping at 0.7.0 (#411). This locks the invariant so it
 * cannot drift again.
 *
 * The range must track the version of the package that PROVIDES the peer, not
 * core's version for every peer alike. Two providers exist: core backs
 * `@intentius/chant`, and `lexicons/github` backs
 * `@intentius/chant-lexicon-github` (forgejo and gitlab both peer on it).
 * `just release-lexicon` writes exactly that — `^$core` for the core peer,
 * `^$github_lexicon` for the github one — because a single-lexicon release
 * moves one package without moving the others, so pinning every peer to core
 * would demand a version that was never published.
 *
 * Asserting against core for both passed only while the whole workspace
 * happened to sit on one version. `just release-lexicon github patch` alone is
 * enough to separate them, and the old assertion then failed on a tree the
 * release recipe had written correctly.
 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function versionOf(packageDir: string): string {
  return JSON.parse(readFileSync(join(repoRoot, packageDir, "package.json"), "utf-8")).version as string;
}

const lexiconsDir = join(repoRoot, "lexicons");
const lexicons = readdirSync(lexiconsDir).filter((name) => existsSync(join(lexiconsDir, name, "package.json")));

/** Which workspace package publishes each `@intentius/*` peer a lexicon can declare. */
const providerDir: Record<string, string> = {
  "@intentius/chant": join("packages", "core"),
  "@intentius/chant-lexicon-github": join("lexicons", "github"),
};

function intentiusPeersOf(lexicon: string): [string, string][] {
  const pkg = JSON.parse(readFileSync(join(lexiconsDir, lexicon, "package.json"), "utf-8"));
  const peers: Record<string, string> = pkg.peerDependencies ?? {};
  // Third-party peers (typescript) aren't ours to track.
  return Object.entries(peers).filter(([dep]) => dep.startsWith("@intentius/"));
}

describe("lexicon peerDependencies track the version of the package providing them", () => {
  test.each(lexicons)("%s pins @intentius/* peers to their provider's version", (lexicon) => {
    for (const [dep, range] of intentiusPeersOf(lexicon)) {
      const dir = providerDir[dep];
      expect(
        dir,
        `${lexicon} peers ${dep}, which no workspace package is registered as providing — ` +
          `add it to providerDir so its range is checked`,
      ).toBeDefined();

      expect(range, `${lexicon}: peer ${dep} should be ^${versionOf(dir)}`).toBe(`^${versionOf(dir)}`);
    }
  });

  test("every @intentius/* peer declared anywhere has a registered provider", () => {
    // Guards the map itself: a new cross-lexicon peer added without a
    // providerDir entry would be reported per-lexicon above, but only if that
    // lexicon is reached — this states the whole set in one place.
    const declared = new Set(lexicons.flatMap((l) => intentiusPeersOf(l).map(([dep]) => dep)));
    expect([...declared].sort()).toEqual(Object.keys(providerDir).sort());
  });

});

/**
 * The rule itself, over fixtures rather than the real tree — the tree sits on
 * one version today, so it cannot demonstrate the skew this exists to handle.
 */
function rangeViolations(
  versions: Record<string, string>,
  peers: Record<string, Record<string, string>>,
): string[] {
  const out: string[] = [];
  for (const [lexicon, declared] of Object.entries(peers)) {
    for (const [dep, range] of Object.entries(declared)) {
      if (!dep.startsWith("@intentius/")) continue;
      if (range !== `^${versions[dep]}`) out.push(`${lexicon}:${dep}`);
    }
  }
  return out;
}

describe("the provider-aware rule, over fixtures", () => {
  // `just release-lexicon github patch`: github moves, core does not, and the
  // recipe rewrites forgejo's github peer to the new github version.
  const skewed = { "@intentius/chant": "0.38.0", "@intentius/chant-lexicon-github": "0.38.1" };

  test("accepts a provider ahead of core when its dependents track it", () => {
    expect(
      rangeViolations(skewed, {
        forgejo: { "@intentius/chant": "^0.38.0", "@intentius/chant-lexicon-github": "^0.38.1" },
      }),
    ).toEqual([]);
    // This is the case the old core-for-everything assertion rejected: it
    // demanded ^0.38.0 for the github peer, on a tree release-lexicon wrote.
    expect(`^${skewed["@intentius/chant-lexicon-github"]}`).not.toBe(`^${skewed["@intentius/chant"]}`);
  });

  test("still catches a range left behind by its provider", () => {
    expect(
      rangeViolations(skewed, {
        forgejo: { "@intentius/chant": "^0.38.0", "@intentius/chant-lexicon-github": "^0.38.0" },
      }),
    ).toEqual(["forgejo:@intentius/chant-lexicon-github"]);
  });

  test("catches the #411 case — every range frozen at an old version", () => {
    expect(
      rangeViolations(skewed, {
        aws: { "@intentius/chant": "^0.1.0" },
        k8s: { "@intentius/chant": "^0.1.0" },
      }),
    ).toEqual(["aws:@intentius/chant", "k8s:@intentius/chant"]);
  });

  test("ignores third-party peers", () => {
    expect(rangeViolations(skewed, { aws: { typescript: ">=5.0.0" } })).toEqual([]);
  });
});
