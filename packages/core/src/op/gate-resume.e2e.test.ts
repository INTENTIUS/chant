/**
 * #3683 end to end on a real Forgejo with a runner: a job waits at a gate
 * (exit 3), an approval lands, and {@link resumeGateRun} starts the job again
 * without a push, from the locator {@link resolveGateRunLocator} reads off the
 * job's own environment. The resume call uses a token with the
 * `write:repository` scope alone, the least Forgejo's dispatch accepts.
 *
 * The job stands in for `chant run wave`: it prints its environment and exits
 * 3 until a file named `approved` exists on the `lifecycle` branch. What a
 * chant gate records and decides is covered by the unit tests; this proves
 * the forge's half.
 *
 * Runs only with CHANT_E2E_FORGEJO_URL and CHANT_E2E_FORGEJO_TOKEN (a token
 * with every scope, which creates and deletes the repository), against a
 * Forgejo whose runner takes `docker` jobs. CHANT_E2E_FORGEJO_RESUME_TOKEN is
 * the token the resume calls with; mint it with the `write:repository` scope
 * alone (Forgejo mints tokens only over basic auth). Without it the resume
 * uses the first token.
 */

import { afterAll, describe, expect, test } from "vitest";
import { resolveGateRunLocator, resumeGateRun } from "./gate-resume";

const URL_ = process.env.CHANT_E2E_FORGEJO_URL?.replace(/\/+$/, "");
const TOKEN = process.env.CHANT_E2E_FORGEJO_TOKEN;
const RESUME_TOKEN = process.env.CHANT_E2E_FORGEJO_RESUME_TOKEN ?? TOKEN;
const api = `${URL_}/api/v1`;

const WORKFLOW = `name: gate
on:
  push:
    branches: [main]
  workflow_dispatch: {}
jobs:
  wait:
    runs-on: docker
    steps:
      - run: |
          env | grep -E '^(GITHUB_|FORGEJO_|GITEA_)' | grep -v TOKEN | sort | sed 's/^/CHANT_E2E_ENV /'
          code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token \${{ secrets.GITHUB_TOKEN }}" "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/contents/approved?ref=lifecycle")
          echo "approval lookup answered $code"
          [ "$code" = 200 ] || exit 3
`;

async function call(method: string, path: string, body?: unknown, token = TOKEN!): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped forge JSON
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run {
  id: number;
  status: string;
  event: string;
  trigger_event?: string;
}

async function runs(repo: string): Promise<Run[]> {
  const listed = await call("GET", `/repos/${repo}/actions/runs?limit=50`);
  return (listed.workflow_runs ?? listed) as Run[];
}

async function finished(repo: string, pick: (r: Run) => boolean, timeoutMs = 240_000): Promise<Run> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const run = (await runs(repo)).find(pick);
    if (run && !["waiting", "running", "blocked", "unknown"].includes(run.status)) return run;
    await sleep(3000);
  }
  throw new Error(`no finished run in ${repo} within ${timeoutMs}ms`);
}

describe.skipIf(!URL_ || !TOKEN)("resume a waiting job on Forgejo (#3683)", () => {
  const name = `chant-e2e-resume-${Date.now().toString(36)}`;
  let owner = "";

  afterAll(async () => {
    if (owner) await call("DELETE", `/repos/${owner}/${name}`).catch(() => undefined);
  });

  test("the job waits, the approval lands, and a dispatch resumes it without a push", async () => {
    owner = (await call("GET", "/user")).login;
    await call("POST", "/user/repos", { name, auto_init: true, default_branch: "main", private: false });
    const repo = `${owner}/${name}`;
    await call("POST", `/repos/${repo}/branches`, { new_branch_name: "lifecycle", old_branch_name: "main" });
    await call("POST", `/repos/${repo}/contents/.forgejo/workflows/gate.yml`, {
      content: Buffer.from(WORKFLOW).toString("base64"),
      message: "gate workflow",
      branch: "main",
    });

    // The push runs the job, which waits at the gate.
    const waited = await finished(repo, () => true);
    expect(waited.status).toBe("failure");

    // Its environment, as the job printed it, is what a pending fact records.
    const jobs = await call("GET", `/repos/${repo}/actions/runs/${waited.id}/jobs`);
    const jobId = (jobs.jobs ?? jobs)[0].id;
    const log = String(await call("GET", `/repos/${repo}/actions/jobs/${jobId}/logs`));
    const env: Record<string, string> = {};
    for (const m of log.matchAll(/CHANT_E2E_ENV ([A-Z_]+)=(.*)/g)) env[m[1]!] = m[2]!.trim();
    const loc = resolveGateRunLocator(env);
    expect(loc).toMatchObject({ forge: "forgejo", repo, run: String(waited.id), workflow: "gate.yml", ref: "main" });

    const token = RESUME_TOKEN!;
    // The job reaches Forgejo by the address its runner uses, which on a
    // local stack is a container name; this test reaches it by its own.
    const reachable = { ...loc!, api };

    // Approve (here: the file the job looks for), then resume.
    const approvedAt = new Date().toISOString();
    await call("POST", `/repos/${repo}/contents/approved`, { content: Buffer.from("yes").toString("base64"), message: "approve", branch: "lifecycle" });
    const outcome = await resumeGateRun(reachable, { token, since: approvedAt });
    expect(outcome).toMatchObject({ status: "resumed", how: "dispatched gate.yml on main" });

    const resumed = await finished(repo, (r) => r.id > waited.id);
    expect(resumed.status).toBe("success");
    expect(resumed.trigger_event ?? resumed.event).toBe("workflow_dispatch");

    // A second resume finds the run that already started and starts nothing.
    expect(await resumeGateRun(reachable, { token, since: approvedAt })).toMatchObject({ status: "skipped" });
    expect((await runs(repo)).filter((r) => r.id > waited.id)).toHaveLength(1);
  }, 600_000);
});
