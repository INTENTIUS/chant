/**
 * #5475: a component run into an environment a pipeline stage gates waits at
 * that stage's gate, the same fact a promote into the stage waits on, read
 * from the pipeline at base.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { memoryGateLedgerPort } from "../op/gate";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import { memoryStageLogPort } from "../lifecycle/stage-log";
import type { DriverComponent } from "../components/driver";
import { asPipelineSpec, PIPELINE_FILE, type PipelineGate, type PipelineSpec } from "./spec";
import { pipelineStageEntry } from "./promote";
import { componentRunStageGate, runStageAtBase, runStageDigest, runStageOf } from "./run-gate";

const RELEASE = "sha256:" + "1".repeat(64);
const now = new Date("2026-11-21T01:00:00.000Z");

function specWith(gate: PipelineGate): PipelineSpec {
  const wave = (target: string) => [{ name: target, runs: [{ target }] }];
  return asPipelineSpec({
    name: "shop",
    stages: [
      { name: "dev", waves: wave("dev"), gate: { policy: "never" } },
      { name: "staging", waves: wave("staging"), gate },
    ],
  });
}

/** An approval of gate staging, as `chant approve shop staging --env staging --plan <digest>` records it. */
function approval(planDigest = RELEASE, timestamp = "2026-11-21T00:40:00.000Z"): GateResolutionRecord {
  return { version: 1, op: "shop", gate: "staging", resolvedBy: "bob", timestamp, planDigest, environment: "staging" };
}

const run = (spec: PipelineSpec, port: ReturnType<typeof memoryGateLedgerPort>, digest = RELEASE) =>
  componentRunStageGate({ spec, env: "staging", digest, releaseDigest: digest, port, now });

describe("a component run into a gated stage", () => {
  test("waits at the stage's gate, and one approval lets it through", async () => {
    const spec = specWith({ policy: "always" });
    const port = memoryGateLedgerPort();
    const waiting = await run(spec, port);
    expect(waiting).toMatchObject({ passed: false, stop: { exitCode: 3, code: "pipeline-gate-waiting" } });
    if (!waiting.passed) expect(waiting.stop.hint).toBe(`chant approve shop staging --env staging --plan ${RELEASE}`);
    expect(port.appended).toEqual([expect.objectContaining({ op: "shop", gate: "staging", environment: "staging", planDigest: RELEASE })]);

    const approved = await run(spec, memoryGateLedgerPort({ resolutions: [approval()] }));
    expect(approved).toEqual({ passed: true, lines: ["stage staging: shop staging approved by bob"] });
  });

  test("an approval of another digest does not let it through", async () => {
    const out = await run(specWith({ policy: "always" }), memoryGateLedgerPort({ resolutions: [approval("sha256:" + "9".repeat(64))] }));
    expect(out.passed).toBe(false);
  });

  test("the approval a promote waited on serves the run, and the stage waits once", async () => {
    const spec = specWith({ policy: "on-destructive" });
    const port = memoryGateLedgerPort();
    const log = memoryStageLogPort();
    const release = { releaseDigest: RELEASE, commit: "c".repeat(40) };
    const promote = (on: typeof port) => pipelineStageEntry({ spec, to: "staging", skipped: [], digest: RELEASE, release, port: on, log, now });
    expect(await promote(port)).toMatchObject({ passed: false, code: "pipeline-gate-waiting" });
    // The person approves the pending fact the promote recorded, after it was recorded.
    const pending = port.appended[0]!;
    const seeded = memoryGateLedgerPort({ pending: [...port.appended], resolutions: [approval(pending.planDigest, "2026-11-21T01:05:00.000Z")] });
    const later = new Date("2026-11-21T01:10:00.000Z");
    expect((await pipelineStageEntry({ spec, to: "staging", skipped: [], digest: RELEASE, release, port: seeded, log, now: later })).passed).toBe(true);
    // The run of the same release into the stage needs no approval of its own.
    expect(await componentRunStageGate({ spec, env: "staging", digest: RELEASE, releaseDigest: RELEASE, port: seeded, now: later })).toMatchObject({ passed: true });
    // Neither the promote that passed nor the run after it recorded a second pending fact.
    expect(seeded.appended).toEqual([]);
  });
});

describe("a run the pipeline does not gate", () => {
  test("a stage whose gate is never passes with no approval and records nothing", async () => {
    const port = memoryGateLedgerPort();
    expect(await run(specWith({ policy: "never" }), port)).toEqual({ passed: true, lines: ["stage staging: its gate never waits"] });
    expect(port.appended).toEqual([]);
  });

  test("an environment with no stage, and a member with no pipeline, have no stage gate", () => {
    const spec = specWith({ policy: "always" });
    expect(runStageOf({ status: "folded", file: PIPELINE_FILE, spec }, "a".repeat(40), "local")).toEqual({ status: "none" });
    expect(runStageOf({ status: "folded", file: PIPELINE_FILE, spec }, "a".repeat(40), "staging")).toMatchObject({ status: "gated" });
    expect(runStageOf({ status: "absent" }, "a".repeat(40), "staging")).toEqual({ status: "none" });
    expect(runStageAtBase(mkdtempSync(join(tmpdir(), "chant-5475-norepo-")), "staging")).toEqual({ status: "none" });
  });

  test("a pipeline that does not fold at base stops the run with exit 1", () => {
    const out = runStageOf({ status: "refused", file: PIPELINE_FILE, finding: { rule: "EVL001", message: "x", line: 1 } as never, line: "x [EVL012]" }, "a".repeat(40), "staging");
    expect(out).toMatchObject({ status: "refused", stop: { exitCode: 1 } });
  });
});

describe("the digest a run without a release binds", () => {
  const component = (name: string): DriverComponent => ({ name, deploy: [{ phase: "Deploy", steps: [{ kind: "noop" }] }] }) as unknown as DriverComponent;

  test("is the same for the same components, and moves with what they apply", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-5475-digest-"));
    const one = runStageDigest([component("api"), component("web")], "staging", root);
    expect(runStageDigest([component("api"), component("web")], "staging", root)).toBe(one);
    expect(runStageDigest([component("api")], "staging", root)).not.toBe(one);
    expect(runStageDigest([component("api"), component("web")], "prod", root)).not.toBe(one);
    expect(runStageDigest([component("api"), component("web")], "staging", root, { api: ["aws_s3_bucket.a"] })).not.toBe(one);
  });
});

const PIPELINE = (policy: string) => `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "shop",
  defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" }, runner: "ubuntu-latest" },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }] }], gate: { policy: "${policy}" } },
  ],
});
`;

describe("the gate is read at base", () => {
  test("a change that drops its stage's gate is still judged by the gate at base", async () => {
    const root = mkdtempSync(join(tmpdir(), "chant-5475-base-"));
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const dir = join(root, "member");
    git(root, "clone", "-q", origin, dir);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
    mkdirSync(join(dir, ".chant"));
    writeFileSync(join(dir, PIPELINE_FILE), PIPELINE("always"));
    git(dir, "add", PIPELINE_FILE);
    git(dir, "commit", "-q", "-m", "pipeline");
    git(dir, "push", "-q", "origin", "HEAD:main");
    git(dir, "fetch", "-q", "origin");
    // The change, committed on a branch and not merged: its stage's gate is never.
    git(dir, "checkout", "-q", "-b", "change");
    writeFileSync(join(dir, PIPELINE_FILE), PIPELINE("never"));
    git(dir, "commit", "-q", "-am", "drop the gate");

    const stage = runStageAtBase(dir, "staging");
    expect(stage).toMatchObject({ status: "gated", base: git(dir, "rev-parse", "origin/main") });
    if (stage.status !== "gated") return;
    expect(stage.spec.stages.find((s) => s.name === "staging")?.gate?.policy).toBe("always");
    const out = await componentRunStageGate({ spec: stage.spec, env: "staging", digest: RELEASE, port: memoryGateLedgerPort(), now });
    expect(out).toMatchObject({ passed: false, stop: { code: "pipeline-gate-waiting" } });
  });
});
