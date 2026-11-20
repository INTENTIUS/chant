/**
 * The product key for a stage's hooks (#5421).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { foldPipelineSource, pipelineFromConfig, pipelineSource, STAGE_HOOKS_KEY_FLOOR } from "../pipeline";
import { PRODUCT_CONFIG_WORDS, productConfigProblems } from "../ci-product";
import { NEXT_RELEASE } from "../release-floors";

const PAGE = readFileSync(fileURLToPath(new URL("../../../../docs/src/content/docs/reference/ci-product-config.mdx", import.meta.url)), "utf8");
const wave = (name: string) => ({ name, runs: [{ target: name }] });

describe("environments.<name>.hooks.<when> (#5421)", () => {
  test("a product config's stage hooks land on the stage's hooks, and fold from the written file", () => {
    const declaration = pipelineFromConfig({
      name: "shop",
      promotion: ["dev", "prod"],
      environments: {
        prod: {
          hooks: {
            "before-observe": [{ command: ["./scripts/freeze-check"] }],
            "after-plan": [{ name: "plan-report", command: ["./scripts/report", "{runs}"], on_failure: "approve", per_run: true, targets: ["eu/**"] }],
            "after-apply": [{ command: ["./scripts/notify"], onFailure: "fail", perRun: false }],
          },
        },
      },
      waves: { dev: [wave("dev")], prod: [wave("prod")] },
    });
    expect(declaration.stages[0]!.hooks).toBeUndefined();
    expect(declaration.stages[1]!.hooks).toEqual({
      before: { observe: [{ command: ["./scripts/freeze-check"] }] },
      after: {
        plan: [{ name: "plan-report", command: ["./scripts/report", "{runs}"], onFailure: "approve", perRun: true, targets: ["eu/**"] }],
        apply: [{ command: ["./scripts/notify"], onFailure: "fail" }],
      },
    });
    const text = pipelineSource(declaration, { product: "shop", config: "shop.yml", command: "shop ci" });
    const folded = foldPipelineSource(text);
    if ("finding" in folded) throw new Error(folded.finding.message);
    expect(folded.spec.stages[1]!.hooks).toEqual(declaration.stages[1]!.hooks);
    expect(folded.spec.stages[0]!.hooks).toBeUndefined();
  });

  test("every moment maps to its own place in the hooks", () => {
    const moments = ["before-observe", "before-plan", "after-plan", "after-gate", "before-apply", "after-apply"] as const;
    const hooks = Object.fromEntries(moments.map((m) => [m, [{ command: [m] }]]));
    const declaration = pipelineFromConfig({ name: "shop", promotion: ["dev"], environments: { dev: { hooks } }, waves: { dev: [wave("dev")] } });
    expect(declaration.stages[0]!.hooks).toEqual({
      before: { observe: [{ command: ["before-observe"] }], plan: [{ command: ["before-plan"] }], apply: [{ command: ["before-apply"] }] },
      after: { plan: [{ command: ["after-plan"] }], gate: [{ command: ["after-gate"] }], apply: [{ command: ["after-apply"] }] },
    });
  });

  test("no hooks, or empty lists, write nothing; an unknown moment is refused", () => {
    const plain = pipelineFromConfig({ name: "shop", promotion: ["dev"], environments: { dev: { hooks: { "after-plan": [] } } }, waves: { dev: [wave("dev")] } });
    expect("hooks" in plain.stages[0]!).toBe(false);
    expect(() => pipelineFromConfig({ name: "shop", promotion: ["dev"], environments: { dev: { hooks: { "during-plan": [{ command: ["x"] }] } as never } }, waves: { dev: [wave("dev")] } })).toThrow(/hooks\.during-plan: <when> is one of/);
  });

  test("the key has a vocabulary row and a Stage keys row, and the floor names the next release", () => {
    expect(PRODUCT_CONFIG_WORDS.find((w) => w.key === "environments.<name>.hooks.<when>")).toMatchObject({ section: "stage" });
    expect(PAGE).toContain("| `environments.<name>.hooks.<when>` |");
    expect(productConfigProblems({ environments: { prod: { hooks: { "after-plan": [{ command: ["x"] }] } } } }, { product: "terragucci" })).toEqual([]);
    expect(STAGE_HOOKS_KEY_FLOOR).toBe(NEXT_RELEASE);
  });
});
