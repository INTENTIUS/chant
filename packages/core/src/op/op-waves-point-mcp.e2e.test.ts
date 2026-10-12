/**
 * #3863: a wave gate that asks a decision point (#3836) under a spec that is
 * `neverOverMcp` records that on its pending fact, so an answer to its
 * question over MCP is refused (`answer-never-over-mcp`, #3817) and the same
 * answer from a shell passes the wave.
 *
 * The workspace is real (a git repository with the reference workspace's
 * answer kind, a points file and a trust policy at base), and so is the
 * asker. The run's pending facts go to the workspace's own `chant/lifecycle`,
 * where `points answer` reads them; the run reads them back from memory, as a
 * repository without a remote cannot fetch the ledger branch.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanScratch, git, workspace } from "../workspace/__fixtures__/decide-workspace";
import { runWorkspacePoints } from "../workspace/points-cli";
import type { CommandContext } from "../cli/registry";
import { createWorkspaceTools } from "../cli/mcp/workspace-tools";
import { resetGateOrigin, setGateOrigin } from "../lifecycle/gate-origin";
import { appendPendingGate } from "../lifecycle/gate-ledger";
import { memoryGateLedgerPort, type GateLedgerPort } from "./gate";
import type { OpWavesSpec } from "./op-waves";
import { runOpWave, type OpWaveExec, type OpWaveRunsFile, type OpWaveShowAtBase } from "./op-waves-run";
import { workspaceGatePointAsker } from "./gate-point-run";

const digest = (n: string) => `sha256:${n.repeat(64)}`;

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

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
  applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
  point: { name: "prod-apply" },
  neverOverMcp: true,
  waves: [{ name: "net", runs: [{ target: "vpc" }, { target: "nat" }] }],
};

let root: string;
const applied: string[] = [];

const exec: OpWaveExec = (argv, dir) => {
  const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
  if (argv[1] === "plan") {
    writeFileSync(join(dir, argv[4]!), JSON.stringify({
      runs: runs.runs.map((r, i) => ({ target: r.target, planDigest: digest(String(i + 1)) })),
      pending: { commit: "c".repeat(40) },
    }));
  }
  if (argv[1] === "apply") applied.push(...runs.runs.map((r) => r.target));
  return 0;
};
const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });

/** The in-memory port, with each pending fact also appended to the workspace's chant/lifecycle. */
function ledgerPort(): GateLedgerPort & { appended: ReturnType<typeof memoryGateLedgerPort>["appended"] } {
  const memory = memoryGateLedgerPort();
  return {
    ...memory,
    async appendPending(input) {
      await appendPendingGate(input, { cwd: root });
      return memory.appendPending(input);
    },
  };
}

type Doc = Record<string, unknown> & { error?: { code: string; message: string } };

/** The `points-answer` tool, as `chant serve mcp` serves it in the workspace. */
async function overMcp(params: Record<string, unknown>): Promise<Doc> {
  const tool = createWorkspaceTools({ cwd: root }).find((t) => t.definition.name === "points-answer")!;
  return (await tool.handler(params, {} as never)) as Doc;
}

/** `chant workspace points answer <id> ...` through the command's handler, in the workspace. */
async function shell(id: string, by: string[], answer: string): Promise<Doc> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const was = process.cwd();
  process.chdir(root);
  try {
    const ctx = { args: { extraPositional: "answer", extraPositional2: id, answer, bys: by, json: true }, plugins: [], serializers: [] } as unknown as CommandContext;
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
  vi.stubEnv("CI", "");
  mkdirSync(join(root, ".chant"), { recursive: true });
  writeFileSync(join(root, ".chant", "trust.json"), JSON.stringify({ schema: 1, roles: { agent: ["bot"], lead: ["alice", "bob"] } }));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "trust");
});

afterEach(() => resetGateOrigin());
afterAll(cleanScratch);

describe("a neverOverMcp wave's point gate is not answered over MCP (#3863)", () => {
  test("the pending fact carries neverOverMcp and the plans file's fields; an MCP answer is refused; a shell answer passes the wave", async () => {
    const gates = ledgerPort();
    const asker = workspaceGatePointAsker(root);
    const run = (now: string) => runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: root, exec, show, gates, points: asker, now, log: () => {} });

    const waiting = await run("2026-10-11T10:00:00.000Z");
    expect(waiting.exitCode).toBe(3);
    const id = waiting.decision!.point!.question!.id;
    expect(gates.appended[0]).toMatchObject({ op: "tf-apply", gate: "wave-1", commit: "c".repeat(40), neverOverMcp: true, answer: { point: "prod-apply", id } });

    setGateOrigin("mcp");
    const refused = await overMcp({ id, answer: true, by: ["alice", "bob"] });
    expect(refused.error?.code).toBe("answer-never-over-mcp");
    expect(refused.error?.message).toContain('gate "wave-1" on "tf-apply"');
    setGateOrigin("acp");
    expect((await overMcp({ id, answer: true, by: ["alice", "bob"] })).error?.code).toBe("answer-never-over-mcp");
    resetGateOrigin();

    expect((await run("2026-10-11T10:05:00.000Z")).exitCode).toBe(3);
    expect(applied).toEqual([]);

    const answered = await shell(id, ["alice", "bob"], "yes");
    expect(answered).toMatchObject({ verb: "answer", id, written: true, question: { state: "answered", answer: true } });
    const passed = await run("2026-10-11T10:10:00.000Z");
    expect(passed).toMatchObject({ exitCode: 0, decision: { status: "approved", via: "point" } });
    expect(applied).toEqual(["vpc", "nat"]);
  });
});
