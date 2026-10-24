/**
 * #4403: no workflow chant generates names an action by tag or branch, and no
 * generator's source does either outside the pin table.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { ACTION_PINS, unpinnedActions } from "@intentius/chant/action-pins";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
import { generateForgejoPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const root = join(import.meta.dirname, "../../../..");

describe("the actions a generated workflow uses", () => {
  const variants = [{ env: "prod" }, { env: "prod", prLoop: { applyOnMerge: true } }, { env: "prod", prLoop: {} }] as const;
  for (const [forge, gen] of [["github", generateGithubPipeline], ["forgejo", generateForgejoPipeline]] as const) {
    it(`are each pinned by commit SHA, with the release beside it, on ${forge}`, () => {
      for (const options of variants) {
        const yaml = gen(ESTATE, options as never).yaml;
        expect(unpinnedActions(yaml)).toEqual([]);
        expect(yaml).toMatch(new RegExp(`uses: \\S*actions/checkout@${ACTION_PINS.checkout7.sha} # ${ACTION_PINS.checkout7.tag}$`, "m"));
      }
    });
  }

  it("are pinned in the committed workflow chant ci workflow wrote", () => {
    const committed = readFileSync(join(root, ".github/workflows/chant-ci-green.yml"), "utf8");
    expect(unpinnedActions(committed)).toEqual([]);
    expect(committed).toMatch(new RegExp(`uses: actions/checkout@${ACTION_PINS.checkout6.sha} # ${ACTION_PINS.checkout6.tag}$`, "m"));
  });

  it("name no action by tag or branch in a generator's source, outside the pin table", () => {
    const dirs = ["lexicons/github/src/components", "lexicons/forgejo/src/components", "packages/core/src/components"].map((d) => join(root, d));
    const files = [
      ...dirs.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).map((n) => join(d, n))),
      join(root, "packages/core/src/workspace/ci-green-workflow.ts"),
      join(root, "packages/core/src/workspace/release-workflow.ts"),
    ];
    const found: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/["'`]((?:https:\/\/[\w.]+\/)?[\w-]+\/[\w./-]+@[\w.-]+)["'`]/g)) {
        if (!/@[0-9a-f]{40}$/.test(m[1])) found.push(`${f.slice(root.length + 1)}: ${m[1]}`);
      }
    }
    expect(files.length).toBeGreaterThan(10);
    expect(found).toEqual([]);
  });
});
