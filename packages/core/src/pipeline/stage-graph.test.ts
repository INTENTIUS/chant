/**
 * Stages with several upstream stages, and one release per stage at a time
 * (#5353): the `after` and `queue` keys, the cycle refused at build, the
 * fan-out to two regions joined before production, a waiting release
 * replaced, and the stage log as `workspace status` reads it.
 */
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import {
  asPipelineSpec,
  foldPipelineSource,
  memoryStageLogPort,
  pipelineFromConfig,
  pipelinePromoteSource,
  pipelineSpecProblems,
  pipelineStageEntry,
  pipelineStageFinished,
  stageQueueOf,
  STAGE_GRAPH_FLOOR,
  type PipelineEntryRelease,
  type PipelineSpec,
  type StageLine,
} from "../pipeline";
import { stageCycle, stageUpstreams } from "./spec";
import { readMemberStageQueues } from "../workspace/status-gates";
import { PRODUCT_CONFIG_WORDS } from "../ci-product-words";
import { NEXT_RELEASE } from "../release-floors";

const wave = (name: string) => ({ name, runs: [{ target: name }] });
const stage = (name: string, extra: Record<string, unknown> = {}) => ({ name, waves: [wave(name)], ...extra });

/** dev fans out to us and eu, which join again before prod. */
function regions(prod: Record<string, unknown> = {}): PipelineSpec {
  return asPipelineSpec({
    name: "shop",
    defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" } },
    stages: [
      stage("dev", { gate: { policy: "never" } }),
      stage("us", { after: ["dev"], gate: { policy: "never" } }),
      stage("eu", { after: ["dev"], gate: { policy: "never" } }),
      stage("prod", { after: ["us", "eu"], gate: { policy: "never" }, ...prod }),
    ],
  });
}

const release = (label: string, cutAt: string): PipelineEntryRelease => ({ releaseDigest: `sha256:${label}`, label, commit: `commit-${label}`, cutAt });
const now = new Date("2026-11-20T10:00:00Z");

describe("the stage graph", () => {
  test("each stage follows its after, else the stage before it", () => {
    const spec = regions();
    expect(stageUpstreams(spec, "dev")).toEqual([]);
    expect(stageUpstreams(spec, "eu")).toEqual(["dev"]);
    expect(stageUpstreams(spec, "prod")).toEqual(["us", "eu"]);
    const plain = asPipelineSpec({ name: "shop", stages: [stage("dev"), stage("staging")] });
    expect(stageUpstreams(plain, "staging")).toEqual(["dev"]);
    expect(stageCycle(spec)).toBeUndefined();
  });

  test("a cycle between stages is refused at build, naming the stages", () => {
    const text = `import { pipeline } from "@intentius/chant/pipeline";
export default pipeline({
  name: "shop",
  stages: [
    { name: "dev", waves: [{ name: "dev" }] },
    { name: "us", waves: [{ name: "us" }], after: ["eu"] },
    { name: "eu", waves: [{ name: "eu" }], after: ["us"] },
  ],
});
`;
    const folded = foldPipelineSource(text);
    expect("finding" in folded).toBe(true);
    if (!("finding" in folded)) return;
    expect(folded.finding.ruleId).toBe("EVL012");
    expect(folded.finding.message).toMatch(/the stages (us -> eu -> us|eu -> us -> eu) form a cycle/);
  });

  test("a cycle through the stage before is a cycle too", () => {
    const problems = pipelineSpecProblems({ name: "shop", stages: [stage("dev"), stage("a", { after: ["b"] }), stage("b")] });
    expect(problems.join("; ")).toMatch(/the stages .*a.*b.* form a cycle/);
  });

  test("after is checked: known stages, not itself, not on the first stage, once each", () => {
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev"), stage("prod", { after: ["qa"] })] })).toEqual([
      expect.stringContaining('stage "prod".after names qa, which the pipeline has no stage for'),
    ]);
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev"), stage("prod", { after: ["prod"] })] })).toContain('stage "prod".after names the stage itself');
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev", { after: ["prod"] }), stage("prod")] })).toContain('stage "dev" is the first stage, the one a merge applies, so it takes no after');
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev"), stage("prod", { after: ["dev", "dev"] })] })).toContain('stage "prod".after names dev twice');
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev"), stage("prod", { after: [] })] })).toContain('stage "prod".after must list the names of one or more stages');
    expect(pipelineSpecProblems({ name: "shop", stages: [stage("dev"), stage("prod", { queue: "all" })] })).toContain('stage "prod".queue is replace');
  });

  test("a stage with after takes --from from the stages it names", () => {
    const spec = regions();
    expect(pipelinePromoteSource({ spec, to: "prod", now })).toEqual({ from: "us", skipped: [], upstreams: ["us", "eu"] });
    expect(pipelinePromoteSource({ spec, to: "prod", from: "eu", now })).toEqual({ from: "eu", skipped: [], upstreams: ["us", "eu"] });
    expect(pipelinePromoteSource({ spec, to: "prod", from: "dev", now })).toMatchObject({ exitCode: 1, code: "pipeline-from-not-upstream" });
  });
});

describe("fan out to two regions and join before production", () => {
  test("prod opens only once the same release applied in us and in eu", async () => {
    const spec = regions();
    const log = memoryStageLogPort();
    const port = memoryGateLedgerPort();
    const v1 = release("v1", "2026-11-20T09:00:00Z");
    const firstStageCommits = new Set([v1.commit]);
    const enter = (to: string, rel: PipelineEntryRelease, upstreams?: string[]) =>
      pipelineStageEntry({ spec, to, skipped: [], ...(upstreams ? { upstreams } : {}), digest: rel.releaseDigest, release: rel, firstStageCommits, port, log, now });

    // us and eu each follow dev, which applied the release's commit.
    const us = await enter("us", v1, ["dev"]);
    expect(us).toMatchObject({ passed: true, entered: { kind: "entered", stage: "us", digest: "sha256:v1" } });
    await pipelineStageFinished(log, (us as { entered: StageLine }).entered, "applied", now);

    // prod waits for eu.
    const early = await enter("prod", v1, ["us", "eu"]);
    expect(early).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-upstream-waiting", message: expect.stringContaining("not applied in eu yet") });

    // A failed deploy into eu does not open prod.
    const eu = await enter("eu", v1, ["dev"]);
    await pipelineStageFinished(log, (eu as { entered: StageLine }).entered, "failed", now);
    expect(await enter("prod", v1, ["us", "eu"])).toMatchObject({ passed: false, code: "pipeline-upstream-waiting" });

    const euAgain = await enter("eu", v1, ["dev"]);
    await pipelineStageFinished(log, (euAgain as { entered: StageLine }).entered, "applied", now);
    expect(await enter("prod", v1, ["us", "eu"])).toMatchObject({ passed: true, entered: { stage: "prod", digest: "sha256:v1" } });

    // A release whose commit dev never applied does not open us.
    const v2 = release("v2", "2026-11-20T09:30:00Z");
    const usV2 = await enter("us", v2, ["dev"]);
    expect(usV2).toMatchObject({ passed: false, code: "pipeline-upstream-waiting", message: expect.stringContaining("not applied in dev") });
  });

  test("the join goes through its own gate after the upstream stages", async () => {
    const spec = regions({ gate: { policy: "always" } });
    const log = memoryStageLogPort([
      { version: 1, kind: "finished", result: "applied", op: "shop", stage: "us", digest: "sha256:v1", timestamp: "2026-11-20T09:10:00Z" },
      { version: 1, kind: "finished", result: "applied", op: "shop", stage: "eu", digest: "sha256:v1", timestamp: "2026-11-20T09:20:00Z" },
    ]);
    const port = memoryGateLedgerPort();
    const out = await pipelineStageEntry({ spec, to: "prod", skipped: [], upstreams: ["us", "eu"], digest: "sha256:v1", release: release("v1", "2026-11-20T09:00:00Z"), port, log, now });
    expect(out).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-gate-waiting" });
    expect(port.appended[0]).toMatchObject({ op: "shop", gate: "prod", planDigest: "sha256:v1", environment: "prod" });
    expect(log.lines.some((l) => l.kind === "entered" && l.stage === "prod")).toBe(false);
  });

  test("a join needs a release, and --allow-skip takes each missing stage through its skip gate", async () => {
    const spec = regions();
    const log = memoryStageLogPort([{ version: 1, kind: "finished", result: "applied", op: "shop", stage: "us", digest: "sha256:v1", timestamp: "2026-11-20T09:10:00Z" }]);
    const port = memoryGateLedgerPort();
    const noRelease = await pipelineStageEntry({ spec, to: "prod", skipped: [], upstreams: ["us", "eu"], digest: "sha256:x", port, log, now });
    expect(noRelease).toMatchObject({ passed: false, exitCode: 1, code: "pipeline-join-needs-release" });

    const skipped = await pipelineStageEntry({ spec, to: "prod", skipped: [], upstreams: ["us", "eu"], allowSkip: true, digest: "sha256:v1", release: release("v1", "2026-11-20T09:00:00Z"), port, log, now });
    expect(skipped).toMatchObject({ passed: true, lines: ["skipped eu: its gate never waits", "stage prod: its gate never waits"] });
    expect(port.applied).toEqual([expect.objectContaining({ gate: "eu-skip", planDigest: "sha256:v1" })]);
  });

  test("a pipeline with neither after nor queue writes no stage line", async () => {
    const spec = asPipelineSpec({ name: "shop", stages: [stage("dev"), stage("prod", { gate: { policy: "never" } })] });
    const log = memoryStageLogPort();
    const out = await pipelineStageEntry({ spec, to: "prod", skipped: [], digest: "sha256:v1", port: memoryGateLedgerPort(), log, now });
    expect(out).toEqual({ passed: true, lines: ["stage prod: its gate never waits"] });
    expect(log.lines).toEqual([]);
  });
});

describe("one release per stage at a time", () => {
  const applied = (stage: string, digest: string): StageLine => ({ version: 1, kind: "finished", result: "applied", op: "shop", stage, digest, timestamp: "2026-11-20T08:00:00Z" });
  const upstream = (...digests: string[]) => digests.flatMap((d) => [applied("us", d), applied("eu", d)]);

  test("a newer release waiting replaces an older one; the older is refused after", async () => {
    const spec = regions({ gate: { policy: "always" }, queue: "replace" });
    const log = memoryStageLogPort(upstream("sha256:v1", "sha256:v2"));
    const port = memoryGateLedgerPort();
    const v1 = release("v1", "2026-11-20T09:00:00Z");
    const v2 = release("v2", "2026-11-20T09:30:00Z");
    const enter = (rel: PipelineEntryRelease, at: Date) =>
      pipelineStageEntry({ spec, to: "prod", skipped: [], upstreams: ["us", "eu"], digest: rel.releaseDigest, release: rel, port, log, now: at });

    expect(await enter(v1, new Date("2026-11-20T10:00:00Z"))).toMatchObject({ passed: false, code: "pipeline-gate-waiting" });
    expect(stageQueueOf(log.lines, "prod").waiting.map((w) => w.label)).toEqual(["v1"]);

    // v2 reaches prod while v1 still waits for its approval: v1 is replaced.
    expect(await enter(v2, new Date("2026-11-20T10:05:00Z"))).toMatchObject({ passed: false, code: "pipeline-gate-waiting" });
    const queue = stageQueueOf(log.lines, "prod");
    expect(queue.waiting.map((w) => w.label)).toEqual(["v2"]);
    expect(queue.replaced).toEqual([expect.objectContaining({ kind: "replaced", digest: "sha256:v1", label: "v1", by: "sha256:v2", byLabel: "v2", timestamp: "2026-11-20T10:05:00.000Z" })]);

    // An approval of v1 no longer lets it in.
    const refused = await enter(v1, new Date("2026-11-20T10:10:00Z"));
    expect(refused).toMatchObject({ passed: false, exitCode: 1, code: "pipeline-release-replaced", message: expect.stringContaining("replaced at stage \"prod\" by v2 (sha256:v2)") });
  });

  test("an older release reaching a stage a newer one waits for is replaced itself", async () => {
    const spec = regions({ queue: "replace", gate: { policy: "always" } });
    const log = memoryStageLogPort(upstream("sha256:v1", "sha256:v2"));
    const port = memoryGateLedgerPort();
    const enter = (rel: PipelineEntryRelease) => pipelineStageEntry({ spec, to: "prod", skipped: [], upstreams: ["us", "eu"], digest: rel.releaseDigest, release: rel, port, log, now });
    await enter(release("v2", "2026-11-20T09:30:00Z"));
    const older = await enter(release("v1", "2026-11-20T09:00:00Z"));
    expect(older).toMatchObject({ passed: false, exitCode: 1, code: "pipeline-release-replaced" });
    expect(stageQueueOf(log.lines, "prod")).toMatchObject({ waiting: [expect.objectContaining({ label: "v2" })], replaced: [expect.objectContaining({ label: "v1", byLabel: "v2" })] });
  });

  test("a release in the stage finishes; the next waits for it, then enters", async () => {
    const spec = regions({ queue: "replace" });
    const log = memoryStageLogPort(upstream("sha256:v1", "sha256:v2", "sha256:v3"));
    const port = memoryGateLedgerPort();
    const enter = (rel: PipelineEntryRelease) => pipelineStageEntry({ spec, to: "prod", skipped: [], upstreams: ["us", "eu"], digest: rel.releaseDigest, release: rel, port, log, now });
    const v1 = release("v1", "2026-11-20T09:00:00Z");
    const v2 = release("v2", "2026-11-20T09:30:00Z");
    const v3 = release("v3", "2026-11-20T09:45:00Z");

    const first = await enter(v1);
    expect(first).toMatchObject({ passed: true, entered: { kind: "entered", digest: "sha256:v1" } });

    // v2 arrives while v1 deploys: it waits, and v1 is not replaced.
    expect(await enter(v2)).toMatchObject({ passed: false, exitCode: 3, code: "pipeline-stage-busy", message: expect.stringContaining("v1 (sha256:v1) is in it") });
    // v3 arrives: it replaces v2, which waited, and waits too.
    expect(await enter(v3)).toMatchObject({ passed: false, code: "pipeline-stage-busy" });
    expect(stageQueueOf(log.lines, "prod")).toMatchObject({
      inStage: expect.objectContaining({ label: "v1" }),
      waiting: [expect.objectContaining({ label: "v3" })],
      replaced: [expect.objectContaining({ label: "v2", byLabel: "v3" })],
    });

    // v1's promote run again carries on as the release in the stage.
    expect(await enter(v1)).toMatchObject({ passed: true, lines: [expect.stringContaining("is in the stage")] });
    await pipelineStageFinished(log, (first as { entered: StageLine }).entered, "applied", now);

    expect(await enter(v3)).toMatchObject({ passed: true, entered: { digest: "sha256:v3" } });
    expect(await enter(v2)).toMatchObject({ passed: false, code: "pipeline-release-replaced" });
  });

  test("workspace status reads the replacement from the stage log", async () => {
    const lines: StageLine[] = [
      { version: 1, kind: "entered", op: "shop", stage: "prod", digest: "sha256:v1", label: "v1", timestamp: "2026-11-20T10:00:00Z" },
      { version: 1, kind: "waiting", op: "shop", stage: "prod", digest: "sha256:v2", label: "v2", timestamp: "2026-11-20T10:01:00Z" },
      { version: 1, kind: "replaced", op: "shop", stage: "prod", digest: "sha256:v2", label: "v2", by: "sha256:v3", byLabel: "v3", timestamp: "2026-11-20T10:02:00Z" },
      { version: 1, kind: "waiting", op: "shop", stage: "prod", digest: "sha256:v3", label: "v3", timestamp: "2026-11-20T10:02:00Z" },
    ];
    const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json\n`;
    const queues = await readMemberStageQueues("_gates", "abc", "/nowhere", async (dir) => {
      expect(dir).toBe("_gates");
      return new Map([["shop", text]]);
    });
    expect(queues).toEqual([
      {
        pipeline: "shop",
        stage: "prod",
        inStage: { digest: "sha256:v1", label: "v1", at: "2026-11-20T10:00:00Z" },
        waiting: [{ digest: "sha256:v3", label: "v3", at: "2026-11-20T10:02:00Z" }],
        replaced: [{ digest: "sha256:v2", label: "v2", at: "2026-11-20T10:02:00Z", by: "sha256:v3", byLabel: "v3" }],
      },
    ]);
    expect(await readMemberStageQueues("_gates", null, "/nowhere")).toEqual([]);
  });
});

describe("the keys products write", () => {
  test("pipelineFromConfig maps environments.<name>.after and .queue", () => {
    const declaration = pipelineFromConfig({
      name: "shop",
      promotion: ["dev", "us", "eu", "prod"],
      environments: { eu: { after: ["dev"] }, prod: { after: ["us", "eu"], queue: "replace" } },
      waves: { dev: [wave("dev")], us: [wave("us")], eu: [wave("eu")], prod: [wave("prod")] },
    });
    expect(declaration.stages.map((s) => [s.name, s.after, s.queue])).toEqual([
      ["dev", undefined, undefined],
      ["us", undefined, undefined],
      ["eu", ["dev"], undefined],
      ["prod", ["us", "eu"], "replace"],
    ]);
  });

  test("the vocabulary carries both keys, and the floor names the next release", () => {
    expect(PRODUCT_CONFIG_WORDS.find((w) => w.key === "environments.<name>.after")).toMatchObject({ section: "stage" });
    expect(PRODUCT_CONFIG_WORDS.find((w) => w.key === "environments.<name>.queue")).toMatchObject({ section: "stage", values: ["replace"] });
    expect(STAGE_GRAPH_FLOOR).toBe(NEXT_RELEASE);
  });
});
