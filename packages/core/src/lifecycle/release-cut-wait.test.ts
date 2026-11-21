/**
 * `chant release cut --wait-checks` (#5438): under `release.green:
 * forge-checks` the cut reads the commit's checks again while any is still
 * running, with the loop `chant ci verdict --wait` waits with, and a commit
 * whose only checks are the cut's own run is refused with a message that
 * says so. The pipeline's release-cut hook passes the flag.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { cutRelease, ReleaseCutError, type CutRequest } from "./release-cut";
import { forgeChecksReader, RELEASE_CUT_WAIT_MINUTES } from "./release-green";
import type { ReleasePublish } from "./release-store";
import type { TargetCompiler } from "../components/release-compile";
import type { ForgeFetch, ForgeTarget } from "../pr-forge";
import { CI_VERDICT_BACKOFF_MS, CI_VERDICT_INTERVAL_MS } from "../workspace/ci-green-forge";
import { releaseCutHook } from "../pipeline/stages";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const noCompile: TargetCompiler = {
  async compile(env) {
    throw new Error(`compiled ${env}`);
  },
  async buildArtifacts() {
    throw new Error("built");
  },
};
const NPM: ReleasePublish = { target: "npm:0123456789abcdef", kind: "npm", destination: "registry.npmjs.org" };

function project(): TestRepo {
  const r = new TestRepo("release-cut-wait");
  repos.push(r);
  r.write("package.json", JSON.stringify({ name: "acme-cli", version: "0.0.0" }, null, 2));
  r.write("chant.config.ts", `export default { release: { publish: [{ type: "npm", packages: ["."] }] } };\n`);
  r.commit("init");
  return r;
}

/** A clock that moves only when the wait sleeps, and records each sleep. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

type Answer = unknown | { status: number };
const isHttp = (a: Answer): a is { status: number } => typeof a === "object" && a !== null && "status" in a && Object.keys(a).length === 1;

/** A fetch that answers each path from the answers under the first route it contains, one per read, the last repeating. */
function sequencedFetch(routes: Record<string, Answer[]>): ForgeFetch & { reads: Record<string, number> } {
  const reads: Record<string, number> = {};
  const f = (async (url: string) => {
    const hit = Object.entries(routes).find(([p]) => url.includes(p));
    if (!hit) return { ok: false, status: 404, text: async () => "{}" };
    const n = reads[hit[0]] ?? 0;
    reads[hit[0]] = n + 1;
    const answer = hit[1][Math.min(n, hit[1].length - 1)];
    if (isHttp(answer)) return { ok: false, status: answer.status, text: async () => "{}" };
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
  }) as unknown as ForgeFetch & { reads: Record<string, number> };
  f.reads = reads;
  return f;
}

const target = (kind: ForgeTarget["kind"], apiBase: string): ForgeTarget => ({ kind, apiBase, repo: "acme/cli", host: "h", token: "t", tokenSource: "GH_TOKEN" });

function request(r: TestRepo, forgeChecks: CutRequest["forgeChecks"], extra: Partial<CutRequest> = {}): CutRequest {
  return { cwd: r.dir, compiler: noCompile, label: "1.0.0", actor: "alice", env: {}, now: () => new Date("2026-11-21T10:00:00.000Z"), publishes: [NPM], forgeChecks, ...extra };
}

const refusal = async (p: Promise<unknown>): Promise<ReleaseCutError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseCutError);
  return err as ReleaseCutError;
};

const ghRun = (name: string, status: string, conclusion: string | null, run: number) => ({ name, status, conclusion, details_url: `https://github.com/acme/cli/actions/runs/${run}/job/1` });

describe("release cut --wait-checks", () => {
  test("GitHub: waits while a sibling push workflow runs, looks past a 503, and cuts once it passed", async () => {
    const r = project();
    const c = clock();
    const notes: string[] = [];
    const f = sequencedFetch({
      "/check-runs": [
        { check_runs: [ghRun("test", "in_progress", null, 1), ghRun("deploy", "in_progress", null, 99)] },
        { status: 503 },
        { check_runs: [ghRun("test", "completed", "success", 1), ghRun("deploy", "in_progress", null, 99)] },
      ],
      "/status": [{ statuses: [] }],
    });
    const read = forgeChecksReader(target("github", "https://api.github.com"), { GITHUB_RUN_ID: "99" }, f);
    const result = await cutRelease(request(r, read, { waitForChecks: { sleep: c.sleep, now: c.now, onNote: (l) => notes.push(l) } }));
    expect(result.cut?.green).toEqual({ source: "forge-checks", forge: "github", checks: ["test"] });
    expect(c.sleeps).toEqual([CI_VERDICT_INTERVAL_MS, CI_VERDICT_BACKOFF_MS]);
    expect(notes[0]).toBe("waiting on github: test (in_progress)");
    expect(notes[1]).toMatch(/^the forge failed \(github answered 503 to GET .*\); looking again in 15s/);
  });

  test("Forgejo: waits for a pending status", async () => {
    const r = project();
    const c = clock();
    const f = sequencedFetch({ "/status": [{ statuses: [{ context: "ci / test", status: "pending" }] }, { statuses: [{ context: "ci / test", status: "success" }] }] });
    const read = forgeChecksReader(target("forgejo", "https://code.example/api/v1"), {}, f);
    const result = await cutRelease(request(r, read, { waitForChecks: { sleep: c.sleep, now: c.now } }));
    expect(result.cut?.green).toEqual({ source: "forge-checks", forge: "forgejo", checks: ["ci / test"] });
    expect(c.sleeps).toEqual([CI_VERDICT_INTERVAL_MS]);
  });

  test("GitLab: waits for the running push pipeline, the cut's own pipeline left out", async () => {
    const r = project();
    const c = clock();
    const own = { id: 7, status: "running", source: "push" };
    const f = sequencedFetch({
      "/pipelines?sha=": [
        [own, { id: 6, status: "running", source: "merge_request_event" }],
        [own, { id: 6, status: "success", source: "merge_request_event" }],
      ],
    });
    const read = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), { CI_PIPELINE_ID: "7" }, f);
    const result = await cutRelease(request(r, read, { waitForChecks: { sleep: c.sleep, now: c.now } }));
    expect(result.cut?.green).toEqual({ source: "forge-checks", forge: "gitlab", checks: ["pipeline (merge_request_event)"] });
  });

  test("a failed check refuses at once, with no wait", async () => {
    const r = project();
    const c = clock();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("test", "completed", "failure", 1), ghRun("lint", "in_progress", null, 2)] }], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", "https://api.github.com"), {}, f), { waitForChecks: { sleep: c.sleep, now: c.now } })));
    expect(err.code).toBe("release-commit-not-green");
    expect(err.message).toContain("a check did not pass on github: test (failure)");
    expect(c.sleeps).toEqual([]);
  });

  test("refuses once the time is up, naming the checks still running", async () => {
    const r = project();
    const c = clock();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("e2e", "queued", null, 1)] }], "/status": [{ statuses: [] }] });
    const read = forgeChecksReader(target("github", "https://api.github.com"), {}, f);
    const err = await refusal(cutRelease(request(r, read, { waitForChecks: { timeoutMs: 5 * 60_000, sleep: c.sleep, now: c.now } })));
    expect(err.code).toBe("release-commit-not-green");
    expect(err.message).toBe(`commit ${r.head().slice(0, 12)} is not green: no finished checks after 5 minutes: still waiting on e2e (queued), so no release is cut from it`);
    expect(err.fix).toContain("--timeout-minutes");
    expect(c.now()).toBe(5 * 60_000);
  });

  test(`waits ${RELEASE_CUT_WAIT_MINUTES} minutes when no timeout is given`, async () => {
    const r = project();
    const c = clock();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("e2e", "queued", null, 1)] }], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", "https://api.github.com"), {}, f), { waitForChecks: { sleep: c.sleep, now: c.now } })));
    expect(err.message).toContain(`no finished checks after ${RELEASE_CUT_WAIT_MINUTES} minutes`);
  });

  test("without it, a running check refuses on the first read", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("e2e", "queued", null, 1)] }], "/status": [{ statuses: [] }] });
    const err = await refusal(cutRelease(request(r, forgeChecksReader(target("github", "https://api.github.com"), {}, f))));
    expect(err.message).toContain("a check has not finished on github: e2e (queued)");
    expect(err.fix).toContain("--wait-checks");
    expect(f.reads["/check-runs"]).toBe(1);
  });
});

describe("a commit whose only checks are the cut's own run", () => {
  const ownOnly = (forge: string, n: number) =>
    `the only ${n === 1 ? "check" : `${n} checks`} ${forge} reports on it ${n === 1 ? "belongs" : "belong"} to the cut's own run, which the cut leaves out, and no other workflow reported a check on the commit`;

  test("GitHub: refused with a message that says so", async () => {
    const r = project();
    const f = sequencedFetch({ "/check-runs": [{ check_runs: [ghRun("plan", "completed", "success", 99), ghRun("apply", "in_progress", null, 99)] }], "/status": [{ statuses: [] }] });
    const read = forgeChecksReader(target("github", "https://api.github.com"), { GITHUB_RUN_ID: "99" }, f);
    const err = await refusal(cutRelease(request(r, read, { waitForChecks: { sleep: async () => {}, now: () => 0 } })));
    expect(err.code).toBe("release-commit-not-green");
    expect(err.message).toContain(ownOnly("github", 2));
    expect(err.fix).toContain('release.green in chant.config.ts to "chant"');
  });

  test("Forgejo and GitLab: the same", async () => {
    const fj = forgeChecksReader(
      target("forgejo", "https://code.example/api/v1"),
      { FORGEJO_RUN_NUMBER: "12" },
      sequencedFetch({ "/status": [{ statuses: [{ context: "pipeline / dev", status: "pending", target_url: "https://code.example/acme/cli/actions/runs/12/jobs/0" }] }] }),
    );
    expect(await fj("abc", null)).toMatchObject({ green: false, ownRunOnly: true, why: ownOnly("forgejo", 1) });
    const gl = forgeChecksReader(target("gitlab", "https://gitlab.example/api/v4"), { CI_PIPELINE_ID: "7" }, sequencedFetch({ "/pipelines?sha=": [[{ id: 7, status: "running", source: "push" }]] }));
    expect(await gl("abc", null)).toMatchObject({ green: false, ownRunOnly: true, why: ownOnly("gitlab", 1) });
  });

  test("no check at all keeps the general message", async () => {
    const gh = forgeChecksReader(target("github", "https://api.github.com"), {}, sequencedFetch({ "/check-runs": [{ check_runs: [] }], "/status": [{ statuses: [] }] }));
    const v = await gh("abc", null);
    expect(v).toMatchObject({ green: false, why: "github reports no check on it" });
    expect("ownRunOnly" in v).toBe(false);
  });
});

describe("the pipeline's release-cut hook", () => {
  test("passes --wait-checks, through the declared bin and label", () => {
    expect(releaseCutHook({})?.command).toEqual(["chant", "release", "cut", "auto", "--yes", "--wait-checks"]);
    expect(releaseCutHook({ release: { bin: ["npx", "--no-install", "plywood"], label: "next" } })?.command).toEqual(["npx", "--no-install", "plywood", "release", "cut", "next", "--yes", "--wait-checks"]);
    expect(releaseCutHook({ release: { cut: false } })).toBeUndefined();
  });
});
