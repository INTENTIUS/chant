/**
 * The pipeline declaration (#5324): the fold, the stage specs, the holds,
 * the promote gates, and the product helpers on terragucci's, plywood's and
 * sql-yodeler's config shapes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import { readOpWavePolicy, parseOpWavesSpec } from "../op/op-waves-run";
import { opWaveToleratedFailures } from "../op/op-waves";
import {
  asPipelineSpec,
  checkPipelineFile,
  foldPipelineSource,
  lineDiff,
  pipeline,
  pipelineChange,
  pipelineChangeSection,
  pipelineFromConfig,
  pipelinePromoteGates,
  pipelinePromoteSource,
  pipelineSource,
  PIPELINE_FILE,
  PIPELINE_FLOOR,
  PIPELINE_SPEC_KIND,
  pipelineSpecProblems,
  promotedDigest,
  promotionOrderOf,
  readMemberPipeline,
  readPipelineAt,
  stageHeldAt,
  stageHeldLine,
  stageWavesSpec,
  writePipelineFile,
  type PipelineDeclaration,
  type PipelineSpec,
} from "../pipeline";
import { checkRenderedWavesSpec } from "./rendered";
import { pipelineNoteSection } from "../pr-post";
import { generatePipeline } from "./generate";
import { evl012PipelineFoldRule } from "../lint/rules/evl012-pipeline-fold";
import { runLint } from "../lint/engine";
import { readMemberPromotionOrder } from "../workspace/promotion-order";
import { NEXT_RELEASE } from "../release-floors";

const FILE = `import { pipeline } from "@intentius/chant/pipeline";

const runner = "ubuntu-latest";
const dev = { name: "dev", runs: [{ target: "dev" }] };

export default pipeline({
  name: "shop",
  defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" }, runner },
  control: { repo: "github.com/acme/control", member: "shop", op: "deploy" },
  stages: [
    { name: "dev", waves: [dev], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }], gate: { policy: "on-destructive" }, forgeEnvironment: { name: "staging" } },
    {
      name: "prod",
      canary: false,
      waves: [{ name: "prod", runs: [{ target: "prod-a" }, { target: "prod-b" }, { target: "prod-c" }, { target: "prod-d" }] }],
      failureTolerance: "25%",
      gate: { approval: "sealed", quorum: [{ count: 2, roles: ["sre"], notAuthor: true }], holds: { policy: true } },
      freeze: [{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: "year end" }],
    },
  ],
});
`;

function folded(text = FILE): PipelineSpec {
  const out = foldPipelineSource(text);
  if (!("spec" in out)) throw new Error(JSON.stringify(out.finding));
  return out.spec;
}

describe("the fold (#5324)", () => {
  test("a declaration inside the subset folds to its spec, with its kind", () => {
    const spec = folded();
    expect(spec.kind).toBe(PIPELINE_SPEC_KIND);
    expect(spec.name).toBe("shop");
    expect(spec.stages.map((s) => s.name)).toEqual(["dev", "staging", "prod"]);
    expect(spec.defaults?.runner).toBe("ubuntu-latest");
    expect(spec.stages[0]!.waves).toEqual([{ name: "dev", runs: [{ target: "dev" }] }]);
    expect(pipelineSpecProblems(spec)).toEqual([]);
  });

  test("pipeline() returns its argument, so a run of the file gives the same object", () => {
    const d: PipelineDeclaration = { name: "x", stages: [{ name: "dev", waves: [{ name: "dev", runs: [] }] }] };
    expect(pipeline(d)).toBe(d);
  });

  test("a file outside the subset is refused with the evaluability rule's id, never run", () => {
    const env = foldPipelineSource(FILE.replace('runner = "ubuntu-latest"', "runner = process.env.RUNNER"));
    expect(env).toMatchObject({ finding: { ruleId: "EVL001", line: 3 } });
    const call = foldPipelineSource(FILE.replace('{ target: "dev" }', "target()"));
    expect(call).toMatchObject({ finding: { ruleId: "EVL001", line: 4, message: expect.stringContaining("function call") } });
    const dynamic = foldPipelineSource(FILE.replace("stack: \"{target}\"", "stack: dev[runner]"));
    expect(dynamic).toMatchObject({ finding: { ruleId: "EVL003" } });
  });

  test("a shape that is not a declaration is refused as EVL012", () => {
    expect(foldPipelineSource(FILE.replace("const runner", "let runner"))).toMatchObject({ finding: { ruleId: "EVL012", line: 3, message: expect.stringContaining("only `const`s") } });
    expect(foldPipelineSource(`import { x } from "./other";\n${FILE}`)).toMatchObject({ finding: { ruleId: "EVL012", line: 1, message: expect.stringContaining("imports only from @intentius/chant/pipeline") } });
    expect(foldPipelineSource(FILE.replace("export default pipeline(", "export default other("))).toMatchObject({ finding: { ruleId: "EVL012" } });
    expect(foldPipelineSource(`${FILE}\nfunction f() {}\n`)).toMatchObject({ finding: { ruleId: "EVL012" } });
    expect(foldPipelineSource(`import { pipeline } from "@intentius/chant/pipeline";\n`)).toMatchObject({ finding: { ruleId: "EVL012", message: expect.stringContaining("export default") } });
  });

  test("a declaration the spec check refuses is EVL012, naming the problem", () => {
    const out = foldPipelineSource(FILE.replace('name: "shop",', 'name: "shop", stagez: [],'));
    expect(out).toMatchObject({ finding: { ruleId: "EVL012", message: expect.stringContaining('unknown key "stagez"') } });
    expect(foldPipelineSource(FILE.replace('failureTolerance: "25%"', 'failureTolerance: "lots"'))).toMatchObject({ finding: { ruleId: "EVL012", message: expect.stringContaining("failureTolerance") } });
  });

  test("the spec check refuses a repeated stage, a bad hold and a window that ends before it starts", () => {
    const base = { name: "p", stages: [{ name: "dev", waves: [{ name: "dev", runs: [] }] }] };
    expect(pipelineSpecProblems({ ...base, stages: [...base.stages, ...base.stages] })).toEqual([expect.stringContaining("named twice")]);
    expect(pipelineSpecProblems({ ...base, stages: [{ ...base.stages[0], hold: { until: "soon" } }] })).toEqual([expect.stringContaining("hold.until")]);
    expect(pipelineSpecProblems({ ...base, stages: [{ ...base.stages[0], freeze: [{ from: "2026-12-02T00:00:00Z", until: "2026-12-01T00:00:00Z" }] }] })).toEqual([expect.stringContaining("ends before it starts")]);
    expect(pipelineSpecProblems({ ...base, defaults: { waves: [] } })).toEqual(["defaults.waves is set by the pipeline, not its defaults"]);
  });
});

describe("each stage's op-waves spec", () => {
  const spec = folded();

  test("the first stage carries the release cut after its last wave and the control dispatch", () => {
    const dev = stageWavesSpec(spec, "dev");
    expect(dev.name).toBe("shop-dev");
    expect(dev.op).toBe("shop");
    expect(dev.labels).toEqual({ Env: "dev" });
    expect(dev.control).toEqual({ repo: "github.com/acme/control", member: "shop", op: "deploy" });
    expect(dev.waves[0]!.gate).toBe("never");
    expect(dev.waves[0]!.hooks?.after?.apply).toEqual([{ name: "release-cut", command: ["chant", "release", "cut", "auto", "--first", "0.1.0", "--yes", "--wait-checks"] }]);
  });

  test("a later stage takes its gate, quorum, holds, environment and tolerance, and no cut or dispatch", () => {
    const staging = stageWavesSpec(spec, "staging");
    expect(staging.control).toBeUndefined();
    expect(staging.waves[0]).toEqual({ name: "staging", runs: [{ target: "staging" }], gate: "on-destructive", environment: { name: "staging" } });
    const prod = stageWavesSpec(spec, "prod");
    expect(prod.approvals?.quorum).toEqual([{ count: 2, roles: ["sre"], notAuthor: true }]);
    expect(prod.holds).toEqual({ policy: true });
    expect(prod.waves[0]).toMatchObject({ gate: "always", approval: "sealed", failureTolerance: "25%" });
  });

  test("release.cut false leaves the cut out, and release.bin runs it as the product", () => {
    const off = asPipelineSpec({ ...spec, release: { cut: false } });
    expect(stageWavesSpec(off, "dev").waves[0]!.hooks).toBeUndefined();
    const bin = asPipelineSpec({ ...spec, release: { bin: ["npx", "--no-install", "plywood"], label: "next" } });
    expect(stageWavesSpec(bin, "dev").waves[0]!.hooks?.after?.apply?.[0]!.command).toEqual(["npx", "--no-install", "plywood", "release", "cut", "next", "--yes", "--wait-checks"]);
  });

  test("release.first names the version of a member's first release, which an auto cut takes by default at 0.1.0 (terragucci#1526)", () => {
    const named = asPipelineSpec({ ...spec, release: { first: "1.0.0" } });
    expect(stageWavesSpec(named, "dev").waves[0]!.hooks?.after?.apply?.[0]!.command).toEqual(["chant", "release", "cut", "auto", "--first", "1.0.0", "--yes", "--wait-checks"]);
    const word = asPipelineSpec({ ...spec, release: { bin: ["plywood"], label: "next", first: "0.0.1" } });
    expect(stageWavesSpec(word, "dev").waves[0]!.hooks?.after?.apply?.[0]!.command).toEqual(["plywood", "release", "cut", "next", "--first", "0.0.1", "--yes", "--wait-checks"]);
    const typed = asPipelineSpec({ ...spec, release: { label: "2.0.0" } });
    expect(stageWavesSpec(typed, "dev").waves[0]!.hooks?.after?.apply?.[0]!.command).toEqual(["chant", "release", "cut", "2.0.0", "--yes", "--wait-checks"]);
    expect(pipelineSpecProblems({ ...spec, release: { first: "0.1" } })).toContain("release.first must be a release version, such as 0.1.0 or v1.0.0");
  });

  test("an unknown stage is refused with the stages it has", () => {
    expect(() => stageWavesSpec(spec, "qa")).toThrow(/no stage "qa"; its stages are dev, staging, prod/);
  });

  test("the stage order is the promotion order", () => {
    expect(promotionOrderOf(asPipelineSpec({ ...spec, stages: spec.stages.map((s, i) => (i === 0 ? { ...s, canary: true, soak: { duration: "1h", checks: [{ kind: "drift" }] } } : s)) }))).toEqual([
      { name: "dev", canary: true },
      { name: "staging", canary: false },
      { name: "prod", canary: false },
    ]);
  });

  test("the gate is read at base from the folded stage, and the tolerance with it", () => {
    const prod = stageWavesSpec(spec, "prod");
    const text = JSON.stringify(prod);
    const rules = readOpWavePolicy(".chant/op-waves/shop-prod.spec.json", "prod", "base", "/", () => ({ sha: "b".repeat(40), text }));
    expect(rules).toMatchObject({ policy: "always", approval: "sealed", source: "base", quorum: [{ count: 2 }], holds: { policy: true }, failureTolerance: "25%" });
    const loose = JSON.stringify({ ...prod, waves: [{ ...prod.waves[0], failureTolerance: 4 }] });
    // A tolerance only the change has does not count.
    const atBase = JSON.stringify({ ...prod, waves: [{ ...prod.waves[0], failureTolerance: undefined }] });
    expect(readOpWavePolicy("s.json", "prod", "base", "/", () => ({ sha: "b".repeat(40), text: atBase })).failureTolerance).toBeUndefined();
    expect(parseOpWavesSpec(loose, "x").waves[0]!.failureTolerance).toBe(4);
  });

  test("a tolerance lets through a whole number of runs, or a share rounded down", () => {
    expect(opWaveToleratedFailures(undefined, 10)).toBe(0);
    expect(opWaveToleratedFailures(2, 10)).toBe(2);
    expect(opWaveToleratedFailures("25%", 4)).toBe(1);
    expect(opWaveToleratedFailures("10%", 9)).toBe(0);
  });
});

describe("holds and freeze windows", () => {
  const stage = { name: "prod", freeze: [{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: "year end" }] };

  test("a stage in a freeze window is held until it ends", () => {
    const held = stageHeldAt(stage, new Date("2026-12-25T00:00:00Z"))!;
    expect(held).toEqual({ stage: "prod", kind: "freeze", until: "2027-01-04T00:00:00Z", reason: "year end" });
    expect(stageHeldLine(held)).toBe('stage "prod" is in a freeze window until 2027-01-04T00:00:00Z (year end), so nothing is promoted into it');
    expect(stageHeldAt(stage, new Date("2027-01-04T00:00:00Z"))).toBeUndefined();
  });

  test("a manual hold holds until it lifts, or until a change lifts it", () => {
    expect(stageHeldAt({ name: "prod", hold: true }, new Date())).toEqual({ stage: "prod", kind: "hold", until: null });
    expect(stageHeldLine({ stage: "prod", kind: "hold", until: null })).toContain("until a change to the pipeline lifts the hold");
    expect(stageHeldAt({ name: "prod", hold: { until: "2026-12-01T00:00:00Z", reason: "launch" } }, new Date("2026-11-30T00:00:00Z"))).toMatchObject({ kind: "hold", until: "2026-12-01T00:00:00Z", reason: "launch" });
    expect(stageHeldAt({ name: "prod", hold: { until: "2026-12-01T00:00:00Z" } }, new Date("2026-12-02T00:00:00Z"))).toBeUndefined();
  });
});

describe("what a promote reads", () => {
  const spec = folded();
  const now = new Date("2026-11-19T00:00:00Z");

  test("--from defaults to the stage before, and the first stage has none", () => {
    expect(pipelinePromoteSource({ spec, to: "staging", now })).toEqual({ from: "dev", skipped: [] });
    expect(pipelinePromoteSource({ spec, to: "dev", now })).toMatchObject({ exitCode: 1, code: "promote-no-previous-environment" });
    expect(pipelinePromoteSource({ spec, to: "qa", now })).toBeUndefined();
  });

  test("a held or frozen stage refuses with exit 3 and says until when", () => {
    expect(pipelinePromoteSource({ spec, to: "prod", now: new Date("2026-12-25T00:00:00Z") })).toMatchObject({ exitCode: 3, code: "pipeline-stage-held", message: expect.stringContaining("until 2027-01-04T00:00:00Z") });
  });

  test("a skip is refused without --allow-skip, and a held stage cannot be skipped", () => {
    expect(pipelinePromoteSource({ spec, to: "prod", from: "dev", now })).toMatchObject({ exitCode: 1, code: "promote-skips-environment", message: expect.stringContaining("skips staging") });
    const allowed = pipelinePromoteSource({ spec, to: "prod", from: "dev", allowSkip: true, now });
    expect(allowed).toMatchObject({ from: "dev", skipped: [{ name: "staging" }] });
    const heldStaging = asPipelineSpec({ ...spec, stages: spec.stages.map((s) => (s.name === "staging" ? { ...s, hold: true as const } : s)) });
    expect(pipelinePromoteSource({ spec: heldStaging, to: "prod", from: "dev", allowSkip: true, now })).toMatchObject({ exitCode: 3, code: "pipeline-stage-held" });
  });

  test("--allow-skip passes only through the skipped stage's gate, and the ledger records the skip", async () => {
    const digest = "sha256:" + "a".repeat(64);
    const port = memoryGateLedgerPort();
    const waiting = await pipelinePromoteGates({ spec, to: "prod", skipped: [spec.stages[1]!], digest, port, now });
    expect(waiting).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-gate-waiting", message: expect.stringContaining("staging-skip") });
    expect(port.appended[0]).toMatchObject({ op: "shop", gate: "staging-skip", planDigest: digest, environment: "staging" });
    expect(port.applied).toEqual([]);

    const approved = memoryGateLedgerPort({
      pending: port.appended,
      resolutions: [
        { version: 1, op: "shop", gate: "staging-skip", resolvedBy: "alice", timestamp: "2026-11-19T00:00:01Z", planDigest: digest, environment: "staging" } as never,
      ],
    });
    const prodWaits = await pipelinePromoteGates({ spec, to: "prod", skipped: [spec.stages[1]!], digest, port: approved, now: new Date("2026-11-19T00:01:00Z") });
    // The skip went through and was recorded; the stage's own gate waits.
    expect(approved.applied).toEqual([expect.objectContaining({ op: "shop", gate: "staging-skip", planDigest: digest, approvedBy: "alice" })]);
    expect(prodWaits).toMatchObject({ passed: false, message: expect.stringContaining("shop prod waits") });
  });

  test("a skipped stage whose gate never waits is recorded and passes", async () => {
    const never = asPipelineSpec({ ...spec, stages: spec.stages.map((s) => (s.name === "staging" ? { ...s, gate: { policy: "never" as const } } : s.name === "prod" ? { ...s, gate: { policy: "never" as const } } : s)) });
    const port = memoryGateLedgerPort();
    const out = await pipelinePromoteGates({ spec: never, to: "prod", skipped: [never.stages[1]!], digest: "sha256:x", port, now });
    expect(out).toEqual({ passed: true, lines: ["skipped staging: its gate never waits", "stage prod: its gate never waits"] });
    expect(port.applied).toEqual([expect.objectContaining({ gate: "staging-skip", approvedBy: "gate-policy-never" })]);
  });

  test("the stage gate passes on an approval of the release's digest", async () => {
    const digest = "sha256:" + "b".repeat(64);
    const port = memoryGateLedgerPort({ resolutions: [{ version: 1, op: "shop", gate: "staging", resolvedBy: "bob", timestamp: "2026-11-19T00:00:01Z", planDigest: digest, environment: "staging" } as never] });
    await expect(pipelinePromoteGates({ spec, to: "staging", skipped: [], digest, port, now })).resolves.toMatchObject({ passed: true, lines: ["stage staging: shop staging approved by bob"] });
  });

  test("the digest of the promoted components does not depend on their order", () => {
    expect(promotedDigest([{ component: "a", digest: "1" }, { component: "b", digest: "2" }])).toBe(promotedDigest([{ component: "b", digest: "2" }, { component: "a", digest: "1" }]));
  });
});

// The products' own config shapes, as each reads them (#5343's keys).
const terragucci = {
  promotion: ["dev", "staging", "prod"],
  gate: "on-destructive" as const,
  approval_rules: [{ count: 2, roles: ["sre"], not_author: true }],
  environments: { dev: { gate: "never" as const }, staging: {}, prod: { gate: "always" as const, approval: { mode: "sealed" as const }, forge_environment: "production" } },
};
const plywood = {
  promotion: ["dev", "prod"],
  approval_rules: { prod: { count: 1, roles: ["ops"] }, lead: { count: 1, not_author: true } },
  environments: { prod: { hold: { reason: "launch", until: "2026-12-01T00:00:00Z" }, freeze: [{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z" }] } },
};
const sqlYodeler = {
  ci: {
    promotion: ["dev", "prod"],
    environments: { dev: { gate: "never" as const }, prod: { gate: "always" as const, failureTolerance: "10%" as const } },
  },
};

describe("the product helpers on each product's config shape", () => {
  test("terragucci: a gate per environment, approval rules, the forge environment", () => {
    const d = pipelineFromConfig({
      name: "tf-apply",
      promotion: terragucci.promotion,
      gate: terragucci.gate,
      approvalRules: terragucci.approval_rules,
      environments: terragucci.environments,
      defaults: { op: "tf-apply", step: { kind: "terragrunt-apply", unit: "{target}" } },
      waves: Object.fromEntries(terragucci.promotion.map((env) => [env, [{ name: env, runs: [], discover: true, together: true }]])),
      release: { bin: ["terragucci"] },
    });
    expect(d.stages.map((s) => [s.name, s.gate?.policy, s.gate?.approval])).toEqual([["dev", "never", undefined], ["staging", "on-destructive", undefined], ["prod", "always", "sealed"]]);
    expect(d.stages[2]!.gate?.quorum).toEqual([{ count: 2, roles: ["sre"], notAuthor: true }]);
    expect(d.stages[2]!.forgeEnvironment).toEqual({ name: "production" });
    expect(stageWavesSpec(asPipelineSpec(d), "dev").waves[0]!.hooks?.after?.apply?.[0]!.command).toEqual(["terragucci", "release", "cut", "auto", "--first", "0.1.0", "--yes", "--wait-checks"]);
  });

  test("plywood: named approval rules, a hold and a freeze window", () => {
    const d = pipelineFromConfig({
      name: "shop",
      promotion: plywood.promotion,
      approvalRules: plywood.approval_rules,
      environments: plywood.environments,
      defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
      waves: { dev: [{ name: "dev", runs: [{ target: "shop-dev" }] }], prod: [{ name: "prod", runs: [{ target: "shop-prod" }] }] },
    });
    expect(d.stages[0]!.gate?.quorum).toEqual([{ count: 1, notAuthor: true }, { count: 1, roles: ["ops"] }]);
    expect(d.stages[1]).toMatchObject({ hold: { reason: "launch", until: "2026-12-01T00:00:00Z" }, freeze: [{ from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z" }] });
  });

  test("sql-yodeler: camelCase keys under ci, and a failure tolerance for a wave of many databases", () => {
    const tenants = Array.from({ length: 20 }, (_, i) => ({ target: `prod/tenant-${i}` }));
    const d = pipelineFromConfig({
      name: "migrations",
      promotion: sqlYodeler.ci.promotion,
      environments: sqlYodeler.ci.environments,
      defaults: { op: "migrate", step: { kind: "sql-migrate", database: "{target}" } },
      waves: { dev: [{ name: "dev", runs: [{ target: "dev/main" }] }], prod: [{ name: "prod", runs: tenants, parallelism: 4 }] },
    });
    const prod = stageWavesSpec(asPipelineSpec(d), "prod");
    expect(prod.waves[0]).toMatchObject({ gate: "always", failureTolerance: "10%", parallelism: 4 });
    expect(opWaveToleratedFailures(prod.waves[0]!.failureTolerance, prod.waves[0]!.runs.length)).toBe(2);
  });

  test("a promotion stage with no waves is refused", () => {
    expect(() => pipelineFromConfig({ name: "x", promotion: ["dev", "prod"], waves: { dev: [{ name: "dev", runs: [] }] } })).toThrow(/promotion names prod, and no waves were given for it/);
  });

  test("the written file folds back to the declaration, and ci --check fails while the committed file is stale", () => {
    const d = pipelineFromConfig({ name: "shop", promotion: ["dev", "prod"], environments: plywood.environments, waves: { dev: [{ name: "dev", runs: [{ target: "dev" }] }], prod: [{ name: "prod", runs: [{ target: "prod" }] }] } });
    const options = { product: "plywood", config: "plywood.yml", command: "plywood ci" };
    const text = pipelineSource(d, options);
    expect(text.split("\n").slice(0, 3)).toEqual([
      "// Written by plywood from plywood.yml. Change the config and run `plywood ci`;",
      "// `plywood ci --check` fails while this file differs from what the config writes.",
      'import { pipeline } from "@intentius/chant/pipeline";',
    ]);
    const back = foldPipelineSource(text);
    expect("spec" in back && back.spec).toEqual({ ...d, kind: PIPELINE_SPEC_KIND });

    const dir = mkdtempSync(join(tmpdir(), "chant-5324-check-"));
    expect(checkPipelineFile(dir, text, options)).toMatchObject({ status: "missing", message: expect.stringContaining("run `plywood ci`") });
    expect(writePipelineFile(dir, text)).toBe(true);
    expect(writePipelineFile(dir, text)).toBe(false);
    expect(checkPipelineFile(dir, text, options)).toEqual({ status: "current", file: PIPELINE_FILE });
    writeFileSync(join(dir, PIPELINE_FILE), text.replace('"prod"', '"production"'));
    const stale = checkPipelineFile(dir, text, options);
    expect(stale).toMatchObject({ status: "stale", message: expect.stringContaining("is not what the config writes") });
    expect(stale.status === "stale" && stale.diff.some((l) => l.startsWith("-") && l.includes("production"))).toBe(true);
    writeFileSync(join(dir, PIPELINE_FILE), text.replace("export default pipeline({", "export default pipeline({ x: process.env.X,"));
    expect(checkPipelineFile(dir, text, options)).toMatchObject({ status: "stale", message: expect.stringContaining("does not fold") });
  });
});

describe("a rendered spec is checked against the fold's schema", () => {
  const spec = folded();
  const parse = (t: string, w: string) => parseOpWavesSpec(t, w);

  test("a folded pipeline document becomes the stage the job names", () => {
    const out = JSON.parse(checkRenderedWavesSpec(JSON.stringify(spec), "r", parse, { CHANT_PIPELINE_STAGE: "staging" }));
    expect(out).toEqual(stageWavesSpec(spec, "staging"));
    expect(JSON.parse(checkRenderedWavesSpec(JSON.stringify(spec), "r", parse, {})).name).toBe("shop-dev");
  });

  test("an op-waves spec passes as printed, and one the fold could not produce is refused", () => {
    const ok = JSON.stringify(stageWavesSpec(spec, "dev"));
    expect(checkRenderedWavesSpec(ok, "r", parse, {})).toBe(ok);
    const bad = JSON.stringify({ ...stageWavesSpec(spec, "dev"), waves: [{ name: "dev", runs: [], failureTolerance: "many" }] });
    expect(() => checkRenderedWavesSpec(bad, "r", parse, {})).toThrow(/does not check against the pipeline's schema/);
    expect(() => checkRenderedWavesSpec(JSON.stringify({ ...spec, stages: [] }), "r", parse, {})).toThrow(/at least one stage/);
  });
});

describe("the folded spec's diff", () => {
  test("a line diff marks what was removed and added, and nothing for no change", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c"])).toEqual([" a", "-b", "+x", " c"]);
    expect(lineDiff(["a"], ["a"])).toEqual([]);
  });

  test("a pull request that changes the pipeline gets its folded diff, and a refused head says so", () => {
    const files: Record<string, string> = { base: FILE, head: FILE.replace('policy: "never"', 'policy: "always"') };
    const show = (c: string) => files[c] ?? null;
    const change = pipelineChange("base", "head", "/", show)!;
    expect(change.diff.filter((l) => /^[-+]/.test(l))).toEqual(['-        "policy": "never"', '+        "policy": "always"']);
    expect(pipelineChangeSection(change)).toContain("```diff");
    expect(pipelineChange("base", "base", "/", show)).toBeUndefined();
    files.bad = FILE.replace("const runner", "let runner");
    expect(pipelineChangeSection(pipelineChange("base", "bad", "/", show)!)).toContain("does not fold at the head");
    expect(pipelineChange("none", "none", "/", () => null)).toBeUndefined();
  });
});

describe("reading a member's pipeline", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  test("from the working tree and at a commit, and the stage order is the member's promotion order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-5324-read-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "commit", "-q", "--allow-empty", "-m", "empty");
    const empty = git(dir, "rev-parse", "HEAD");
    mkdirSync(join(dir, ".chant"));
    writeFileSync(join(dir, PIPELINE_FILE), FILE);
    git(dir, "add", PIPELINE_FILE);
    git(dir, "commit", "-q", "-m", "pipeline");
    const head = git(dir, "rev-parse", "HEAD");
    expect(readMemberPipeline(dir)).toMatchObject({ status: "folded", spec: { name: "shop" } });
    expect(readPipelineAt(head, dir)).toMatchObject({ status: "folded" });
    expect(readPipelineAt(empty, dir)).toEqual({ status: "absent" });
    expect(await readMemberPromotionOrder(dir)).toEqual([{ name: "dev", canary: false }, { name: "staging", canary: false }, { name: "prod", canary: false }]);
    // The plan note's section: the folded diff between the two commits, and none for a commit the checkout lacks.
    expect(pipelineNoteSection(empty, head, dir)).toContain('+  "name": "shop",');
    expect(pipelineNoteSection(head, head, dir)).toBeUndefined();
    expect(pipelineNoteSection(empty, "f".repeat(40), dir)).toBeUndefined();
    writeFileSync(join(dir, PIPELINE_FILE), FILE.replace("const runner", "let runner"));
    expect(readMemberPipeline(dir)).toMatchObject({ status: "refused", line: expect.stringContaining("[EVL012]") });
    expect(await readMemberPromotionOrder(dir)).toBeNull();
  });
});

describe("chant lint shows the fold's finding (EVL012)", () => {
  test("the same rule id and line as the build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-5324-lint-"));
    mkdirSync(join(dir, ".chant"));
    const file = join(dir, PIPELINE_FILE);
    writeFileSync(file, FILE.replace('runner = "ubuntu-latest"', "runner = process.env.RUNNER"));
    const { diagnostics } = await runLint([file], [evl012PipelineFoldRule]);
    expect(diagnostics).toEqual([expect.objectContaining({ ruleId: "EVL001", line: 3, severity: "error" })]);
    writeFileSync(file, FILE);
    expect((await runLint([file], [evl012PipelineFoldRule])).diagnostics).toEqual([]);
    // A lexicon's src/pipeline.ts is not a pipeline declaration.
    const other = join(dir, "pipeline.ts");
    writeFileSync(other, "export const x = 1;\n");
    expect((await runLint([other], [evl012PipelineFoldRule])).diagnostics).toEqual([]);
  });
});

describe("the forge jobs", () => {
  test("the first stage's waves render their spec from chant pipeline spec, and later stages get promote jobs", async () => {
    const spec = folded();
    const calls: unknown[] = [];
    const plugin = {
      generateOpWavesPipeline: (s: unknown, o: unknown) => (calls.push(["waves", s, o]), { files: [{ name: "shop-dev.yml", yaml: "w" }], jobs: [] }),
      generatePipelinePromote: (i: unknown) => (calls.push(["promote", i]), [{ name: "shop-promote.yml", yaml: "p" }]),
    } as never;
    const out = await generatePipeline(spec, "github", { bin: "npx --no-install plywood" }, plugin);
    expect(out.files?.map((f) => f.name)).toEqual(["shop-dev.yml", "shop-promote.yml"]);
    expect(calls[0]).toEqual(["waves", stageWavesSpec(spec, "dev"), expect.objectContaining({ specFile: ".chant/op-waves/shop-dev.spec.json", renderSpec: { command: ["npx", "--no-install", "plywood", "pipeline", "spec", "--stage", "dev"] } })]);
    expect(calls[1]).toEqual(["promote", { pipeline: "shop", stages: [{ name: "staging", environment: { name: "staging" } }, { name: "prod" }], bin: "npx --no-install plywood", runner: "ubuntu-latest" }]);
    await expect(generatePipeline(spec, "prow", {}, null)).resolves.toMatchObject({ success: false, error: expect.stringContaining("does not render a pipeline") });
  });

  test("agentFacts naming verify-failed reaches the promote jobs too (#5339); naming apply-failed alone, only the waves", async () => {
    const spec = folded();
    const promotes: Array<Record<string, unknown>> = [];
    const plugin = {
      generateOpWavesPipeline: () => ({ files: [], jobs: [] }),
      generatePipelinePromote: (i: Record<string, unknown>) => (promotes.push(i), []),
    } as never;
    await generatePipeline(spec, "github", { agentFacts: { relayKeyEnv: "OPS_RELAY", triggers: ["apply-failed", "verify-failed"] } }, plugin);
    await generatePipeline(spec, "github", { agentFacts: { relayKeyEnv: "OPS_RELAY" } }, plugin);
    expect(promotes[0]!.agentFacts).toEqual({ relayKeyEnv: "OPS_RELAY" });
    expect(promotes[1]!.agentFacts).toBeUndefined();
  });
});

test("the floor names the next release", () => {
  expect(PIPELINE_FLOOR).toBe(NEXT_RELEASE);
  expect(readFileSync(join(__dirname, "..", "floor-table.data.ts"), "utf-8")).toContain("PIPELINE_FLOOR");
});
