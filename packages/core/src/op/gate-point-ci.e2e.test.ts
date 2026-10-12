/**
 * #3815: a gate's decision-point question survives a CI job. Outside a
 * steward's turn a question used to go to the working tree, which a CI
 * checkout throws away, so `points answer` elsewhere found nothing and the
 * next run asked again. Asked into the ledger (`--store ledger`, a gate's
 * `point.store`, or by default when `CI` is set), it lands on
 * `chant/lifecycle`, is pushed, and is found and answered from another clone;
 * the job's next run, in a fresh clone, passes on that answer.
 *
 * Three clones of one bare remote stand for the CI job's checkout, the
 * person's clone the answer comes from, and the next job's checkout. The gate
 * ledger the runs write is the in-memory port, so only the question and its
 * answer travel through the remote.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanScratch, git, workspace } from "../workspace/__fixtures__/decide-workspace";
import { runWorkspacePoints } from "../workspace/points-cli";
import { runWorkspaceRecords } from "../workspace/records-cli";
import type { CommandContext } from "../cli/registry";
import { ApplyOp } from "./composites/apply-op";
import { memoryGateLedgerPort } from "./gate";
import { defaultGatePointStore, type GatePoint } from "./gate-point";
import { runOpLocally } from "./local-executor";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN = `jcs1-sha256:${"4".repeat(64)}`;

const POINTS = {
  points: {
    "prod-apply": {
      title: "Apply this plan to prod",
      question: { type: "noul", instructions: "Should this plan be applied to prod?", criteria: { true: "Apply it.", false: "Do not apply it." } },
      inputs: { "gate.component": "the Op the gate belongs to", "gate.planDigest": "the plan the gate binds" },
      deciders: [{ kind: "quorum", count: 1 }],
    },
    "ship-it": {
      title: "Ship it",
      question: { type: "noul", instructions: "Ship it?", criteria: { true: "Ship.", false: "Hold." } },
      inputs: { "release.version": "the version" },
      deciders: [{ kind: "quorum", count: 1 }],
    },
  },
};

const applied: string[] = [];
const activities = new Map<string, ActivityFn>([
  ["chantBuild", async () => ({ ok: true })],
  ["lifecycleDiff", async () => ({ planDigest: PLAN, drifted: true })],
  ["nativeApply", async () => {
    applied.push(PLAN);
    return { ok: true };
  }],
]);

const config = (name: string, point: string | GatePoint): OpConfig =>
  (ApplyOp({ name, env: "prod", target: "kubectl", gate: { gate: "approve-apply", point } }).op as unknown as { props: OpConfig }).props;

let home: string;
let remote: string;

/** A fresh clone of the remote: a CI job's checkout, or a person's. */
function clone(name: string): string {
  const dir = join(home, name);
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  return dir;
}

/** `chant workspace points <argv>` through the command's handler, in `cwd`. Returns the document it prints. */
async function points(cwd: string, args: Record<string, unknown>, handler = runWorkspacePoints): Promise<Record<string, unknown> & { error?: { code: string } }> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  const was = process.cwd();
  process.chdir(cwd);
  try {
    await handler({ args, plugins: [], serializers: [] } as unknown as CommandContext);
  } finally {
    process.chdir(was);
    log.mockRestore();
  }
  return JSON.parse(printed.join("\n"));
}

const answersIn = (dir: string): string[] => (existsSync(join(dir, "answers")) ? readdirSync(join(dir, "answers")).filter((f) => f.endsWith(".md")) : []);
const run = (op: OpConfig, cwd: string) => runOpLocally(op, activities, {}, undefined, { gates: memoryGateLedgerPort(), cwd, now: "2026-10-11T12:00:00.000Z" });

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "chant-gate-ci-")));
  const root = workspace(POINTS);
  remote = join(home, "remote.git");
  execFileSync("git", ["clone", "-q", "--bare", root, remote], { stdio: "ignore" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanScratch();
  rmSync(home, { recursive: true, force: true });
});

describe("a gate's question outlives the CI job that asked it (#3815)", () => {
  test("a gate with point.store ledger: asked in one clone, answered from another, and the next job's clone passes on it", async () => {
    vi.stubEnv("CI", "");
    const op = config("prod-apply", { name: "prod-apply", store: "ledger" });

    const job = clone("job-1");
    const first = await run(op, job);
    expect(first.status).toBe("waiting");
    const id = first.point!.id;
    // Nothing was written to the job's working tree, which goes away with the job.
    expect(answersIn(job)).toEqual([]);
    expect(git(job, "status", "--porcelain")).toBe("");

    // A person's clone, which never ran the job, finds the question and answers it.
    const person = clone("person");
    const answered = await points(person, { extraPositional: "answer", extraPositional2: id, answer: "yes", bys: ["alice"] });
    expect(answered).toMatchObject({ verb: "answer", id, written: true, question: { state: "answered", answer: true, ledger: expect.stringContaining("chant/lifecycle:") } });

    // The next job, in a fresh checkout, passes on that answer.
    const next = await run(op, clone("job-2"));
    expect(next.status).toBe("ok");
    expect(applied).toEqual([PLAN]);
  });

  test("with CI set, a gate that names no store asks into the ledger", async () => {
    expect(defaultGatePointStore({ CI: "true" })).toBe("ledger");
    expect(defaultGatePointStore({ CI: "false" })).toBeUndefined();
    expect(defaultGatePointStore({})).toBeUndefined();

    vi.stubEnv("CI", "true");
    const op = config("ci-apply", "prod-apply");
    const job = clone("job-3");
    const first = await run(op, job);
    expect(first.status).toBe("waiting");
    expect(answersIn(job)).toEqual([]);

    const person = clone("person-2");
    expect(await points(person, { extraPositional: "answer", extraPositional2: first.point!.id, answer: "yes", bys: ["alice"] })).toMatchObject({ written: true });
    expect((await run(op, clone("job-4"))).status).toBe("ok");
  });

  test("chant workspace points ask --store ledger holds the question on chant/lifecycle, and another clone answers it", async () => {
    vi.stubEnv("CI", "");
    const job = clone("ask-job");
    const asked = await points(job, { extraPositional: "ask", extraPositional2: "ship-it", inputs: JSON.stringify({ "release.version": "1.2.3" }), store: "ledger" });
    expect(asked).toMatchObject({ verb: "ask", written: true, question: { state: "escalated", ledger: expect.stringContaining("chant/lifecycle:") } });
    expect(answersIn(job)).toEqual([]);

    const id = asked.id as string;
    const person = clone("ask-person");
    expect(await points(person, { extraPositional: "answer", extraPositional2: id, answer: "no", bys: ["bob"] })).toMatchObject({ written: true, question: { state: "answered", answer: false } });

    // Asked again from a fresh checkout, the question is the answered one.
    const again = await points(clone("ask-job-2"), { extraPositional: "ask", extraPositional2: "ship-it", inputs: JSON.stringify({ "release.version": "1.2.3" }), store: "ledger" });
    expect(again).toMatchObject({ reused: true, question: { state: "answered", answer: false } });

    // Without --store ledger the same ask in a clone with no ledger history goes to the tree, as before.
    const tree = clone("ask-tree");
    const local = await points(tree, { extraPositional: "ask", extraPositional2: "ship-it", inputs: JSON.stringify({ "release.version": "9.9.9" }) });
    expect(local).toMatchObject({ written: true, question: { ledger: null } });
    expect(answersIn(tree)).toHaveLength(1);
  });
});

describe("chant workspace records lists the answers held on chant/lifecycle (#3833)", () => {
  type Rec = { id: string; path: string; state: string; data: { answer?: unknown }; ledger?: string | null; worktree?: string };
  const answerRecords = (set: Record<string, unknown>): Rec[] => {
    const kinds = set.kinds as { kind: { name: string }; records: Rec[] }[];
    return kinds.find((k) => k.kind.name === "answer")!.records;
  };

  test("an answer asked and answered on the ledger is listed with the id, state and answer points shows", async () => {
    vi.stubEnv("CI", "");
    const op = config("records-apply", { name: "prod-apply", store: "ledger" });
    const first = await run(op, clone("records-job"));
    expect(first.status).toBe("waiting");
    const id = first.point!.id;
    expect(await points(clone("records-person"), { extraPositional: "answer", extraPositional2: id, answer: "yes", bys: ["alice"] })).toMatchObject({ written: true });

    // A clone that never held chant/lifecycle: records fetches it, as points answer does.
    const reader = clone("records-reader");
    const listed = answerRecords(await points(reader, { json: true }, runWorkspaceRecords)).find((r) => r.id === id);
    expect(listed).toMatchObject({ id, state: "answered", data: { answer: true }, ledger: expect.stringContaining("chant/lifecycle:") });
    expect(listed!.worktree).toBeUndefined();

    const doc = (await points(reader, { json: true })) as { questions: { id: string; state: string; answer: unknown; ledger: string | null; path: string }[] };
    const question = doc.questions.find((q) => q.id === id)!;
    expect({ id: listed!.id, state: listed!.state, answer: listed!.data.answer, ledger: listed!.ledger, path: listed!.path }).toEqual({
      id: question.id,
      state: question.state,
      answer: question.answer,
      ledger: question.ledger,
      path: question.path,
    });

    // The checkout doesn't hold it: --uncommitted leaves it out, and the text output says where it is.
    expect(answerRecords(await points(reader, { json: true, uncommitted: true }, runWorkspaceRecords)).map((r) => r.id)).not.toContain(id);
  });
});
