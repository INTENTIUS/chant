import { describe, expect, test, vi } from "vitest";
import type { GateResolutionRecord, PendingGateRecord } from "../../lifecycle/gate-ledger";
import type { ForgeFetch } from "../../pr-forge";
import { parseArgs } from "../main";
import { resumeStanding, resumeWaitingGates } from "./gate-resume";

// The ledgers `resumeWaitingGates` reads, without a `chant/lifecycle` branch.
const ledgers = vi.hoisted(() => new Map<string, { resolutions: unknown[]; pending: unknown[]; malformed: number }>());
vi.mock("../../lifecycle/gate-ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lifecycle/gate-ledger")>()),
  readGateLedger: async (op: string) => ledgers.get(op) ?? { resolutions: [], pending: [], malformed: 0 },
}));
vi.mock("../../lifecycle/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lifecycle/git")>()),
  listFilesInDir: async () => [...ledgers.keys()].map((op) => `${op}.jsonl`),
}));

const DIGEST = `sha256:${"a".repeat(64)}`;
const standing: PendingGateRecord = {
  version: 1,
  kind: "pending",
  op: "migrations",
  gate: "migrations-wave-2",
  timestamp: "2026-10-01T00:00:00Z",
  expiresAt: "2026-10-03T00:00:00Z",
  planDigest: DIGEST,
  resume: { forge: "github", api: "https://api.github.com", repo: "acme/db", run: "42", attempt: 1 },
};
const approval: GateResolutionRecord = { version: 1, op: "migrations", gate: "migrations-wave-2", resolvedBy: "alice", timestamp: "2026-10-01T01:00:00Z", planDigest: DIGEST };

describe("resumeStanding (#3683)", () => {
  test("no approval, no call", async () => {
    const fetch: ForgeFetch = async () => {
      throw new Error("no call expected");
    };
    expect(await resumeStanding(standing, [], { env: { GITHUB_TOKEN: "t" }, fetch })).toMatchObject({ status: "not-approved" });
  });

  test("approved: re-runs the run the pending fact names", async () => {
    const calls: string[] = [];
    const fetch: ForgeFetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const body = init.method === "GET" ? { status: "completed", conclusion: "failure", run_attempt: 1 } : null;
      return { ok: true, status: 200, text: async () => (body ? JSON.stringify(body) : "") };
    };
    const report = await resumeStanding(standing, [approval], { env: { GITHUB_TOKEN: "t" }, fetch });
    expect(report).toMatchObject({ status: "resumed", approvedBy: "alice" });
    expect(calls).toEqual(["GET /repos/acme/db/actions/runs/42", "POST /repos/acme/db/actions/runs/42/rerun-failed-jobs"]);
  });

  test("a fact recorded outside CI, or no token, resumes nothing and says why", async () => {
    const { resume: _none, ...local } = standing;
    expect(await resumeStanding(local, [approval], { env: { GITHUB_TOKEN: "t" } })).toMatchObject({ status: "no-job" });
    expect(await resumeStanding(standing, [approval], { env: {} })).toMatchObject({ status: "no-token" });
  });

  test("`--resume` takes no value on approve, and keeps its file on the applies", () => {
    expect(parseArgs(["approve", "migrations", "migrations-wave-2", "--resume"]).resumeRun).toBe(true);
    expect(parseArgs(["approve", "migrations", "g", "--resume", "--sign"])).toMatchObject({ resumeRun: true, sign: true });
    expect(parseArgs(["components", "pr-apply", "--resume", "attempt.json"]).resume).toBe("attempt.json");
  });
});

describe("resume one gate's job (#3854)", () => {
  const wave = (k: number, run: string, op = "tf-apply"): PendingGateRecord => ({
    ...standing,
    op,
    gate: `${op}-wave-${k}`,
    expiresAt: "2099-01-01T00:00:00Z",
    resume: { forge: "github", api: "https://api.github.com", repo: "acme/infra", run, attempt: 1 },
  });
  const approve = (p: PendingGateRecord): GateResolutionRecord => ({ ...approval, op: p.op, gate: p.gate });
  ledgers.set("tf-apply", {
    pending: [wave(2, "20"), wave(3, "30")],
    resolutions: [approve(wave(2, "20")), approve(wave(3, "30"))],
    malformed: 0,
  });
  ledgers.set("other", { pending: [wave(1, "10", "other")], resolutions: [approve(wave(1, "10", "other"))], malformed: 0 });

  test("without a gate, every approved job of the op is resumed", async () => {
    const reports = await resumeWaitingGates({ op: "tf-apply", dryRun: true });
    expect(reports.map((r) => r.gate).sort()).toEqual(["tf-apply-wave-2", "tf-apply-wave-3"]);
  });

  test("with a gate, only that gate's job is touched", async () => {
    const calls: string[] = [];
    const fetch: ForgeFetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`);
      const body = init.method === "GET" ? { status: "completed", conclusion: "failure", run_attempt: 1 } : null;
      return { ok: true, status: 200, text: async () => (body ? JSON.stringify(body) : "") };
    };
    const reports = await resumeWaitingGates({ op: "tf-apply", gate: "tf-apply-wave-3", env: { GITHUB_TOKEN: "t" }, fetch });
    expect(reports).toEqual([expect.objectContaining({ gate: "tf-apply-wave-3", status: "resumed" })]);
    expect(calls).toEqual(["GET /repos/acme/infra/actions/runs/30", "POST /repos/acme/infra/actions/runs/30/rerun-failed-jobs"]);
  });

  test("a gate without an op looks in every ledger; an unknown gate resumes nothing", async () => {
    expect((await resumeWaitingGates({ gate: "other-wave-1", dryRun: true })).map((r) => `${r.op}/${r.gate}`)).toEqual(["other/other-wave-1"]);
    expect(await resumeWaitingGates({ op: "tf-apply", gate: "tf-apply-wave-9", dryRun: true })).toEqual([]);
  });

  test("`chant run resume` takes --op and --gate", () => {
    expect(parseArgs(["run", "resume", "--op", "tf-apply", "--gate", "tf-apply-wave-3"])).toMatchObject({ op: "tf-apply", gate: "tf-apply-wave-3" });
  });
});
