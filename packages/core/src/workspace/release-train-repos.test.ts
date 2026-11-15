/**
 * A release train across repositories (#5119): `repo` members' releases are
 * read at their pinned revisions, and the control repo promotes the train
 * one member repository at a time. Each member repository is a temp repo
 * behind a local bare remote, the read runs a stand-in chant that prints
 * the releases document from the fetched `chant/lifecycle`, and the
 * dispatcher is a fake. Nothing reaches a forge.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { gitControlAppliedLedger, recordControlApplied, type ControlAppliedRecord } from "../control/applied";
import type { TrainDispatch } from "../control/train";
import { CACHE_DIR_ENV } from "./graph-cache";
import { RELEASES_SCHEMA_ID } from "./releases";
import { readWorkspaceRuns } from "./workspace-ledger";
import {
  appendReleaseTrain,
  pickTrain,
  promoteTrain,
  readMemberReleases,
  readReleaseTrains,
  readRepoReleases,
  trainDigest,
  trainsWithPromotions,
  type ReleaseTrainRecord,
  type TrainMember,
} from "./release-train";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "chant-5119-")));
  scratch.push(d);
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" }).trim();

const REL = (c: string) => `jcs1-sha256:${c.repeat(64)}`;

/**
 * A member repository behind a local bare remote: a workspace at `main`,
 * and a `chant/lifecycle` branch holding the releases document its chant
 * would print. Returns the bare URL, the pinned revision, and its working copy.
 */
function memberRepo(name: string, releases: Array<{ releaseDigest: string; label: string | null; cuts: number }>): { url: string; rev: string; work: string } {
  const work = tmp();
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "chant.workspace.json"), JSON.stringify({ name, schema: 1, members: [] }));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  const rev = git(work, "rev-parse", "HEAD");
  writeReleases(work, rev, releases);
  const bare = join(tmp(), `${name}.git`);
  git(work, "clone", "-q", "--bare", work, bare);
  git(work, "remote", "add", "origin", bare);
  return { url: bare, rev, work };
}

/** Commit the releases document onto `chant/lifecycle`, on top of what it holds, without touching the working tree. */
function writeReleases(work: string, rev: string, releases: Array<{ releaseDigest: string; label: string | null; cuts: number }>): void {
  const doc = {
    $schema: RELEASES_SCHEMA_ID,
    contract: 1,
    chant: "0.0.0",
    member: null,
    releases: releases.map((r, i) => ({ releaseDigest: r.releaseDigest, commit: rev, label: r.label, cuts: Array.from({ length: r.cuts }, (_, k) => ({ timestamp: `2026-11-1${i}T0${k}:00:00Z` })), targets: {}, environments: [], revoked: null })),
    reason: null,
  };
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: work, input: JSON.stringify(doc), encoding: "utf-8" }).trim();
  const tree = execFileSync("git", ["mktree"], { cwd: work, input: `100644 blob ${blob}\treleases.json\n`, encoding: "utf-8" }).trim();
  let parent: string[] = [];
  try {
    parent = ["-p", git(work, "rev-parse", "--verify", "-q", "refs/heads/chant/lifecycle")];
  } catch {
    parent = [];
  }
  const commit = git(work, "commit-tree", tree, ...parent, "-m", "releases");
  git(work, "update-ref", "refs/heads/chant/lifecycle", commit);
}

/** The stand-in for the member repository's own `chant release list --json`: the document on the branch it reads, which only the fetched ledger holds. */
function fakeChant(): string[] {
  const script = join(tmp(), "chant.mjs");
  writeFileSync(
    script,
    [
      'import { execFileSync } from "node:child_process";',
      'if (process.argv.slice(2).join(" ") !== "release list --json") process.exit(64);',
      'process.stdout.write(execFileSync("git", ["show", "chant/lifecycle:releases.json"], { encoding: "utf-8" }));',
    ].join("\n"),
  );
  return [process.execPath, script];
}

function orgWorkspace(members: unknown[]): string {
  const root = tmp();
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, scope: "org", members }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

describe("a train pins repo members, read at their pinned revisions", () => {
  test("an org workspace with two repo members, each with a cut release, records a train naming both", async () => {
    const api = memberRepo("api", [{ releaseDigest: REL("a"), label: "a2", cuts: 1 }, { releaseDigest: REL("0"), label: null, cuts: 0 }]);
    const web = memberRepo("web", [{ releaseDigest: REL("b"), label: null, cuts: 2 }]);
    const root = orgWorkspace([
      { name: "api", kind: "repo", repo: { url: api.url, rev: api.rev } },
      { name: "web", kind: "repo", repo: { url: web.url, rev: web.rev } },
    ]);
    const cache = tmp();
    const command = fakeChant();
    const env = { ...process.env, [CACHE_DIR_ENV]: cache };
    const offered = await readMemberReleases(root, { readRepo: (m, ref, at) => readRepoReleases(m, ref, at, { env, command }) });
    expect(offered.map((m) => [m.member, m.problem, m.releases.map((r) => r.releaseDigest)])).toEqual([
      ["api", undefined, [REL("a")]],
      ["web", undefined, [REL("b")]],
    ]);
    const picked = pickTrain(offered);
    if (!("members" in picked)) throw new Error(picked.problems.join("; "));
    expect(picked.members).toEqual([
      { member: "api", releaseDigest: REL("a"), commit: api.rev, label: "a2", repo: { url: api.url, rev: api.rev } },
      { member: "web", releaseDigest: REL("b"), commit: web.rev, label: null, repo: { url: web.url, rev: web.rev } },
    ]);
    // The ledger moves apart from the pinned revision: a release cut since is read the next time.
    writeReleases(api.work, api.rev, [{ releaseDigest: REL("d"), label: "a3", cuts: 1 }]);
    git(api.work, "push", "-q", "origin", "chant/lifecycle");
    const again = await readRepoReleases("api", { url: api.url, rev: api.rev, workspace: "." }, root, { env, command });
    expect(again.releases.map((r) => r.label)).toEqual(["a3"]);
    // The same picks give the same digest, whatever the members' kinds.
    expect(trainDigest(picked.members)).toBe(trainDigest(picked.members.map(({ repo: _r, ...m }) => m)));
  });

  test("a member with no release, a read that fails, and an org workspace with no members each refuse the train", async () => {
    const api = memberRepo("api", []);
    const root = orgWorkspace([
      { name: "api", kind: "repo", repo: { url: api.url, rev: api.rev } },
      { name: "gone", kind: "repo", repo: { url: join(tmp(), "nothing.git"), rev: api.rev } },
    ]);
    const env = { ...process.env, [CACHE_DIR_ENV]: tmp() };
    const command = fakeChant();
    const picked = pickTrain(await readMemberReleases(root, { readRepo: (m, ref, at) => readRepoReleases(m, ref, at, { env, command }) }));
    expect("problems" in picked && picked.problems).toEqual([
      `member api has no release; cut one with chant release cut in ${api.url}`,
      expect.stringMatching(/^member gone: could not fetch /),
    ]);
    expect(pickTrain(await readMemberReleases(orgWorkspace([])))).toEqual({ problems: ["the workspace declares no chant or repo member, so a train has nothing to pin"] });
  });
});

// ── The control repo's promote ───────────────────────────────────────────────

const member = (name: string, c: string): TrainMember => ({ member: name, releaseDigest: REL(c), commit: c.repeat(40), label: null, repo: { url: `https://github.com/acme/${name}`, rev: c.repeat(40) } });

async function recordTrain(cwd: string, members: TrainMember[]): Promise<ReleaseTrainRecord> {
  const record: ReleaseTrainRecord = { version: 1, id: "train-6f1c2d4e-0000-4000-8000-00000000000a", env: "prod", timestamp: "2026-11-15T00:00:00Z", actor: "alice", members, trainDigest: trainDigest(members) };
  await appendReleaseTrain(cwd, record);
  return record;
}

/** web consumes what api produces, so api goes first. */
const readLinks = async () => [{ consumer: "web", producer: "api", status: "declared" }] as never;

function fakeDispatcher(sent: Array<{ repo: string; d: TrainDispatch }>, refuse?: string) {
  return async (m: { name: string; repo: string }, d: TrainDispatch) => {
    if (m.name === refuse) throw new Error("HTTP 404");
    sent.push({ repo: m.repo, d });
  };
}

async function answer(cwd: string, d: TrainDispatch, outcome: ControlAppliedRecord["outcome"], over: Partial<TrainDispatch> = {}): Promise<void> {
  await recordControlApplied(gitControlAppliedLedger({ cwd }), { member: d.member, op: "deploy", sha: d.commit, outcome, train: { train: d.train, run: d.run, env: over.env ?? d.env, releaseDigest: over.releaseDigest ?? d.releaseDigest } });
}

describe("the control repo promotes a train one member repository at a time", () => {
  test("dispatches the first member only; its applied dispatches the second, and a failed stops the train where it failed", async () => {
    const cwd = orgWorkspace([]);
    const train = await recordTrain(cwd, [member("web", "b"), member("api", "a")]);
    const sent: Array<{ repo: string; d: TrainDispatch }> = [];
    const q = { cwd, env: "prod", readLinks, dispatch: fakeDispatcher(sent) };

    const started = await promoteTrain(q);
    if (started.kind !== "ran") throw new Error(started.kind);
    expect(sent).toEqual([{ repo: "https://github.com/acme/api", d: { member: "api", env: "prod", train: train.id, run: started.record.id, releaseDigest: REL("a"), commit: "a".repeat(40) } }]);
    expect(started.record).toMatchObject({ status: "dispatched", train: { id: train.id, digest: train.trainDigest } });
    expect(started.record.steps.map((s) => [s.member, s.status, s.repo])).toEqual([
      ["api", "dispatched", "https://github.com/acme/api"],
      ["web", "not-run", "https://github.com/acme/web"],
    ]);

    // A second start refuses while the first is in flight; a continue before an answer writes nothing.
    expect(await promoteTrain(q)).toMatchObject({ kind: "refused", message: expect.stringMatching(/is in flight and waits on api/) });
    expect(await promoteTrain({ ...q, continue: true })).toMatchObject({ kind: "waiting", member: "api" });
    expect((await readWorkspaceRuns(cwd, "prod")).records).toHaveLength(1);
    expect(sent).toHaveLength(1);

    await answer(cwd, sent[0]!.d, "applied");
    const second = await promoteTrain({ ...q, continue: true });
    if (second.kind !== "ran") throw new Error(second.kind);
    expect(second.record.id).toBe(started.record.id);
    expect(sent.map((s) => s.d.member)).toEqual(["api", "web"]);
    expect(second.record.steps.map((s) => [s.member, s.status, s.outcome])).toEqual([
      ["api", "ok", "applied"],
      ["web", "dispatched", undefined],
    ]);

    await answer(cwd, sent[1]!.d, "failed");
    const stopped = await promoteTrain({ ...q, continue: true });
    if (stopped.kind !== "ran") throw new Error(stopped.kind);
    expect(stopped.record.status).toBe("fail");
    expect(stopped.record.steps.map((s) => [s.member, s.status, s.outcome])).toEqual([
      ["api", "ok", "applied"],
      ["web", "fail", "failed"],
    ]);
    expect(stopped.record.steps[1]!.reason).toBe(`web's run ended failed at ${"b".repeat(12)}`);
    expect(await promoteTrain({ ...q, continue: true })).toMatchObject({ kind: "idle" });
    expect(sent).toHaveLength(2);

    // The read behold draws a train from: one promotion, its newest line.
    const listed = trainsWithPromotions((await readReleaseTrains(cwd, "prod")).records, (await readWorkspaceRuns(cwd, "prod")).records);
    expect(listed[0]!.promotions).toHaveLength(1);
    expect(listed[0]!.promotions[0]).toMatchObject({ run: started.record.id, status: "fail" });
    expect(listed[0]!.promotions[0]!.members).toEqual([
      { member: "api", status: "ok", memberRun: null, repo: "https://github.com/acme/api", outcome: "applied" },
      { member: "web", status: "fail", memberRun: null, repo: "https://github.com/acme/web", outcome: "failed", reason: `web's run ended failed at ${"b".repeat(12)}` },
    ]);
  });

  test("unchanged passes like applied; a run that waits at its own gate ends the train gated; the last member's pass ends it ok", async () => {
    const cwd = orgWorkspace([]);
    await recordTrain(cwd, [member("api", "a"), member("web", "b")]);
    const sent: Array<{ repo: string; d: TrainDispatch }> = [];
    const q = { cwd, env: "prod", readLinks, dispatch: fakeDispatcher(sent) };
    await promoteTrain(q);
    await answer(cwd, sent[0]!.d, "unchanged");
    await promoteTrain({ ...q, continue: true });
    await answer(cwd, sent[1]!.d, "waiting");
    const gated = await promoteTrain({ ...q, continue: true });
    if (gated.kind !== "ran") throw new Error(gated.kind);
    expect([gated.record.status, gated.record.steps.map((s) => s.status)]).toEqual(["gated", ["ok", "gated"]]);
    expect(gated.record.steps[1]!.reason).toMatch(/waits at its own gate/);

    // Promoted again, a new run starts from the first member, and passes through both.
    const again = await promoteTrain(q);
    if (again.kind !== "ran") throw new Error(again.kind);
    expect(again.record.id).not.toBe(gated.record.id);
    await answer(cwd, sent[2]!.d, "unchanged");
    await promoteTrain({ ...q, continue: true });
    await answer(cwd, sent[3]!.d, "applied");
    const done = await promoteTrain({ ...q, continue: true });
    if (done.kind !== "ran") throw new Error(done.kind);
    expect([done.record.status, done.record.steps.map((s) => s.status)]).toEqual(["ok", ["ok", "ok"]]);
  });

  test("an answer for another release, or another environment, fails the step; an answer for another run is not this run's", async () => {
    const cwd = orgWorkspace([]);
    await recordTrain(cwd, [member("api", "a"), member("web", "b")]);
    const sent: Array<{ repo: string; d: TrainDispatch }> = [];
    const q = { cwd, env: "prod", readLinks, dispatch: fakeDispatcher(sent) };
    await promoteTrain(q);
    await answer(cwd, { ...sent[0]!.d, run: "ws-6f1c2d4e-0000-4000-8000-0000000000ff" }, "applied");
    expect(await promoteTrain({ ...q, continue: true })).toMatchObject({ kind: "waiting", member: "api" });
    await answer(cwd, sent[0]!.d, "applied", { releaseDigest: REL("c") });
    const out = await promoteTrain({ ...q, continue: true });
    if (out.kind !== "ran") throw new Error(out.kind);
    expect(out.record.status).toBe("fail");
    expect(out.record.steps[0]!.reason).toBe(`api answered for release ${REL("c")} in prod, and the train pins ${REL("a")} in prod`);
    expect(sent).toHaveLength(1);
  });

  test("a dispatch the forge does not take fails the step; --gate, and a train of both kinds, are refused", async () => {
    const cwd = orgWorkspace([]);
    await recordTrain(cwd, [member("api", "a"), member("web", "b")]);
    const sent: Array<{ repo: string; d: TrainDispatch }> = [];
    const refused = await promoteTrain({ cwd, env: "prod", readLinks, dispatch: fakeDispatcher(sent, "api") });
    if (refused.kind !== "ran") throw new Error(refused.kind);
    expect([refused.record.status, refused.record.steps.map((s) => s.status)]).toEqual(["fail", ["fail", "not-run"]]);
    expect(refused.record.steps[0]!.reason).toBe("the dispatch into https://github.com/acme/api was not taken: HTTP 404");
    expect(await promoteTrain({ cwd, env: "prod", readLinks, gate: "train-prod", dispatch: fakeDispatcher(sent) })).toMatchObject({ kind: "refused", message: expect.stringMatching(/each keeps its own gate/) });

    const mixed = orgWorkspace([]);
    const { repo: _r, ...local } = member("db", "c");
    await recordTrain(mixed, [member("api", "a"), local]);
    expect(await promoteTrain({ cwd: mixed, env: "prod", readLinks, dispatch: fakeDispatcher(sent) })).toMatchObject({ kind: "refused", message: expect.stringMatching(/pins repo members \(api\) and chant members \(db\)/) });
    expect(sent).toEqual([]);
  });

  test("the order is the declaration's links, producers first", async () => {
    const cwd = orgWorkspace([
      { name: "web", kind: "repo", repo: { url: "https://github.com/acme/web", rev: "b".repeat(40) }, links: [{ member: "api", output: "url" }] },
      { name: "api", kind: "repo", repo: { url: "https://github.com/acme/api", rev: "a".repeat(40) } },
    ]);
    await recordTrain(cwd, [member("web", "b"), member("api", "a")]);
    expect(await promoteTrain({ cwd, env: "prod", dryRun: true })).toMatchObject({ kind: "planned", order: ["api", "web"] });
  });
});
