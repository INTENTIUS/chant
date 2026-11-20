/**
 * #5354: a stage gate's rules in `all`/`any` groups with names, a hold's
 * description shown to the person who lifts it, and the products' words
 * for rejecting a release.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { asPipelineSpec, pipelineSpecProblems, type PipelineSpec } from "./spec";
import { stageHeldAt, stageHeldLine, stageWavesSpec } from "./stages";
import { pipelineChangeNotes, pipelineChangeSection } from "./diff";
import { pipelineFromConfig, pipelineSource } from "./product";
import { readMemberPromotionOrder } from "../workspace/promotion-order";
import { parseProductComment, rejectLine, resolveProductWords, productWordsProblems, PRODUCT_CONFIG_WORDS, CHANT_WORDS } from "../ci-product";

const wave = (target: string) => [{ name: target, runs: [{ target }] }];

function spec(over: Partial<PipelineSpec["stages"][number]> = {}): PipelineSpec {
  return asPipelineSpec({
    name: "shop",
    stages: [
      { name: "dev", waves: wave("dev") },
      { name: "prod", waves: wave("prod"), ...over },
    ],
  });
}

const RELEASE_RULES = [{ name: "release", any: [{ name: "two-approvers", count: 2, proven: true }, { name: "release-manager", count: 1, roles: ["release-manager"] }] }];

describe("a stage gate's rule groups", () => {
  test("read, and pass into the stage's op-waves spec", () => {
    const s = asPipelineSpec({ ...spec({ gate: { quorum: RELEASE_RULES } }), defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" }, runner: "ubuntu-latest" } });
    expect(stageWavesSpec(s, "prod").approvals?.quorum).toEqual(RELEASE_RULES);
  });

  test("a group nested too deep, or a name used twice, is refused when the spec is read", () => {
    const deep = [{ all: [{ all: [{ all: [{ any: [{ count: 1 }] }] }] }] }];
    expect(pipelineSpecProblems({ name: "shop", stages: [{ name: "prod", waves: wave("prod"), gate: { quorum: deep } }] })).toEqual([
      'stage "prod".gate.quorum[0].all[0].all[0].all[0] nests groups deeper than 3; all and any nest up to 3 groups deep',
    ]);
    const twice = [{ name: "a", count: 1 }, { name: "a", count: 2 }];
    expect(pipelineSpecProblems({ name: "shop", stages: [{ name: "prod", waves: wave("prod"), gate: { quorum: twice } }] })[0]).toContain('is "a", which another rule of the gate already names');
  });

  test("a product's config writes groups and names, and leaves a spec written before them as it was", () => {
    const config = {
      name: "shop",
      promotion: ["dev", "prod"],
      waves: { dev: wave("dev"), prod: wave("prod") },
      environments: { prod: { approval_rules: [{ name: "release", any: [{ name: "two-approvers", count: 2, proven: true }, { name: "release-manager", count: 1, roles: ["release-manager"] }] }], hold: { reason: "billing", description: "check the invoice run" } } },
    };
    const d = pipelineFromConfig(config);
    expect(d.stages[1]!.gate?.quorum).toEqual(RELEASE_RULES);
    expect(d.stages[1]!.hold).toEqual({ reason: "billing", description: "check the invoice run" });
    // A map of rules keeps its keys as the config's labels, so the folded spec is the one written before #5354.
    const before = pipelineFromConfig({ ...config, environments: { prod: { approval_rules: { two: { count: 2 } } } } });
    expect(before.stages[1]!.gate?.quorum).toEqual([{ count: 2 }]);
    expect(pipelineSource(d, { product: "terragucci", config: "terragucci.yml", command: "terragucci ci" })).toContain('"any"');
  });
});

describe("a hold's description", () => {
  const now = new Date("2026-11-20T00:00:00Z");

  test("the promote it refuses prints it", () => {
    const held = stageHeldAt({ name: "prod", hold: { reason: "billing cut-over", description: "confirm the invoice run finished" } }, now)!;
    expect(stageHeldLine(held)).toBe('stage "prod" is held until a change to the pipeline lifts the hold (billing cut-over), so nothing is promoted into it. Before it goes on: confirm the invoice run finished');
    expect(pipelineSpecProblems({ name: "shop", stages: [{ name: "prod", waves: wave("prod"), hold: { description: "" } }] })).toEqual(['stage "prod".hold.description must be text']);
  });

  test("the plan note of the change that lifts it shows it, with the named rules", () => {
    const before = spec({ hold: { reason: "billing", description: "confirm the invoice run finished" } });
    const after = spec({ gate: { quorum: RELEASE_RULES } });
    const notes = pipelineChangeNotes(before, after);
    expect(notes).toEqual([
      "This change lifts the hold on stage prod (billing). Before it goes on: confirm the invoice run finished",
      "Stage prod's gate takes all of: release: any of (two-approvers: 2 approvals proven; release-manager: 1 approval from release-manager).",
    ]);
    const section = pipelineChangeSection({ diff: ["-x", "+y"], notes });
    expect(section.indexOf("lifts the hold")).toBeLessThan(section.indexOf("```diff"));
    // A change with no hold and no named rule has no notes.
    expect(pipelineChangeNotes(spec(), spec({ failureTolerance: 1 }))).toEqual([]);
  });

  const dir = mkdtempSync(join(tmpdir(), "chant-5354-hold-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("workspace status's promotion order shows the hold and its description", async () => {
    mkdirSync(join(dir, ".chant"), { recursive: true });
    writeFileSync(
      join(dir, ".chant", "pipeline.ts"),
      `import { pipeline } from "@intentius/chant/pipeline";\nexport default pipeline({ name: "shop", stages: [{ name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }] }, { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }] }], hold: { reason: "billing", description: "confirm the invoice run finished" } }] });\n`,
    );
    expect(await readMemberPromotionOrder(dir)).toEqual([
      { name: "dev", canary: false },
      { name: "prod", canary: false, held: { kind: "hold", until: null, reason: "billing", description: "confirm the invoice run finished" } },
    ]);
  });
});

describe("the products' words for a rejection", () => {
  test("chant's reject line, and a product's own under its name", () => {
    expect(rejectLine(CHANT_WORDS, { op: "shop", gate: "staging", digest: "sha256:x" })).toBe("chant reject shop staging --plan sha256:x --reason <why> --sign");
    const plywood = resolveProductWords({ product: "plywood" });
    expect(rejectLine(plywood, { op: "shop", gate: "staging", digest: "sha256:x", reason: "no", sign: false })).toBe("plywood reject shop staging --plan sha256:x --reason no");
    expect(productWordsProblems(resolveProductWords({ product: "plywood", reject: "plywood reject {op} {who}" }))).toContain("reject names {who}, which chant does not fill");
  });

  test("words that map no comment command onto reject answer a reject comment with the reject line", () => {
    const words = resolveProductWords({ product: "terragucci", op: "infra" });
    expect(parseProductComment(words, "/terragucci reject")).toEqual({
      kind: "refused",
      reason: "terragucci's comments take no reject command: run `terragucci reject infra <gate> --plan <digest> --reason <why> --sign`",
    });
  });

  test("the config words name each new key, in the stage section", () => {
    for (const key of ["approval_rules.<rule>.name", "approval_rules.<rule>.all", "approval_rules.<rule>.any", "environments.<name>.hold.description"]) {
      expect(PRODUCT_CONFIG_WORDS.find((w) => w.key === key)?.section, key).toBe("stage");
    }
  });
});
