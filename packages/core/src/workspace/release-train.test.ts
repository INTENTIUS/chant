/**
 * Release trains (#4037): the train digest, a train's promote across two
 * members under one workspace gate, and the read that lists each train with
 * the runs that promoted it. The ledger is a real `chant/lifecycle` branch
 * in a temp repo; each member's `chant components promote` is a fake that
 * answers as the real one does.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_GATE_ENV, WORKSPACE_RUN_ENV } from "../op/workspace-run-env";
import { writeLedgerFiles } from "../lifecycle/git";
import type { WorkspaceGraph } from "./compose-graph";
import type { MemberOpResult } from "./workspace-run";
import { readWorkspaceRuns } from "./workspace-ledger";
import { approveWorkspaceGate, readWorkspaceGate, workspaceGateDigest, workspaceGateStandsIn, type WorkspaceGateApproval } from "./workspace-gates";
import {
  appendReleaseTrain,
  findTrain,
  pickTrain,
  promoteTrain,
  readReleaseTrains,
  releaseCovers,
  trainDigest,
  trainsWithPromotions,
  type MemberReleasePlan,
  type ReleaseTrainRecord,
  type TrainMember,
} from "./release-train";

const REL_API = `jcs1-sha256:${"a".repeat(64)}`;
const REL_WEB = `jcs1-sha256:${"b".repeat(64)}`;
const REL_WEB2 = `jcs1-sha256:${"c".repeat(64)}`;
const CS_API = `jcs1-sha256:${"1".repeat(64)}`;
const CS_WEB = `jcs1-sha256:${"2".repeat(64)}`;
const CS_WEB_MOVED = `jcs1-sha256:${"3".repeat(64)}`;

const rel = (member: string, releaseDigest: string, label: string | null = null): TrainMember => ({ member, releaseDigest, commit: "c".repeat(40), label });

describe("the train digest", () => {
  test("covers each member's release digest, so the same picks give the same digest whatever the order, label or commit", () => {
    const a = trainDigest([rel("api", REL_API, "v1"), rel("web", REL_WEB)]);
    expect(a).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(trainDigest([{ ...rel("web", REL_WEB, "v9"), commit: "d".repeat(40) }, rel("api", REL_API)])).toBe(a);
    expect(trainDigest([rel("api", REL_API), rel("web", REL_WEB2)])).not.toBe(a);
    expect(trainDigest([rel("api", REL_API)])).not.toBe(a);
  });

  test("an empty train is refused", () => {
    expect(pickTrain([])).toEqual({ problems: ["the workspace declares no chant member, so a train has nothing to pin"] });
  });

  test("a train is found by id or digest, else the newest is taken", () => {
    const t = (id: string, members: TrainMember[]) => ({ version: 1 as const, id, env: "prod", timestamp: id, actor: "a", members, trainDigest: trainDigest(members) });
    const one = t("train-1", [rel("api", REL_API)]);
    const two = t("train-2", [rel("api", REL_API), rel("web", REL_WEB)]);
    expect(findTrain([one, two])).toBe(two);
    expect(findTrain([one, two], "train-1")).toBe(one);
    expect(findTrain([one, two], one.trainDigest)).toBe(one);
    expect(findTrain([one, two], "nope")).toBeNull();
  });
});

describe("release covers", () => {
  const plan = (over: Partial<MemberReleasePlan> = {}): MemberReleasePlan => ({ env: "prod", releaseDigest: REL_API, label: null, op: "release", gates: ["prod-release", "dba"], changeSet: CS_API, empty: false, components: ["api"], ...over });

  test("one per release gate, bound to the member's change set, the environment and the release", () => {
    expect(releaseCovers("api", "prod", plan())).toEqual([
      { member: "api", op: "release", gate: "prod-release", planDigest: CS_API, environment: "prod", releaseDigest: REL_API },
      { member: "api", op: "release", gate: "dba", planDigest: CS_API, environment: "prod", releaseDigest: REL_API },
    ]);
  });

  test("none for an empty change set, or for a promote that declares no gate", () => {
    expect(releaseCovers("api", "prod", plan({ empty: true }))).toEqual([]);
    expect(releaseCovers("api", "prod", plan({ gates: [], changeSet: null, empty: null }))).toEqual([]);
  });

  test("an approval stands in for a release gate only for the release it covers", () => {
    const covers = releaseCovers("api", "prod", plan({ gates: ["prod-release"] }));
    const approval: WorkspaceGateApproval = { version: 1, kind: "approval", gate: "train-prod", digest: workspaceGateDigest(covers), covers, approvedBy: "alice", timestamp: "2026-11-15T00:00:00Z" };
    const q = { op: "release", gate: "prod-release", planDigest: CS_API, environment: "prod", releaseDigest: REL_API };
    const ctx = { member: "api", optedIn: true, approvals: [approval] };
    expect(workspaceGateStandsIn(q, ctx)).toBe(approval);
    expect(workspaceGateStandsIn({ ...q, releaseDigest: REL_WEB }, ctx)).toBeNull();
    expect(workspaceGateStandsIn({ ...q, environment: "staging" }, ctx)).toBeNull();
    expect(workspaceGateStandsIn(q, { ...ctx, optedIn: false })).toBeNull();
    // A cover that names no release never stands in for a gate bound to one.
    const plain = [{ member: "api", op: "release", gate: "prod-release", planDigest: CS_API, environment: "prod" }];
    expect(workspaceGateStandsIn(q, { ...ctx, approvals: [{ ...approval, covers: plain, digest: workspaceGateDigest(plain) }] })).toBeNull();
  });

  test("a cover with no release hashes as it did before releases were added", () => {
    const plain = [{ member: "api", op: "deploy", gate: "approve", planDigest: CS_API }];
    expect(workspaceGateDigest(plain)).toBe(workspaceGateDigest([{ ...plain[0]!, releaseDigest: undefined } as never]));
  });
});

// ── Against a real chant/lifecycle branch ────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-train-")));
  dirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

function member(name: string) {
  return { name, dir: name, kind: "chant", status: "composed", reason: null, chant: null, irVersion: 1, live: false };
}

/** api produces what web reads. */
function graph(): WorkspaceGraph {
  return {
    version: 1,
    workspace: { name: "acme", root: "." },
    members: [member("web"), member("api")],
    nodes: [],
    edges: [],
    groups: { byMember: {} },
    exports: [],
    imports: [],
    links: [{ consumer: "web", producer: "api", output: "url", kind: "depends-on", origin: "declared", resolves: "source", status: "resolved", label: "exact", input: null, reason: null }],
    collectors: [],
    records: [],
  } as unknown as WorkspaceGraph;
}

async function recordTrain(cwd: string, members: TrainMember[]): Promise<ReleaseTrainRecord> {
  const record: ReleaseTrainRecord = { version: 1, id: `train-${members.map((m) => m.releaseDigest.slice(-1)).join("")}`, env: "prod", timestamp: "2026-11-15T00:00:00Z", actor: "alice", members, trainDigest: trainDigest(members) };
  await appendReleaseTrain(cwd, record);
  return record;
}

interface Seen {
  member: string;
  argv: string[];
  env: Record<string, string>;
}

/**
 * Each member's `chant components promote --release`: `--plan-only` prints
 * the change set it would bind; a promote passes when the workspace gate it
 * runs under has an approval, as an opted-in member's release gate would,
 * and else exits 3 at its own gate.
 */
function fakePromote(cwd: string, seen: Seen[], opts: { changeSets?: Record<string, string>; fail?: string } = {}) {
  const changeSets = { api: CS_API, web: CS_WEB, ...opts.changeSets };
  return async (m: { name: string; dir: string }, argv: string[], env: Record<string, string>): Promise<MemberOpResult> => {
    seen.push({ member: m.name, argv, env });
    const release = argv[argv.indexOf("--release") + 1]!;
    if (argv.includes("--plan-only")) {
      const plan: MemberReleasePlan = { env: "prod", releaseDigest: release, label: null, op: "release", gates: ["prod-release"], changeSet: changeSets[m.name as "api" | "web"]!, empty: false, components: [m.name] };
      return { exitCode: 0, stdout: JSON.stringify(plan, null, 2), stderr: "" };
    }
    if (opts.fail === m.name) return { exitCode: 1, stdout: "", stderr: "apply failed\n" };
    const gate = env[WORKSPACE_GATE_ENV];
    const approved = gate ? (await readWorkspaceGate(cwd, gate)).approvals.some((a) => a.covers.some((c) => c.member === m.name && c.releaseDigest === release && c.planDigest === changeSets[m.name as "api" | "web"])) : false;
    if (gate && !approved) {
      return { exitCode: 3, stdout: JSON.stringify({ run: { gate: { op: "release", gate: "prod-release", planDigest: changeSets[m.name as "api" | "web"], environment: "prod" } }, recorded: [] }), stderr: "" };
    }
    if (gate === undefined) return { exitCode: 0, stdout: JSON.stringify({ recorded: [{ runId: `run-${m.name}` }] }), stderr: "" };
    await writeLedgerFiles([{ path: `_members/${m.name}/prod/releases.jsonl`, content: `${JSON.stringify({ component: m.name, releaseDigest: release })}\n` }], `fake promote ${m.name}`, { cwd });
    return { exitCode: 0, stdout: JSON.stringify({ recorded: [{ runId: `run-${m.name}` }] }), stderr: "" };
  };
}

describe("a train of two members promotes together", () => {
  test("a line written before the digest gets it computed on read", async () => {
    const cwd = repo();
    const members = [rel("api", REL_API), rel("web", REL_WEB)];
    const older: ReleaseTrainRecord = { version: 1, id: "train-old", env: "prod", timestamp: "t", actor: "a", members };
    await appendReleaseTrain(cwd, older);
    const { records } = await readReleaseTrains(cwd, "prod");
    expect(records[0]!.trainDigest).toBe(trainDigest(members));
  });

  test("under one workspace gate: nothing deploys before the approval, then both promote, producer first", async () => {
    const cwd = repo();
    const train = await recordTrain(cwd, [rel("web", REL_WEB, "w1"), rel("api", REL_API, "a1")]);
    const seen: Seen[] = [];
    const run = () => promoteTrain({ cwd, env: "prod", gate: "train-prod", readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakePromote(cwd, seen) });

    const planned = await promoteTrain({ cwd, env: "prod", dryRun: true, readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakePromote(cwd, seen) });
    expect(planned).toMatchObject({ kind: "planned", order: ["api", "web"] });
    expect(seen).toEqual([]);

    const first = await run();
    if (first.kind !== "ran") throw new Error(first.kind);
    expect(first.record.status).toBe("gated");
    expect(seen.map((s) => [s.member, s.argv.includes("--plan-only")])).toEqual([["api", true], ["web", true]]);
    expect(seen[0]!.argv).toEqual(["components", "promote", "--to", "prod", "--release", REL_API, "--plan-only", "--json"]);
    expect(first.pending).toMatchObject({ gate: "train-prod", train: { id: train.id, digest: train.trainDigest } });
    expect(first.pending!.covers).toEqual([
      { member: "api", op: "release", gate: "prod-release", planDigest: CS_API, environment: "prod", releaseDigest: REL_API },
      { member: "web", op: "release", gate: "prod-release", planDigest: CS_WEB, environment: "prod", releaseDigest: REL_WEB },
    ]);
    expect(first.record.steps.map((s) => [s.member, s.status])).toEqual([["api", "gated"], ["web", "gated"]]);
    expect(git(["ls-tree", "-r", "--name-only", "chant/lifecycle"], cwd)).not.toMatch(/releases\.jsonl/);

    // Asking again before the approval records no second fact.
    seen.length = 0;
    const again = await run();
    if (again.kind !== "ran") throw new Error(again.kind);
    expect(again.record.status).toBe("gated");
    expect(again.pending!.digest).toBe(first.pending!.digest);
    expect((await readWorkspaceGate(cwd, "train-prod")).pending).toHaveLength(1);
    expect(seen.every((s) => s.argv.includes("--plan-only"))).toBe(true);

    const approval = await approveWorkspaceGate(cwd, { gate: "train-prod", approvedBy: "alice", timestamp: "2026-11-15T01:00:00Z" });
    expect(approval.train).toEqual({ id: train.id, digest: train.trainDigest });

    seen.length = 0;
    const done = await run();
    if (done.kind !== "ran") throw new Error(done.kind);
    expect(done.record.status).toBe("ok");
    expect(done.approved).toBe(approval.digest);
    const deploys = seen.filter((s) => !s.argv.includes("--plan-only"));
    expect(deploys.map((s) => s.member)).toEqual(["api", "web"]);
    expect(deploys.every((s) => s.env[WORKSPACE_GATE_ENV] === "train-prod" && s.env[WORKSPACE_RUN_ENV] === done.record.id)).toBe(true);
    expect(done.record.steps.map((s) => [s.target, s.status, s.memberRun])).toEqual([
      ["api/components promote", "ok", "run-api"],
      ["web/components promote", "ok", "run-web"],
    ]);
    expect(done.record.train).toEqual({ id: train.id, digest: train.trainDigest });
    expect(git(["show", "chant/lifecycle:_members/api/prod/releases.jsonl"], cwd)).toContain(REL_API);
    expect(git(["show", "chant/lifecycle:_members/web/prod/releases.jsonl"], cwd)).toContain(REL_WEB);

    // The read a lane draws a train from: the train, then each run that promoted it, member by member.
    const listed = trainsWithPromotions((await readReleaseTrains(cwd, "prod")).records, (await readWorkspaceRuns(cwd, "prod")).records);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.trainDigest).toBe(train.trainDigest);
    expect(listed[0]!.promotions.map((p) => p.status)).toEqual(["gated", "gated", "ok"]);
    expect(listed[0]!.promotions.at(-1)!.members).toEqual([
      { member: "api", status: "ok", memberRun: "run-api" },
      { member: "web", status: "ok", memberRun: "run-web" },
    ]);
  });

  test("a member whose change set moved since the approval asks for a new one, and nothing deploys", async () => {
    const cwd = repo();
    await recordTrain(cwd, [rel("api", REL_API), rel("web", REL_WEB)]);
    const seen: Seen[] = [];
    const readGraph = async () => ({ graph: graph(), failed: false });
    const first = await promoteTrain({ cwd, env: "prod", gate: "train-prod", readGraph, runMember: fakePromote(cwd, seen) });
    if (first.kind !== "ran") throw new Error(first.kind);
    await approveWorkspaceGate(cwd, { gate: "train-prod", approvedBy: "alice", timestamp: "2026-11-15T01:00:00Z" });
    seen.length = 0;
    const moved = await promoteTrain({ cwd, env: "prod", gate: "train-prod", readGraph, runMember: fakePromote(cwd, seen, { changeSets: { web: CS_WEB_MOVED } }) });
    if (moved.kind !== "ran") throw new Error(moved.kind);
    expect(moved.record.status).toBe("gated");
    expect(moved.pending!.digest).not.toBe(first.pending!.digest);
    expect(moved.pending!.covers.find((c) => c.member === "web")!.planDigest).toBe(CS_WEB_MOVED);
    expect(seen.every((s) => s.argv.includes("--plan-only"))).toBe(true);
  });

  test("without a workspace gate, each member's own gates apply, and a failed producer stops its consumer", async () => {
    const cwd = repo();
    await recordTrain(cwd, [rel("web", REL_WEB), rel("api", REL_API)]);
    const seen: Seen[] = [];
    const out = await promoteTrain({ cwd, env: "prod", readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakePromote(cwd, seen, { fail: "api" }) });
    if (out.kind !== "ran") throw new Error(out.kind);
    expect(seen.map((s) => s.member)).toEqual(["api"]);
    expect(seen[0]!.env[WORKSPACE_GATE_ENV]).toBeUndefined();
    expect(out.record.status).toBe("fail");
    expect(out.record.steps.map((s) => s.status)).toEqual(["fail", "not-run"]);
    expect(out.pending).toBeNull();
  });

  test("refuses with no train, a train named that does not exist, or a member the graph does not compose", async () => {
    const cwd = repo();
    const readGraph = async () => ({ graph: graph(), failed: false });
    expect(await promoteTrain({ cwd, env: "prod", readGraph })).toMatchObject({ kind: "refused", message: expect.stringMatching(/no release train is recorded for prod/) });
    await recordTrain(cwd, [rel("api", REL_API), rel("db", REL_WEB)]);
    expect(await promoteTrain({ cwd, env: "prod", train: "train-x", readGraph })).toMatchObject({ kind: "refused", message: "no release train train-x is recorded for prod" });
    expect(await promoteTrain({ cwd, env: "prod", readGraph })).toMatchObject({ kind: "refused", message: expect.stringMatching(/pins db, which the workspace graph does not compose/) });
  });
});
