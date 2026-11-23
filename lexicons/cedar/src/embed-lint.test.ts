/**
 * The embedding helpers lint clean where the docs put them (#5514).
 *
 * The docs show `...agentCoreStagedPolicy(...)` and
 * `Definition: avpPolicyDefinition(...)` inside a resource constructor. Those
 * calls pass EVL001 and EVL004 only because this lexicon registers the helpers
 * `foldsEagerly`; these tests run the two core rules through the lint engine
 * with the registry the CLI hands them, on the docs' own shapes and on every
 * shipped example.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLint } from "@intentius/chant/lint/engine";
import { evl001NonLiteralExpressionRule, evl004SpreadNonConstRule } from "@intentius/chant/lint/rules/index";
import { cedarPlugin } from "./plugin";
import * as cedar from "./index";

const rules = [evl001NonLiteralExpressionRule, evl004SpreadNonConstRule];
const intrinsics = cedarPlugin.intrinsics!();

const DOCS_SHAPES = `
import { Policy, TemporalPolicy, TemporalEventSchema, agentCoreStagedPolicy, avpPolicyDefinition, dogwood } from "@intentius/chant-lexicon-cedar";
import { BedrockAgentCorePolicy, VerifiedPermissionsPolicy } from "@intentius/chant-lexicon-aws";

export const events = new TemporalEventSchema({ schema: dogwood.defaultEventSchema() });

export const writeNeedsApproval = new TemporalPolicy({
  effect: "permit",
  action: { eq: 'Drupe::Action::"Read"' },
  whenTemporal: [dogwood.formerly("1h", dogwood.predicate('Drupe::Action::"Login"', "response", { "input.user": dogwood.ctx("input.user") }))],
});

export const approvalPolicy = new BedrockAgentCorePolicy({
  PolicyEngineId: engine.ref(),
  ...agentCoreStagedPolicy("writeNeedsApproval", writeNeedsApproval, "log-only"),
});

const ownerReadProps = { effect: "permit", principal: { is: "App::User" } } as const;
export const ownerRead = new Policy(ownerReadProps);
export const ownerReadAvp = new VerifiedPermissionsPolicy({
  PolicyStoreId: policyStore.ref(),
  Definition: avpPolicyDefinition("ownerRead", ownerReadProps, { description: "Owners read their own documents." }),
});
`;

function writeTemp(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cedar-embed-lint-"));
  const file = join(dir, "policies.ts");
  writeFileSync(file, source);
  return file;
}

describe("cedar embedding helpers and the EVL rules", () => {
  it("registers each helper eager, and each is a function this package exports", () => {
    for (const def of intrinsics) {
      expect(def.isTag, def.name).toBe(false);
      expect(def.foldsEagerly, def.name).toBe(true);
      expect(typeof (cedar as Record<string, unknown>)[def.name], def.name).toBe("function");
    }
    expect(intrinsics.map((i) => i.name).sort()).toEqual([
      "agentCorePolicyDefinition",
      "agentCorePolicyName",
      "agentCorePolicyResource",
      "agentCoreStagedPolicy",
      "agentCoreStatement",
      "avpPolicyDefinition",
      "avpPolicyResource",
      "avpStatement",
    ]);
  });

  it("passes the docs' shapes with cedar's registry", async () => {
    const { diagnostics } = await runLint([writeTemp(DOCS_SHAPES)], rules, undefined, intrinsics);
    expect(diagnostics).toEqual([]);
  });

  it("flags the same shapes without it, so the registry is what admits them", async () => {
    const { diagnostics } = await runLint([writeTemp(DOCS_SHAPES)], rules);
    expect(diagnostics.map((d) => d.ruleId).sort()).toEqual(["EVL001", "EVL001", "EVL004"]);
  });

  it("still flags a dogwood builder destructured out of the namespace and called bare", async () => {
    const source = `
import { TemporalEventSchema, dogwood } from "@intentius/chant-lexicon-cedar";
const { defaultEventSchema } = dogwood;
export const events = new TemporalEventSchema({ schema: defaultEventSchema() });
`;
    const { diagnostics } = await runLint([writeTemp(source)], rules, undefined, intrinsics);
    expect(diagnostics.map((d) => d.ruleId)).toEqual(["EVL001"]);
  });

  const examplesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
  const exampleFiles = readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(examplesDir, e.name, "src")))
    .flatMap((e) =>
      readdirSync(join(examplesDir, e.name, "src"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(examplesDir, e.name, "src", f)),
    );

  it("passes every shipped example with no rule configuration", async () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
    const { diagnostics } = await runLint(exampleFiles, rules, undefined, intrinsics);
    expect(diagnostics).toEqual([]);
  });
});
