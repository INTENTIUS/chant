import { describe, test, expect } from "vitest";
import { build } from "@intentius/chant/build";
import { loadChantConfigUpward } from "@intentius/chant/config";
import type { Serializer } from "@intentius/chant/serializer";
import { declaredBuildOptions } from "@intentius/chant-test-utils/example-harness";
import { awsSerializer } from "@intentius/chant-lexicon-aws";
import { gcpSerializer } from "@intentius/chant-lexicon-gcp";
import { azureSerializer } from "@intentius/chant-lexicon-azure";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab";
import { helmSerializer } from "@intentius/chant-lexicon-helm";
import { flySerializer } from "@intentius/chant-lexicon-fly";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, relative, resolve } from "path";

// ── README resource counts are asserted against the build (#1422) ────
//
// Every example README that states how many resources the example builds is
// found here, built through the same `build()` the example tests use, and the
// number in the prose is compared with the number in the output. Nothing is
// registered per example: a new README that states a count is covered the
// moment it is written, and an example whose count moves (lambda-s3 went from
// 3 to 4 when WAW042 added the TLS-only bucket policy, #1400) fails here until
// its README says so too.
//
// The build happens a second time for these examples (the per-example tests
// build them too). The examples with a stated count are the small ones, so
// the whole pass is a few seconds in its own worker.

const repoRoot = resolve(import.meta.dirname, "..");

/** Directories whose immediate children are examples. */
const exampleRoots = [
  resolve(repoRoot, "examples"),
  ...readdirSync(resolve(repoRoot, "lexicons"))
    .map((l) => resolve(repoRoot, "lexicons", l, "examples"))
    .filter((d) => existsSync(d)),
];

/**
 * Examples whose README states a count the harness cannot check. Each entry
 * must still state a count — an entry whose README no longer does is stale and
 * fails the test, so this list cannot outlive the reason for it.
 */
const SKIP: Record<string, string> = {
  "cockroachdb-multi-region-gke":
    "four stacks under src/ (shared + three regions), and 44 of the 193 come from a " +
    "HelmRender that reaches the network on a cold cache; each stack is asserted on its " +
    "own in examples.test.ts",
};

const SERIALIZERS: Record<string, Serializer> = {
  aws: awsSerializer,
  gcp: gcpSerializer,
  azure: azureSerializer,
  k8s: k8sSerializer,
  gitlab: gitlabSerializer,
  helm: helmSerializer,
  fly: flySerializer,
};

/** A qualifier word in front of "resources" names the output it counts. */
const QUALIFIER_KEY: Record<string, string> = {
  cloudformation: "aws",
  kubernetes: "k8s",
  k8s: "k8s",
  arm: "azure",
  azure: "azure",
  gcp: "gcp",
  "config connector": "gcp",
};

const QUALIFIER = "(?:(CloudFormation|Kubernetes|K8s|ARM|Azure|GCP|Config Connector)\\s+)?";

/**
 * The phrasings that count as a claim about the whole build. A number is a
 * claim when it is introduced by one of these, on one line:
 *
 *   - "creates N resources", "deploys N resources", "with N resources",
 *     "all N resources"                 — `The stack creates 17 CloudFormation resources:`
 *   - ": N resources", "**N resources"  — `(\`k8s.yaml\`): 4 Kubernetes resources`,
 *                                         `**35 CloudFormation resources**`
 *   - "(N resources)"                   — `shared-alb (24 resources)` in a diagram
 *
 * A leading "~" is accepted and checked exactly; an approximate number in a
 * README is still a number a reader acts on.
 *
 * Per-layer breakdowns such as `(17 resources via VpcDefault)` are not
 * totals and do not match: the parenthesised form must close right after
 * "resources".
 */
const CLAIM_PATTERNS = [
  new RegExp(`(?:\\b(?:creates|deploys|with|all)|:|\\*\\*)\\s*~?(\\d+)\\s+${QUALIFIER}resources\\b`, "gi"),
  new RegExp(`\\(~?(\\d+)\\s+${QUALIFIER}resources\\)`, "gi"),
];

interface Claim {
  /** Output key the claim is about, or undefined for the example's primary output. */
  key: string | undefined;
  count: number;
  line: number;
  text: string;
}

function readmeClaims(readme: string): Claim[] {
  const claims: Claim[] = [];
  readFileSync(readme, "utf8")
    .split("\n")
    .forEach((text, i) => {
      for (const pattern of CLAIM_PATTERNS) {
        for (const m of text.matchAll(pattern)) {
          const qualifier = m[2]?.toLowerCase();
          claims.push({
            key: qualifier ? QUALIFIER_KEY[qualifier] : undefined,
            count: Number(m[1]),
            line: i + 1,
            text: text.trim(),
          });
        }
      }
    });
  return claims;
}

/** Count the resources in one serializer's output. */
function countResources(key: string, output: string): number {
  switch (key) {
    case "aws":
      return Object.keys(JSON.parse(output).Resources ?? {}).length;
    case "azure":
      return (JSON.parse(output).resources ?? []).length;
    case "k8s":
    case "gcp":
      return output.split(/^---\s*$/m).filter((d) => d.trim()).length;
    default:
      throw new Error(`no resource counter for the "${key}" output`);
  }
}

const claimed = exampleRoots
  .flatMap((root) =>
    readdirSync(root)
      .map((name) => resolve(root, name))
      .filter((dir) => statSync(dir).isDirectory() && existsSync(resolve(dir, "README.md"))),
  )
  .map((dir) => ({ dir, name: basename(dir), claims: readmeClaims(resolve(dir, "README.md")) }))
  .filter((e) => e.claims.length > 0);

describe("example README resource counts match the build (#1422)", () => {
  test("the READMEs that state a count are the ones this file checks", () => {
    // Sanity on the scan itself: the set is stable and not empty. A README
    // rewording its claim out of the patterns above would silently drop out
    // of coverage otherwise.
    expect(claimed.length).toBeGreaterThanOrEqual(25);
    for (const name of Object.keys(SKIP)) {
      expect(claimed.map((e) => e.name), `${name} is in SKIP but its README states no count`).toContain(name);
    }
  });

  for (const { dir, name, claims } of claimed) {
    const label = relative(repoRoot, dir);
    if (SKIP[name]) {
      test.skip(`${label}: ${SKIP[name]}`, () => {});
      continue;
    }

    test(label, async () => {
      const srcDir = resolve(dir, "src");
      // From the example root, not src/: some examples keep a lint-only
      // chant.config.ts fragment in src/ that declares no lexicons.
      const { config } = await loadChantConfigUpward(dir);
      const lexicons = config.lexicons ?? [];
      expect(lexicons.length, `${label}: chant.config.ts declares no lexicons`).toBeGreaterThan(0);
      const serializers = lexicons.map((l) => {
        const s = SERIALIZERS[l];
        if (!s) throw new Error(`${label}: no serializer registered here for lexicon "${l}"`);
        return s;
      });

      const result = await build(srcDir, serializers, undefined, await declaredBuildOptions(srcDir));
      expect(result.errors, `${label}: build errors`).toEqual([]);

      const text = (key: string) => {
        const out = result.outputs.get(key);
        return typeof out === "string" ? out : out?.primary;
      };

      for (const claim of claims) {
        const key = claim.key ?? lexicons[0];
        const output = text(key);
        expect(output, `${label}: README line ${claim.line} counts the "${key}" output, which the build did not produce`).toBeDefined();
        const built = countResources(key, output!);
        expect(
          built,
          `${label}/README.md:${claim.line} says ${claim.count} but the ${key} build has ${built} resources\n  ${claim.text}`,
        ).toBe(claim.count);
      }
    }, 60_000);
  }
});
