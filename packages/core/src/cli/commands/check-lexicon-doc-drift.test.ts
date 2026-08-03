/**
 * The completeness checklist and the tool it describes must agree (#1343).
 *
 * They did not. The doc listed 16/16/14 checks where the tool ran 18/14/9 —
 * seven rows described checks that do not exist anywhere in `check-lexicon.ts`
 * (`default-labels.test.ts`, `coverage.test.ts`, the three `import/*` tests,
 * `exportResources()` implemented, and the ownership marker), and two real
 * tier-1 checks were documented nowhere. The two missing ones were the damaging
 * direction: an author reading the checklist would have believed live export and
 * ownership marking were verified somewhere, and nothing verifies either.
 *
 * A hand-maintained parallel description of a tool drifts. This test makes the
 * doc's first column the check's own `name`, so drift is a build failure rather
 * than something a reviewer has to notice.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { checkLexicon } from "./check-lexicon";

const CHECKLIST = join(
  __dirname,
  "../../../../../docs/src/content/docs/lexicon-authoring/completeness-checklist.mdx",
);

/** The check names listed under `## Tier <n>` in the checklist. */
function documentedChecks(markdown: string, tier: 1 | 2 | 3): string[] {
  const section = markdown.split(new RegExp(`^## Tier ${tier}\\b`, "m"))[1];
  if (section === undefined) throw new Error(`no "## Tier ${tier}" section in the checklist`);
  const body = section.split(/^## /m)[0];
  const names: string[] = [];
  for (const line of body.split("\n")) {
    // A table row whose first cell is a backticked check name.
    const match = /^\|\s*`(.+?)`\s*\|/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("the completeness checklist matches check-lexicon (#1343)", () => {
  const markdown = readFileSync(CHECKLIST, "utf-8");

  // aws is the reference lexicon; the set of checks run is the same for any
  // directory, since every check is pushed unconditionally.
  const resultPromise = checkLexicon(join(__dirname, "../../../../../lexicons/aws"));

  for (const tier of [1, 2, 3] as const) {
    test(`tier ${tier} documents exactly the checks the tool runs`, async () => {
      const executed = (await resultPromise).items.filter((i) => i.tier === tier).map((i) => i.name);
      const documented = documentedChecks(markdown, tier);

      const undocumented = executed.filter((n) => !documented.includes(n));
      const phantom = documented.filter((n) => !executed.includes(n));

      expect({ undocumented, phantom }).toEqual({ undocumented: [], phantom: [] });
      expect(documented).toHaveLength(executed.length);
    });
  }

  test("the checklist lists the checks in the order the tool reports them", async () => {
    for (const tier of [1, 2, 3] as const) {
      const executed = (await resultPromise).items.filter((i) => i.tier === tier).map((i) => i.name);
      expect(documentedChecks(markdown, tier)).toEqual(executed);
    }
  });

  test("no tier section is empty — a parsing regression would silently pass the set comparison", () => {
    for (const tier of [1, 2, 3] as const) {
      expect(documentedChecks(markdown, tier).length).toBeGreaterThan(0);
    }
  });
});
