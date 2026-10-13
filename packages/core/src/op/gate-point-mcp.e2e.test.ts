/**
 * #3817: a gate that asks a decision point is not passed by an answer sent
 * over MCP or ACP. The answer there is an agent's, so nobody it names counts
 * toward a human quorum and the gate keeps waiting; a question whose gate is
 * `neverOverMcp` is refused outright. The same answer from a shell answers
 * it, and the next run passes.
 *
 * The workspace is real (a git repository with the reference workspace's
 * answer kind, a points file and a trust policy at base). The MCP answer goes
 * through the `points-answer` tool's own handler with this process serving
 * MCP, the shell answer through `runWorkspacePoints`. The gate ledger the run
 * writes is the in-memory port; the `neverOverMcp` pending fact is on the
 * workspace's own `chant/lifecycle`, where `points answer` reads it.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanScratch, git, workspace } from "../workspace/__fixtures__/decide-workspace";
import { runWorkspacePoints } from "../workspace/points-cli";
import type { CommandContext } from "../cli/registry";
import { createWorkspaceTools } from "../cli/mcp/workspace-tools";
import { GATE_ORIGIN_ENV, resetGateOrigin, setGateOrigin } from "../lifecycle/gate-origin";
import { appendPendingGate } from "../lifecycle/gate-ledger";
import { ApplyOp } from "./composites/apply-op";
import { memoryGateLedgerPort } from "./gate";
import { runOpLocally } from "./local-executor";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN = `jcs1-sha256:${"3".repeat(64)}`;

const POINTS = {
  points: {
    "prod-apply": {
      title: "Apply this plan to prod",
      question: { type: "noul", instructions: "Should this plan be applied to prod?", criteria: { true: "Apply it.", false: "Do not apply it." } },
      inputs: { "gate.component": "the Op the gate belongs to", "gate.planDigest": "the plan the gate binds" },
      deciders: [{ kind: "quorum", count: 2, roles: ["lead"] }],
    },
  },
};

let root: string;
const applied: string[] = [];
const activities = new Map<string, ActivityFn>([
  ["chantBuild", async () => ({ ok: true })],
  ["lifecycleDiff", async () => ({ planDigest: PLAN, drifted: true })],
  ["nativeApply", async () => {
    applied.push(PLAN);
    return { ok: true };
  }],
]);

const config = (name: string): OpConfig =>
  (ApplyOp({ name, env: "prod", target: "kubectl", gate: { gate: "approve-apply", point: "prod-apply" } }).op as unknown as { props: OpConfig }).props;

type Doc = Record<string, unknown> & { error?: { code: string; message: string } };

/** The `points-answer` and `points-retract` tools, as `chant serve mcp` serves them in the workspace. */
function mcpTool(name: "points-answer" | "points-retract"): (params: Record<string, unknown>) => Promise<Doc> {
  const tool = createWorkspaceTools({ cwd: root }).find((t) => t.definition.name === name)!;
  return async (params) => (await tool.handler(params, {} as never)) as Doc;
}

/** `chant workspace points <verb> <id> ...` through the command's handler, in the workspace. Returns the document it prints. */
async function shell(verb: "answer" | "retract", id: string, by: string[], answer?: string): Promise<Doc> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const was = process.cwd();
  process.chdir(root);
  try {
    const ctx = { args: { extraPositional: verb, extraPositional2: id, ...(answer !== undefined ? { answer } : {}), bys: by, json: true }, plugins: [], serializers: [] } as unknown as CommandContext;
    await runWorkspacePoints(ctx);
  } finally {
    process.chdir(was);
    log.mockRestore();
    err.mockRestore();
  }
  return JSON.parse(printed.join("\n")) as Doc;
}

beforeAll(() => {
  root = workspace(POINTS);
  // The questions go to the working tree, as outside CI: a CI job asks into the ledger by default (#3815).
  vi.stubEnv("CI", "");
  mkdirSync(join(root, ".chant"), { recursive: true });
  writeFileSync(join(root, ".chant", "trust.json"), JSON.stringify({ schema: 1, roles: { agent: ["bot"], lead: ["alice", "bob"] } }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "trust");
});

afterEach(() => resetGateOrigin());
afterAll(cleanScratch);

describe("an answer over MCP or ACP never passes a gate that needs a human quorum (#3817)", () => {
  test("points-answer over MCP naming the quorum's people does not answer; the gate keeps waiting; the same answer from a shell passes it", async () => {
    const port = memoryGateLedgerPort();
    const op = config("prod-apply");

    const first = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-11T10:00:00.000Z" });
    expect(first.status).toBe("waiting");
    const id = first.point!.id;

    // This process now serves MCP: alice and bob both hold lead, and neither counts.
    setGateOrigin("mcp");
    const overMcp = await mcpTool("points-answer")({ id, answer: true, by: ["alice", "bob"] });
    expect(overMcp.error?.code).toBe("quorum-not-met");
    expect(overMcp.error?.message).toContain("alice, who was named over MCP");
    expect(overMcp.error?.message).toContain("bob, who was named over MCP");

    // ACP is the same, and so is `chant workspace points answer` in a process a session on either started.
    setGateOrigin("acp");
    expect((await mcpTool("points-answer")({ id, answer: true, by: ["alice", "bob"] })).error?.code).toBe("quorum-not-met");
    resetGateOrigin();
    process.env[GATE_ORIGIN_ENV] = "mcp";
    expect((await shell("answer", id, ["alice", "bob"], "yes")).error?.code).toBe("quorum-not-met");
    resetGateOrigin();

    const still = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-11T10:05:00.000Z" });
    expect(still.status).toBe("waiting");
    expect(still.point?.id).toBe(id);
    expect(applied).toEqual([]);
    expect(port.resolved).toHaveLength(0);

    // From a shell the same people answer it, and the next run passes on the answer.
    const answered = await shell("answer", id, ["alice", "bob"], "yes");
    expect(answered).toMatchObject({ verb: "answer", id, written: true, question: { state: "answered", answer: true, answeredBy: ["alice", "bob"] } });
    const passed = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-11T10:10:00.000Z" });
    expect(passed.status).toBe("ok");
    expect(applied).toEqual([PLAN]);

    // Taking the answer back follows the same rule.
    setGateOrigin("mcp");
    expect((await mcpTool("points-retract")({ id, by: ["alice", "bob"] })).error?.code).toBe("quorum-not-met");
  });

  test("a question whose gate is neverOverMcp is refused over MCP outright, and answered from a shell", async () => {
    const port = memoryGateLedgerPort();
    const op = config("tf-apply");

    const first = await runOpLocally(op, activities, {}, undefined, { gates: port, cwd: root, now: "2026-10-11T11:00:00.000Z" });
    expect(first.status).toBe("waiting");
    const id = first.point!.id;
    // The gate's pending fact on chant/lifecycle says it is never resolved over MCP, as terragucci's tf-apply records it.
    await appendPendingGate({ op: "tf-apply", gate: "approve-apply", timestamp: "2026-10-11T11:00:00.000Z", expiresAt: "2026-10-13T11:00:00.000Z", planDigest: PLAN, neverOverMcp: true, answer: { point: "prod-apply", id, path: first.point!.path } }, { cwd: root });

    setGateOrigin("mcp");
    const overMcp = await mcpTool("points-answer")({ id, answer: true, by: ["alice", "bob"] });
    expect(overMcp.error?.code).toBe("answer-never-over-mcp");
    expect(overMcp.error?.message).toContain('gate "approve-apply" on "tf-apply"');
    resetGateOrigin();

    const answered = await shell("answer", id, ["alice", "bob"], "yes");
    expect(answered).toMatchObject({ verb: "answer", id, written: true, question: { state: "answered" } });

    setGateOrigin("acp");
    expect((await mcpTool("points-retract")({ id, by: ["alice", "bob"] })).error?.code).toBe("answer-never-over-mcp");
  });
});
