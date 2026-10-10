import { describe, expect, test } from "vitest";
import type { GateResolutionRecord, PendingGateRecord } from "../../lifecycle/gate-ledger";
import type { ForgeFetch } from "../../pr-forge";
import { parseArgs } from "../main";
import { resumeStanding } from "./gate-resume";

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
