/**
 * Workspace Ops (#2554, #2524 D17, ws-030, ws-039): OPS019 over the composed
 * graph, the run's order and dependents, its ledger and the member records
 * that cite it, the workspace gate rule, and release trains.
 */
import { describe, test, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCrossRootChecks } from "../lint/post-synth";
import { ops019Check, parseWorkspaceOpTarget } from "../lint/rules/op/ops019-workspace-op-target";
import { evaluateGate, memoryGateLedgerPort } from "../op/gate";
import { buildRunRecord } from "../lifecycle/run-ledger";
import { writeLedgerFiles } from "../lifecycle/git";
import { resolveWorkspaceRun, WORKSPACE_GATE_ENV, WORKSPACE_RUN_ENV } from "../op/workspace-run-env";
import type { WorkspaceGraph } from "./compose-graph";
import { crossRootInputs, dependentsOf, orderTargets, workspaceRun, type MemberOpResult } from "./workspace-run";
import { readWorkspaceRuns } from "./workspace-ledger";
import { approveWorkspaceGate, readWorkspaceGate, workspaceGateDigest, workspaceGateStandsIn, type WorkspaceGateApproval } from "./workspace-gates";
import { pickTrain } from "./release-train";
import { decideRootCommand } from "./root-refusal";

const PLAN_A = `sha256:${"a".repeat(64)}`;
const PLAN_B = `sha256:${"b".repeat(64)}`;

function opNode(member: string, name: string, env?: string) {
  return { id: `${member}/${name}`, kind: "Chant::Op", lexicon: "chant", member, attrs: { name, overview: "t", phases: [], ...(env ? { labels: { Env: env } } : {}) } };
}

function member(name: string, status: "composed" | "skipped" | "failed" = "composed", kind = "chant") {
  return { name, dir: name, kind, status, reason: null, chant: null, irVersion: 1, live: false };
}

function link(producer: string, consumer: string) {
  return { consumer, producer, output: "out", kind: "depends-on", origin: "declared", resolves: "source", status: "resolved", label: "exact", input: null, reason: null };
}

/** network <- api <- web, and docs (other) composes nothing. */
function graph(): WorkspaceGraph {
  return {
    version: 1,
    workspace: { name: "acme", root: "." },
    members: [member("network"), member("api"), member("web"), member("docs", "skipped", "other")],
    nodes: [opNode("network", "deploy"), opNode("api", "deploy"), opNode("api", "migrate", "prod"), opNode("web", "deploy"), { id: "api/bucket", kind: "AWS::S3::Bucket", lexicon: "aws", member: "api", attrs: {} }],
    edges: [],
    groups: { byMember: {} },
    exports: [],
    imports: [],
    links: [link("network", "api"), link("api", "web")],
    collectors: [],
    records: [],
  } as unknown as WorkspaceGraph;
}

describe("OPS019: workspace Op targets against the composed graph", () => {
  test("parses <member>/<op> at the first slash", () => {
    expect(parseWorkspaceOpTarget("api/deploy")).toEqual({ member: "api", op: "deploy" });
    expect(parseWorkspaceOpTarget("api/ns/op")).toEqual({ member: "api", op: "ns/op" });
    expect(parseWorkspaceOpTarget("deploy")).toBeNull();
    expect(parseWorkspaceOpTarget("/deploy")).toBeNull();
    expect(parseWorkspaceOpTarget("api/")).toBeNull();
  });

  test("each composed chant member is one root, with its Ops among the entities", () => {
    const roots = crossRootInputs(graph());
    expect(roots.map((r) => r.root)).toEqual(["network", "api", "web"]);
    const api = roots.find((r) => r.root === "api")!;
    expect([...api.buildResult.entities.keys()].sort()).toEqual(["bucket", "deploy", "migrate"]);
    expect(api.buildResult.entities.get("deploy")!.entityType).toBe("Chant::Op");
  });

  test("a target naming a declared Op passes; an unknown Op or a member not composed fails", () => {
    const roots = crossRootInputs(graph());
    const ok = runCrossRootChecks([ops019Check([{ member: "api", op: "deploy" }])], roots);
    expect(ok).toEqual([]);
    const bad = runCrossRootChecks([ops019Check([{ member: "api", op: "nope" }, { member: "docs", op: "deploy" }, { member: "ghost", op: "x" }])], roots);
    expect(bad.map((d) => d.checkId)).toEqual(["OPS019", "OPS019", "OPS019"]);
    expect(bad[0]!.message).toContain('declares no Op named "nope"');
    expect(bad[0]!.message).toContain("deploy, migrate");
    expect(bad[0]!.root).toBe("api");
    expect(bad[1]!.message).toContain('member "docs" is not in the composed graph');
    expect(bad[2]!.missing).toEqual({ kind: "member", scope: "ghost" });
  });
});

describe("order and dependents", () => {
  test("dependents follow member links transitively, nearest first", () => {
    expect(dependentsOf("network", graph().links)).toEqual(["api", "web"]);
    expect(dependentsOf("web", graph().links)).toEqual([]);
  });

  test("a producer's target runs before its consumers', whatever order they were named in", () => {
    const order = orderTargets([{ member: "web", op: "deploy" }, { member: "network", op: "deploy" }, { member: "api", op: "deploy" }], graph().links);
    expect(order.map((t) => t.member)).toEqual(["network", "api", "web"]);
  });

  test("unlinked targets keep the order given", () => {
    const order = orderTargets([{ member: "web", op: "deploy" }, { member: "docs", op: "x" }], []);
    expect(order.map((t) => t.member)).toEqual(["web", "docs"]);
  });
});

// ── Runs, against a real chant/lifecycle branch ──────────────────────────────

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-ws-run-")));
  dirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/**
 * A member runner that behaves like `chant run`: it writes the member's run
 * record, citing the workspace run it found in its environment, and for a
 * gated exit a pending gate fact with a plan digest.
 */
function fakeMembers(cwd: string, exits: Record<string, number>, seen: Array<{ member: string; argv: string[]; env: Record<string, string> }>) {
  let n = 0;
  return async (m: { name: string; dir: string }, argv: string[], env: Record<string, string>): Promise<MemberOpResult> => {
    seen.push({ member: m.name, argv, env });
    const op = argv[1]!;
    const exitCode = exits[`${m.name}/${op}`] ?? 0;
    const cite = resolveWorkspaceRun(env)!;
    const id = `run-${++n}`;
    const record = {
      version: 1,
      ...buildRunRecord({ name: op, labels: {} }, [], {
        started: "2026-10-23T00:00:00Z",
        ended: "2026-10-23T00:00:01Z",
        status: exitCode === 3 ? "gated" : exitCode === 0 ? "ok" : "fail",
        id,
        workspaceRun: cite,
        ...(exitCode === 3 ? { gate: { name: "approve", since: "2026-10-23T00:00:01Z" } } : {}),
      }),
    };
    const files = [{ path: `_members/${m.name}/local/runs__${op}.jsonl`, content: `${JSON.stringify(record)}\n` }];
    if (exitCode === 3) {
      const pending = { version: 1, kind: "pending", op, gate: "approve", timestamp: "2026-10-23T00:00:01Z", expiresAt: "2026-10-30T00:00:01Z", runId: id, planDigest: m.name === "api" ? PLAN_A : PLAN_B };
      files.push({ path: `_members/${m.name}/_gates/${op}.jsonl`, content: `${JSON.stringify(pending)}\n` });
    }
    await writeLedgerFiles(files, `fake run ${id}`, { cwd });
    return { exitCode, stdout: `ran ${op}\n`, stderr: "" };
  };
}

describe("chant workspace run", () => {
  test("refuses before running anything when OPS019 finds a target that doesn't exist", async () => {
    const seen: Array<{ member: string; argv: string[]; env: Record<string, string> }> = [];
    const cwd = repo();
    const out = await workspaceRun({ cwd, targets: ["api/deploy", "api/nope"], readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakeMembers(cwd, {}, seen) });
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") expect(out.findings.map((f) => f.checkId)).toEqual(["OPS019"]);
    expect(seen).toEqual([]);
  });

  test("runs each target under the workspace run's id, in link order, and records it under _members/_workspace/", async () => {
    const seen: Array<{ member: string; argv: string[]; env: Record<string, string> }> = [];
    const cwd = repo();
    const out = await workspaceRun({ cwd, targets: ["web/deploy", "api/deploy"], readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakeMembers(cwd, {}, seen) });
    expect(out.kind).toBe("ran");
    if (out.kind !== "ran") return;
    expect(seen.map((s) => s.member)).toEqual(["api", "web"]);
    expect(seen[0]!.argv).toEqual(["run", "deploy"]);
    expect(seen.every((s) => s.env[WORKSPACE_RUN_ENV] === out.record.id)).toBe(true);
    expect(out.record.status).toBe("ok");
    // Each member record cites the workspace run, and the workspace record names each member run.
    expect(out.record.steps.map((s) => [s.target, s.status, s.memberRun])).toEqual([["api/deploy", "ok", "run-1"], ["web/deploy", "ok", "run-2"]]);
    expect(out.ledgerError).toBeNull();
    expect(git(["show", "chant/lifecycle:_members/_workspace/local/runs.jsonl"], cwd)).toContain(out.record.id);
    const api = JSON.parse(git(["show", "chant/lifecycle:_members/api/local/runs__deploy.jsonl"], cwd)) as { workspaceRun: { id: string } };
    expect(api.workspaceRun.id).toBe(out.record.id);
    expect((await readWorkspaceRuns(cwd)).records.map((r) => r.id)).toEqual([out.record.id]);
  });

  test("stops at the first step that fails", async () => {
    const seen: Array<{ member: string; argv: string[]; env: Record<string, string> }> = [];
    const cwd = repo();
    const out = await workspaceRun({ cwd, targets: ["network/deploy", "api/deploy", "web/deploy"], readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakeMembers(cwd, { "api/deploy": 1 }, seen) });
    if (out.kind !== "ran") throw new Error(out.kind);
    expect(out.record.status).toBe("fail");
    expect(out.record.steps.map((s) => s.status)).toEqual(["ok", "fail", "not-run"]);
  });

  test("--dependents-of runs the Op in every dependent, not in the member itself, and skips a dependent without it", async () => {
    const g = graph();
    g.nodes = g.nodes.filter((n) => n.id !== "web/deploy");
    const seen: Array<{ member: string; argv: string[]; env: Record<string, string> }> = [];
    const cwd = repo();
    const planned = await workspaceRun({ cwd, targets: [], dependentsOf: "network", op: "deploy", dryRun: true, readGraph: async () => ({ graph: g, failed: false }), runMember: fakeMembers(cwd, {}, seen) });
    expect(planned).toMatchObject({ kind: "planned", targets: ["api/deploy"], skipped: [{ member: "web", reason: 'declares no Op named "deploy"' }] });
    expect(seen).toEqual([]);
    const refused = await workspaceRun({ cwd, targets: [], dependentsOf: "network", readGraph: async () => ({ graph: g, failed: false }) });
    expect(refused).toMatchObject({ kind: "refused", message: "--dependents-of needs the Op to run: --op <op>" });
  });

  test("with --gate, gated members are gathered into one workspace gate pending fact over their plans", async () => {
    const seen: Array<{ member: string; argv: string[]; env: Record<string, string> }> = [];
    const cwd = repo();
    const out = await workspaceRun({ cwd, targets: ["api/deploy", "web/deploy"], gate: "release", readGraph: async () => ({ graph: graph(), failed: false }), runMember: fakeMembers(cwd, { "api/deploy": 3, "web/deploy": 3 }, seen) });
    if (out.kind !== "ran") throw new Error(out.kind);
    expect(seen.every((s) => s.env[WORKSPACE_GATE_ENV] === "release")).toBe(true);
    expect(out.record.status).toBe("gated");
    expect(out.record.steps.map((s) => s.status)).toEqual(["gated", "gated"]);
    expect(out.pending?.covers).toEqual([
      { member: "api", op: "deploy", gate: "approve", planDigest: PLAN_A },
      { member: "web", op: "deploy", gate: "approve", planDigest: PLAN_B },
    ]);
    const approval = await approveWorkspaceGate(cwd, { gate: "release", approvedBy: "alice", timestamp: "2026-10-23T01:00:00Z" });
    expect(approval.digest).toBe(out.pending!.digest);
    expect((await readWorkspaceGate(cwd, "release")).approvals).toHaveLength(1);
  });
});

describe("a workspace gate never satisfies a member gate unless it covers the plan and the member opts in at base (ws-039)", () => {
  const covers = [{ member: "api", op: "deploy", gate: "approve", planDigest: PLAN_A }];
  const approval: WorkspaceGateApproval = { version: 1, kind: "approval", gate: "release", digest: workspaceGateDigest(covers), covers, approvedBy: "alice", timestamp: "2026-10-23T01:00:00Z" };
  const q = { op: "deploy", gate: "approve", planDigest: PLAN_A };

  test("a member that has not opted in is never satisfied", () => {
    expect(workspaceGateStandsIn(q, { member: "api", optedIn: false, approvals: [approval] })).toBeNull();
  });

  test("an opted-in member is satisfied only for the plan the approval covers", () => {
    expect(workspaceGateStandsIn(q, { member: "api", optedIn: true, approvals: [approval] })).toBe(approval);
    expect(workspaceGateStandsIn({ ...q, planDigest: PLAN_B }, { member: "api", optedIn: true, approvals: [approval] })).toBeNull();
    expect(workspaceGateStandsIn(q, { member: "web", optedIn: true, approvals: [approval] })).toBeNull();
    expect(workspaceGateStandsIn({ ...q, gate: "other" }, { member: "api", optedIn: true, approvals: [approval] })).toBeNull();
  });

  test("covers edited after the approval no longer hash to its digest, and count for nothing", () => {
    const edited = { ...approval, covers: [{ ...covers[0]!, planDigest: PLAN_B }] };
    expect(workspaceGateStandsIn({ ...q, planDigest: PLAN_B }, { member: "api", optedIn: true, approvals: [edited] })).toBeNull();
  });

  test("evaluateGate passes a plan-bound gate via the workspace only when the stand-in answers, and writes nothing to the member's ledger", async () => {
    const port = memoryGateLedgerPort();
    const standIn = { standIn: async () => ({ gate: "release", digest: approval.digest, approvedBy: "alice", timestamp: approval.timestamp }) };
    const passed = await evaluateGate(port, { op: "deploy", gate: "approve", planDigest: PLAN_A, now: "2026-10-23T02:00:00Z", workspace: standIn });
    expect(passed).toMatchObject({ satisfied: true, via: "workspace", resolution: { resolvedBy: "alice", workspaceGate: { gate: "release", digest: approval.digest } } });
    expect(port.resolved).toEqual([]);

    const refused = await evaluateGate(memoryGateLedgerPort(), { op: "deploy", gate: "approve", planDigest: PLAN_A, now: "2026-10-23T02:00:00Z", workspace: { standIn: async () => null } });
    expect(refused.satisfied).toBe(false);
  });

  test("a gate bound to no plan never asks the workspace", async () => {
    let asked = false;
    const check = await evaluateGate(memoryGateLedgerPort(), { op: "deploy", gate: "approve", now: "2026-10-23T02:00:00Z", workspace: { standIn: async () => { asked = true; return null; } } });
    expect(check.satisfied).toBe(false);
    expect(asked).toBe(false);
  });
});

describe("member run records cite the workspace run", () => {
  test("the environment names the run and its gate; a plain run names neither", () => {
    expect(resolveWorkspaceRun({ [WORKSPACE_RUN_ENV]: "ws-1", [WORKSPACE_GATE_ENV]: "release" })).toEqual({ id: "ws-1", gate: "release" });
    expect(resolveWorkspaceRun({})).toBeUndefined();
  });

  test("buildRunRecord carries the citation only when given one", () => {
    const base = { started: "a", ended: "b", status: "ok" as const };
    expect(buildRunRecord({ name: "deploy" }, [], { ...base, workspaceRun: { id: "ws-1" } }).workspaceRun).toEqual({ id: "ws-1" });
    expect("workspaceRun" in buildRunRecord({ name: "deploy" }, [], base)).toBe(false);
  });
});

describe("release trains", () => {
  const rel = (member: string, digest: string, label: string | null) => ({ member, releaseDigest: digest, commit: "c".repeat(40), label });
  test("pins the newest release of every member", () => {
    const picked = pickTrain([
      { member: "api", releases: [rel("api", "sha256:2", "v2"), rel("api", "sha256:1", "v1")] },
      { member: "web", releases: [rel("web", "sha256:9", null)] },
    ]);
    expect(picked).toEqual({ members: [rel("api", "sha256:2", "v2"), rel("web", "sha256:9", null)] });
  });

  test("a pin picks a release by label or digest", () => {
    const picked = pickTrain([{ member: "api", releases: [rel("api", "sha256:2", "v2"), rel("api", "sha256:1", "v1")] }], new Map([["api", "v1"]]));
    expect(picked).toEqual({ members: [rel("api", "sha256:1", "v1")] });
  });

  test("refuses when any member has no release, so a train never leaves one out", () => {
    const picked = pickTrain([{ member: "api", releases: [rel("api", "sha256:2", "v2")] }, { member: "web", releases: [] }], new Map([["ghost", "v1"]]));
    expect(picked).toEqual({ problems: ["--pin ghost: not a chant member of the workspace", "member web has no release; cut one with chant release cut in its directory"] });
  });
});

describe("chant run at a declared root keeps the root's own Ops", () => {
  test("Op discovery at the root finds the root's Ops and none of a member's", async () => {
    const dir = repo();
    const op = (name: string) => `export default { props: { name: ${JSON.stringify(name)}, overview: "t", phases: [{ name: "Run", steps: [] }] } };\n`;
    writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: [] }));
    writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "api", dir: "api", kind: "chant" }] }));
    mkdirSync(join(dir, "ops"), { recursive: true });
    writeFileSync(join(dir, "ops", "root.op.ts"), op("root-op"));
    mkdirSync(join(dir, "api", "ops"), { recursive: true });
    writeFileSync(join(dir, "api", "chant.config.json"), JSON.stringify({ lexicons: [] }));
    writeFileSync(join(dir, "api", "ops", "deploy.op.ts"), op("deploy"));
    const { discoverOps } = await import("../op/discover");
    const { ops } = await discoverOps({ cwd: dir });
    expect([...ops.keys()]).toEqual(["root-op"]);
    // A root build is guarded (WSP000); `run` is not, so it runs the root's Ops above.
    expect(decideRootCommand({ verb: "build", target: dir, workspaceDir: dir, rootOnly: false }).action).toBe("refuse");
  });
});
