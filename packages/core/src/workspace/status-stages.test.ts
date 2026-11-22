/**
 * #5342: `workspace status` shows each stage of a member's pipeline: the
 * release it runs, its gate, the change risk the gate reads, its soak and
 * the time left, the canary soaks that hold it, a pause, and a rollback
 * request. Against temp repos whose ledgers the real writers fill; nothing
 * is pushed, and status writes nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanupTestDir, createTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import statusSchema from "./status.schema.json";
import { formatStatus, workspaceStatus, type StatusDocument } from "./status";
import { appendCut, makeRelease, persistRelease, type Release } from "../lifecycle/release-store";
import { appendReleaseRecord } from "../lifecycle/release-ledger";
import { appendGateResolution, appendPendingGate } from "../lifecycle/gate-ledger";
import { gitStageLedgerPort, type StagePauseLine } from "../pipeline/stage-ledger";
import { appendWaveRisk, readReleaseRisk, type ReleaseRisk } from "../lifecycle/release-risk";
import { contentDigest } from "../content-digest";
import { STAGE_STATUS_FLOOR } from "../pipeline";
import { NEXT_RELEASE } from "../release-floors";

const validateStatus = new Ajv2020({ strict: true, allErrors: true }).compile(statusSchema);
const NOW = "2026-11-20T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

const PIPELINE = `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "shop",
  defaults: { op: "shop", step: { kind: "pulumi-up", stack: "{target}" }, runner: "ubuntu-latest" },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never", holds: { risk: { approveAbove: 0.9 } } } },
    {
      name: "canary",
      canary: true,
      waves: [{ name: "canary", runs: [{ target: "canary" }] }],
      gate: { holds: { risk: { approveAbove: 0.3 } } },
      soak: { duration: "2h", checks: [{ kind: "http", name: "up", url: "https://canary.example/healthz" }] },
    },
    {
      name: "prod",
      waves: [{ name: "prod", runs: [{ target: "prod" }] }],
      gate: { holds: { risk: { approveAbove: 0.5 } } },
      onVerifyFail: "rollback",
    },
  ],
});
`;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function result(doc: StatusDocument): Extract<StatusDocument, { members: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(validateStatus(doc), JSON.stringify(validateStatus.errors, null, 2)).toBe(true);
  return doc;
}

const risk = (commit: string, score: number): ReleaseRisk => ({
  version: 1,
  commit,
  score,
  level: score < 0.3 ? "low" : score < 0.6 ? "medium" : "high",
  waves: [{ op: "shop-dev", wave: 1, name: "dev", digest: contentDigest(`plan ${commit}`), risk: { version: 1, score, level: "medium", reasons: [], approveAbove: null, over: false, overBy: [] } }],
});

/** A workspace whose root member declares the pipeline, with releases v1.0.0 and v1.1.0 (scored 0.4) cut. */
async function setup(dir: string, withPipeline = true): Promise<{ v1: Release; v2: Release; deploy: (stage: string, release: Release, timestamp: string) => Promise<void> }> {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "root", dir: ".", kind: "other", because: "the fixture" }] }, null, 2));
  if (withPipeline) {
    mkdirSync(join(dir, ".chant"), { recursive: true });
    writeFileSync(join(dir, ".chant", "pipeline.ts"), PIPELINE);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--allow-empty", "-m", "next");
  const second = git(dir, "rev-parse", "HEAD");
  const cut = (commit: string) =>
    makeRelease({ member: null, commit, artifactDigests: [{ component: "api", kind: "image" as const, path: "api.tar", digest: contentDigest(`api ${commit}`) }], targets: [] });
  const v1 = cut(first);
  const v2 = cut(second);
  await persistRelease(v1, [], { cwd: dir });
  await appendCut({ releaseDigest: v1.releaseDigest, label: "v1.0.0", actor: "alice", timestamp: at(-48), runOrigin: null }, { cwd: dir });
  await persistRelease(v2, [], { cwd: dir });
  await appendCut({ releaseDigest: v2.releaseDigest, label: "v1.1.0", actor: "alice", timestamp: at(-24), runOrigin: null, risk: risk(second, 0.4) }, { cwd: dir });
  const deploy = async (stage: string, release: Release, timestamp: string) => {
    await appendReleaseRecord(
      { env: stage, component: "api", digest: contentDigest(`api ${release.commit}`), gitSha: release.commit, runId: `run-${stage}`, actor: "ci", timestamp, releaseDigest: release.releaseDigest },
      { cwd: dir },
    );
  };
  return { v1, v2, deploy };
}

const stageLine = (input: Omit<StagePauseLine, "version" | "pipeline">): StagePauseLine => ({ version: 1, pipeline: "shop", ...input });

type Doc = Extract<StatusDocument, { members: unknown }>;

/**
 * Each scenario's repository is built and read in beforeAll, which the unit
 * budget does not count; the tests assert on what was read.
 */
const dirs: string[] = [];
async function scenario<T>(build: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createTestDir("chant-status-stages");
  dirs.push(dir);
  return build(dir);
}
afterAll(async () => {
  for (const d of dirs) await cleanupTestDir(d);
});

const read = async (dir: string): Promise<Doc> => result(await workspaceStatus({ cwd: dir, env: "prod", now: NOW }));

describe("the release view per stage in workspace status (#5342)", () => {
  let full: { doc: Doc; v1: Release; v2: Release; before: string; after: string };
  let soaks: { due: Doc; failing: Doc; ended: Doc; unread: Doc; held: Doc; v1: Release; v2: Release; v3: Release };
  let none: Doc;

  beforeAll(async () => {
    full = await scenario(async (dir) => {
      const { v1, v2, deploy } = await setup(dir);
      await deploy("dev", v2, at(-6));
      await deploy("canary", v2, at(-1));
      await deploy("prod", v1, at(-30));
      await deploy("prod", v2, at(-0.5));

      // The canary's soak held a promote into prod an hour in, with an hour left.
      await appendPendingGate(
        {
          op: "shop", gate: "canary-soak", environment: "canary", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp: at(-0.25), expiresAt: at(700),
          soak: { stage: "canary", to: "prod", clockStart: at(-1), due: at(1), leftMs: 4_500_000, holds: ["1h 15m left, until " + at(1)] },
        },
        { cwd: dir },
      );
      // Prod's gate waited for v1.1.0, and bob approved it.
      await appendPendingGate({ op: "shop", gate: "prod", environment: "prod", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp: at(-0.75), expiresAt: at(24) }, { cwd: dir });
      await appendGateResolution({ op: "shop", gate: "prod", environment: "prod", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, resolvedBy: "bob", timestamp: at(-0.7) }, { cwd: dir });

      // Prod's verify failed on v1.1.0; the stage asked to go back to v1.0.0.
      const stages = gitStageLedgerPort({ cwd: dir });
      const failed = { digest: v2.releaseDigest, label: "v1.1.0" };
      const to = { digest: v1.releaseDigest, label: "v1.0.0" };
      await stages.append(stageLine({ kind: "failed", stage: "prod", by: "ci", timestamp: at(-0.4), id: "f1", failure: "verify", failed, members: [{ member: "api", state: "applied" }], detail: ["smoke failed"] }));
      await stages.append(stageLine({ kind: "rollback-requested", stage: "prod", by: "ci", timestamp: at(-0.4), id: "r1", failureId: "f1", failed, release: to, members: [{ member: "api", state: "applied", rollback: "requested" }], gate: "prod-rollback" }));
      await appendPendingGate({ op: "shop", gate: "prod-rollback", environment: "prod", planDigest: v1.releaseDigest, releaseDigest: v1.releaseDigest, timestamp: at(-0.4), expiresAt: at(700) }, { cwd: dir });
      // Dev is paused, and a release waited behind the pause.
      await stages.append(stageLine({ kind: "pause", stage: "dev", by: "carol", reason: "db upgrade", timestamp: at(-2) }));
      await stages.append(stageLine({ kind: "waiting", stage: "dev", by: "ci", timestamp: at(-1.5), release: failed }));

      const before = git(dir, "rev-parse", "chant/lifecycle");
      const doc = await read(dir);
      return { doc, v1, v2, before, after: git(dir, "rev-parse", "chant/lifecycle") };
    });

    // The canary's soak in each state, one repository per state.
    const soakRepo = async (facts: (ctx: { dir: string; v1: Release; v2: Release; deploy: (stage: string, release: Release, timestamp: string) => Promise<void> }) => Promise<void>) =>
      scenario(async (dir) => {
        const ctx = await setup(dir);
        await ctx.deploy("canary", ctx.v2, at(-3));
        await ctx.deploy("prod", ctx.v1, at(-30));
        await facts({ dir, ...ctx });
        return { doc: await read(dir), ...ctx };
      });
    const soakFact = (dir: string, v2: Release, soak: { due: string; failing?: string[] }, timestamp: string) =>
      appendPendingGate(
        { op: "shop", gate: "canary-soak", environment: "canary", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp, expiresAt: at(700), soak: { stage: "canary", to: "prod", clockStart: at(-3), holds: ["held"], ...soak } },
        { cwd: dir },
      );
    const due = await soakRepo(async ({ dir, v2 }) => {
      await soakFact(dir, v2, { due: at(-1) }, at(-2));
    });
    const failing = await soakRepo(async ({ dir, v2 }) => {
      await soakFact(dir, v2, { due: at(-1), failing: ["up"] }, at(-0.5));
    });
    const ended = await soakRepo(async ({ dir, v2 }) => {
      await soakFact(dir, v2, { due: at(-1), failing: ["up"] }, at(-0.5));
      await appendGateResolution({ op: "shop", gate: "canary-soak", environment: "canary", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, resolvedBy: "dana", timestamp: at(-0.25) }, { cwd: dir });
    });
    // A newer release in the canary has no soak read yet; prod's soak failed with nothing earlier to go back to.
    let v3!: Release;
    const unread = await soakRepo(async ({ dir, v1, v2, deploy }) => {
      await soakFact(dir, v2, { due: at(-1) }, at(-2));
      v3 = makeRelease({ member: null, commit: v2.commit, artifactDigests: [{ component: "api", kind: "image" as const, path: "api.tar", digest: contentDigest("api v3") }], targets: [] });
      await persistRelease(v3, [], { cwd: dir });
      await deploy("canary", v3, at(-0.1));
      // v1.1.0 waits at prod's gate, so the gate reads its risk.
      await appendPendingGate({ op: "shop", gate: "prod", environment: "prod", planDigest: v2.releaseDigest, releaseDigest: v2.releaseDigest, timestamp: at(-0.3), expiresAt: at(24) }, { cwd: dir });
      const stages = gitStageLedgerPort({ cwd: dir });
      await stages.append(stageLine({ kind: "failed", stage: "prod", by: "ci", timestamp: at(-0.2), id: "f2", failure: "soak", failed: { digest: v1.releaseDigest, label: "v1.0.0" }, members: [{ member: "api", state: "applied" }] }));
      await stages.append(stageLine({ kind: "rollback-held", stage: "prod", by: "ci", timestamp: at(-0.2), failureId: "f2", held: "stage prod ran no earlier release" }));
    });
    soaks = { due: due.doc, failing: failing.doc, ended: ended.doc, unread: unread.doc, held: unread.doc, v1: unread.v1, v2: unread.v2, v3 };

    none = await scenario(async (dir) => {
      const { v1, deploy } = await setup(dir, false);
      await deploy("prod", v1, at(-1));
      return read(dir);
    });
  }, 300_000);

  test("each stage shows its release, gate, risk, soak, canary hold, pause and rollback request, from the ledgers", () => {
    const { doc, v1, v2 } = full;
    // Status reads and never writes.
    expect(full.after).toBe(full.before);
    const failed = { digest: v2.releaseDigest, label: "v1.1.0" };
    const to = { digest: v1.releaseDigest, label: "v1.0.0" };

    const member = doc.members[0]!;
    expect(member.pipeline?.name).toBe("shop");
    const [dev, canary, prod] = member.pipeline!.stages;

    expect(dev).toMatchObject({
      name: "dev",
      canary: false,
      after: [],
      release: { releaseDigest: v2.releaseDigest, label: "v1.1.0", gitSha: v2.commit, components: ["api"], mixed: false },
      gate: { name: "dev", policy: "never", state: null, approve: null },
      risk: { releaseDigest: v2.releaseDigest, score: 0.4, level: "medium", reads: true, approveAbove: 0.9, over: false },
      soak: null,
      canaryHolds: [],
      paused: { by: "carol", reason: "db upgrade", cause: null, waiting: [failed] },
      onVerifyFail: "hold",
      rollback: null,
      rollbackHeld: null,
    });

    expect(canary).toMatchObject({
      name: "canary",
      canary: true,
      after: ["dev"],
      release: { label: "v1.1.0" },
      gate: { state: null, policy: "always" },
      risk: { score: 0.4, reads: true, approveAbove: 0.3, over: true },
      soak: { gate: "canary-soak", duration: "2h", checks: 1, state: "soaking", releaseDigest: v2.releaseDigest, to: "prod", clockStart: at(-1), due: at(1), leftMs: 3_600_000, failing: [] },
      canaryHolds: [],
      paused: null,
    });
    expect(canary!.risk!.overBy[0]).toContain("above 0.3");

    expect(prod).toMatchObject({
      name: "prod",
      after: ["canary"],
      release: { releaseDigest: v2.releaseDigest, label: "v1.1.0", mixed: false },
      gate: { name: "prod", state: "approved", releaseDigest: v2.releaseDigest, label: "v1.1.0", approvals: 1, needed: 1 },
      risk: { releaseDigest: v2.releaseDigest, reads: true, approveAbove: 0.5, over: false, overBy: [] },
      soak: null,
      canaryHolds: [{ stage: "canary", state: "soaking", due: at(1), leftMs: 3_600_000, holding: true }],
      onVerifyFail: "rollback",
      rollback: {
        id: "r1",
        by: "ci",
        failure: "verify",
        failed,
        to,
        members: [{ member: "api", state: "applied", rollback: "requested" }],
        gate: "prod-rollback",
        state: "pending",
        approve: `chant approve shop prod-rollback --env prod --plan ${v1.releaseDigest}`,
        command: "chant components rollback prod --requested",
      },
      rollbackHeld: null,
    });

    // `gates` still lists the environment asked for only; the soak's state rides on its gate.
    expect(member.gates.map((g) => `${g.name}@${g.env}`)).toEqual(["prod@prod", "prod-rollback@prod"]);

    // One text line per stage, with the same facts.
    const text = formatStatus(doc).split("\n");
    const header = text.findIndex((l) => l.startsWith("MEMBER  STAGE"));
    expect(text[header]).toMatch(/^MEMBER\s+STAGE\s+RUNS\s+GATE\s+RISK\s+SOAK\s+CANARY\s+ROLLBACK$/);
    const row = (stage: string) => text.slice(header + 1, header + 4).find((l) => l.split(/\s{2,}/)[1] === stage)!.split(/\s{2,}/);
    expect(row("dev")).toEqual(["root", "dev", "v1.1.0", "paused by carol, 1 waiting", "0.40 medium within 0.9", "-", "-", "-"]);
    expect(row("canary")).toEqual(["root", "canary", "v1.1.0", "-", "0.40 medium over 0.3", "1h left", "canary", "-"]);
    expect(row("prod")).toEqual(["root", "prod", "v1.1.0", "approved 1/1 v1.1.0", "0.40 medium within 0.5", "-", "held by canary (1h left)", "to v1.0.0, pending"]);
  });

  test("a soak whose time is up holds nothing, and reads its checks on the next promote", () => {
    const [, canary, prod] = soaks.due.members[0]!.pipeline!.stages;
    expect(canary!.soak).toMatchObject({ state: "due", leftMs: 0 });
    expect(prod!.canaryHolds).toEqual([{ stage: "canary", state: "due", due: at(-1), leftMs: 0, holding: false }]);
  });

  test("a failing check holds the stages after the canary", () => {
    const [, canary, prod] = soaks.failing.members[0]!.pipeline!.stages;
    expect(canary!.soak).toMatchObject({ state: "failing", failing: ["up"] });
    expect(prod!.canaryHolds[0]).toMatchObject({ state: "failing", holding: true });
    expect(formatStatus(soaks.failing)).toMatch(/root\s+prod\s+v1\.0\.0\s+-\s+-\s+-\s+held by canary \(failing\)/);
  });

  test("an approval of the soak's gate ends it early", () => {
    const [, canary, prod] = soaks.ended.members[0]!.pipeline!.stages;
    expect(canary!.soak).toMatchObject({ state: "ended", endedBy: "dana" });
    expect(prod!.canaryHolds[0]).toMatchObject({ state: "ended", holding: false });
  });

  test("a newer release in the stage has no soak read yet, and a failure with nothing to go back to is held", () => {
    const [, canary, prod] = soaks.unread.members[0]!.pipeline!.stages;
    expect(canary!.soak).toMatchObject({ state: "unread", releaseDigest: null, due: null });
    expect(canary!.release).toMatchObject({ releaseDigest: soaks.v3.releaseDigest, label: null });
    expect(prod!.release).toMatchObject({ releaseDigest: soaks.v1.releaseDigest });
    expect(prod!.gate).toMatchObject({ state: "pending", releaseDigest: soaks.v2.releaseDigest, approvals: 0 });
    expect(prod!.risk).toMatchObject({ releaseDigest: soaks.v2.releaseDigest, label: "v1.1.0", approveAbove: 0.5, over: false });
    expect(prod!.rollback).toBeNull();
    expect(prod!.rollbackHeld).toEqual({ failureId: "f2", at: at(-0.2), reason: "stage prod ran no earlier release", failure: "soak", failed: { digest: soaks.v1.releaseDigest, label: "v1.0.0" } });
    expect(formatStatus(soaks.held)).toMatch(/root\s+prod\s+v1\.0\.0\s+pending 0\/1 v1\.1\.0\s+0\.40 medium within 0\.5\s+-\s+-\s+held, none requested/);
  });

  test("the capability carries its floor", () => {
    expect(STAGE_STATUS_FLOOR).toBe(NEXT_RELEASE);
  });

  test("a member with no pipeline has no pipeline field and no stage table", () => {
    expect(none.members[0]).not.toHaveProperty("pipeline");
    expect(formatStatus(none)).not.toContain("CANARY");
  });
});

describe("the first stage's risk when the apply comes before the cut (#5443)", () => {
  let doc: Doc;
  let v3: Release;

  beforeAll(async () => {
    const built = await scenario(async (dir) => {
      await setup(dir);
      git(dir, "commit", "-q", "--allow-empty", "-m", "merge");
      const commit = git(dir, "rev-parse", "HEAD");
      // The merge applies at dev first: the record names no release, as no release is cut yet.
      await appendReleaseRecord(
        { env: "dev", component: "api", digest: contentDigest(`api ${commit}`), gitSha: commit, runId: "run-dev", actor: "ci", timestamp: at(-0.5) },
        { cwd: dir },
      );
      const reasons = [{ id: "blast-radius", weight: 0.5, value: 0.6, contribution: 0.3, detail: "3 resources change" }];
      await appendWaveRisk(
        [{ version: 1, commit, timestamp: at(-0.5), op: "shop-dev", wave: 1, name: "dev", digest: contentDigest(`plan ${commit}`), risk: { version: 1, score: 0.3, level: "medium", reasons, approveAbove: null, over: false, overBy: [] } }],
        { cwd: dir },
      );
      // Then the release is cut from that commit, carrying the score the apply recorded.
      const release = makeRelease({ member: null, commit, artifactDigests: [{ component: "api", kind: "image" as const, path: "api.tar", digest: contentDigest(`api ${commit}`) }], targets: [] });
      await persistRelease(release, [], { cwd: dir });
      const risk = await readReleaseRisk(commit, { cwd: dir });
      expect(risk?.score).toBe(0.3);
      await appendCut({ releaseDigest: release.releaseDigest, label: "v1.2.0", actor: "alice", timestamp: at(-0.25), runOrigin: null, ...(risk ? { risk } : {}) }, { cwd: dir });
      return { doc: await read(dir), release };
    });
    doc = built.doc;
    v3 = built.release;
  }, 300_000);

  test("dev shows the score and its reasons", () => {
    const dev = doc.members[0]!.pipeline!.stages[0]!;
    expect(dev.release).toMatchObject({ releaseDigest: null, gitSha: v3.commit });
    expect(dev.risk).toMatchObject({
      releaseDigest: v3.releaseDigest,
      label: "v1.2.0",
      score: 0.3,
      level: "medium",
      reads: true,
      approveAbove: 0.9,
      over: false,
      reasons: [{ id: "blast-radius", contribution: 0.3, detail: "3 resources change" }],
    });
    expect(formatStatus(doc)).toMatch(/root\s+dev\s+\S+\s+\S+.*0\.30 medium within 0\.9/);
  });
});
