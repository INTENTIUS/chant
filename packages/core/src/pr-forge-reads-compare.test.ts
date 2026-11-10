/**
 * The forge reads of a comparison, a job and a job's artifact file (#4862),
 * against a loopback fake of each forge: the calls each makes on GitHub,
 * Forgejo and GitLab, and what each reads back.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { forgejoReads, githubReads, gitlabReads } from "./pr-forge-reads";

const SHA = "a".repeat(40);

/** A route answers JSON, a status, or `{ raw }`, a body sent as it is. */
type Answer = unknown;
let routes: Record<string, Answer> = {};
let calls: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const found = routes[`${req.method} ${path}`];
    if (found === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"message":"404 Not Found"}');
      return;
    }
    if (typeof found === "number") {
      res.writeHead(found);
      res.end();
      return;
    }
    if (typeof found === "object" && found !== null && "raw" in found) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(String((found as { raw: string }).raw));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(found));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  routes = {};
  calls = [];
});

const urls = () => calls.map((c) => `${c.method} ${c.url}`);
const gh = () => githubReads({ apiBase: origin, repo: "acme/infra", token: "t0k" });
const fj = () => forgejoReads({ apiBase: `${origin}/api/v1`, repo: "acme/infra", token: "t0k" });
const gl = () => gitlabReads({ apiBase: `${origin}/api/v4`, project: "acme/infra", token: "glpat" });
const P = "/api/v4/projects/acme%2Finfra";

describe("compare", () => {
  test("github: the files a head changes since its merge base, a rename with its old path", async () => {
    routes[`GET /repos/acme/infra/compare/main...${SHA}`] = {
      behind_by: 1,
      files: [{ filename: "a.tf", status: "modified" }, { filename: ".github/workflows/ci.yml", previous_filename: "ci.yml", status: "renamed" }],
    };
    expect(await gh().compare("main", SHA)).toEqual({ files: [{ path: "a.tf" }, { path: ".github/workflows/ci.yml", previousPath: "ci.yml" }], truncated: false });
    expect(urls()).toEqual([`GET /repos/acme/infra/compare/main...${SHA}`]);
    expect(calls[0]!.headers.authorization).toBe("Bearer t0k");
  });

  test("github: a list of 300 files is the most GitHub lists, so it says it may be cut short", async () => {
    routes[`GET /repos/acme/infra/compare/release%2F1...${SHA}`] = { files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })) };
    const got = await gh().compare("release/1", SHA);
    expect(got.files).toHaveLength(300);
    expect(got.truncated).toBe(true);
  });

  test("forgejo: the files its commits change, once each, cut short when it lists fewer commits than it counts", async () => {
    routes[`GET /api/v1/repos/acme/infra/compare/main...${SHA}`] = {
      total_commits: 2,
      commits: [{ sha: SHA, files: [{ filename: "a.tf", status: "modified" }, { filename: ".forgejo/workflows/ci.yml", status: "added" }] }, { sha: "b".repeat(40), files: [{ filename: "a.tf", status: "modified" }] }],
    };
    expect(await fj().compare("main", SHA)).toEqual({ files: [{ path: "a.tf" }, { path: ".forgejo/workflows/ci.yml" }], truncated: false });
    expect(calls[0]!.headers.authorization).toBe("token t0k");
    routes[`GET /api/v1/repos/acme/infra/compare/main...${SHA}`] = { total_commits: 3, commits: [{ sha: SHA, files: [{ filename: "a.tf" }] }] };
    expect((await fj().compare("main", SHA)).truncated).toBe(true);
    routes[`GET /api/v1/repos/acme/infra/compare/main...${SHA}`] = { total_commits: 1, commits: [{ sha: SHA }] };
    expect((await fj().compare("main", SHA)).truncated).toBe(true);
  });

  test("gitlab: the diffs' paths from the merge base, cut short when the compare timed out", async () => {
    routes[`GET ${P}/repository/compare`] = { diffs: [{ old_path: "a.tf", new_path: "a.tf" }, { old_path: "ci.yml", new_path: ".gitlab-ci.yml", renamed_file: true }], compare_timeout: false };
    expect(await gl().compare("main", SHA)).toEqual({ files: [{ path: "a.tf" }, { path: ".gitlab-ci.yml", previousPath: "ci.yml" }], truncated: false });
    expect(urls()).toEqual([`GET ${P}/repository/compare?from=main&to=${SHA}&straight=false`]);
    expect(calls[0]!.headers["private-token"]).toBe("glpat");
    routes[`GET ${P}/repository/compare`] = { diffs: [], compare_timeout: true };
    expect((await gl().compare("main", SHA)).truncated).toBe(true);
  });
});

describe("a job by id, and the jobs' URLs", () => {
  test("github: a job with its run, branch and URL; undefined when missing", async () => {
    routes["GET /repos/acme/infra/actions/jobs/5"] = { id: 5, run_id: 10, name: "review", status: "completed", conclusion: "success", head_branch: "main", html_url: "https://github.com/acme/infra/actions/runs/10/job/5" };
    expect(await gh().job(5)).toEqual({ id: 5, name: "review", status: "completed", conclusion: "success", done: true, run: 10, ref: "main", url: "https://github.com/acme/infra/actions/runs/10/job/5" });
    expect(await gh().job(6)).toBeUndefined();
    expect(urls()).toEqual(["GET /repos/acme/infra/actions/jobs/5", "GET /repos/acme/infra/actions/jobs/6"]);
  });

  test("forgejo: a job by id", async () => {
    routes["GET /api/v1/repos/acme/infra/actions/jobs/5"] = { id: 5, run_id: 10, name: "review", status: "running", head_branch: "main", html_url: "https://code.acme.io/acme/infra/actions/runs/3/jobs/0" };
    expect(await fj().job(5)).toEqual({ id: 5, name: "review", status: "running", done: false, run: 10, ref: "main", url: "https://code.acme.io/acme/infra/actions/runs/3/jobs/0" });
  });

  test("gitlab: a job with its pipeline, ref, tag and URL; a pipeline's jobs with their URLs", async () => {
    routes[`GET ${P}/jobs/5`] = { id: 5, name: "review", status: "success", ref: "main", tag: false, web_url: "https://gitlab.com/acme/infra/-/jobs/5", pipeline: { id: 10, sha: SHA } };
    routes[`GET ${P}/jobs/6`] = { id: 6, name: "plan", status: "failed", ref: "v1", tag: true, pipeline: { id: 11 } };
    // #4926: the pipeline's commit is the job's.
    expect(await gl().job(5)).toEqual({ id: 5, name: "review", status: "success", done: true, run: 10, ref: "main", tag: false, url: "https://gitlab.com/acme/infra/-/jobs/5", headSha: SHA });
    expect(await gl().job(6)).toEqual({ id: 6, name: "plan", status: "failed", done: true, run: 11, ref: "v1", tag: true });
    expect(await gl().job(7)).toBeUndefined();
    routes[`GET ${P}/pipelines/10/jobs`] = [{ id: 4, name: "plan", status: "success", ref: "refs/merge-requests/3/head", tag: false, web_url: "https://gitlab.com/acme/infra/-/jobs/4", pipeline: { id: 10 } }];
    expect(await gl().runJobs(10)).toEqual([{ id: 4, name: "plan", status: "success", done: true, run: 10, ref: "refs/merge-requests/3/head", tag: false, url: "https://gitlab.com/acme/infra/-/jobs/4" }]);
  });
});

describe("a job's artifact file", () => {
  test("gitlab: one file of a job's artifacts as text, each path segment encoded; undefined when there is none", async () => {
    routes[`GET ${P}/jobs/5/artifacts/terragucci-report/plan%20note.md`] = { raw: "## plan\n\nno changes\n" };
    const reads = gl();
    expect(await reads.artifactFile!(5, "terragucci-report/plan note.md")).toBe("## plan\n\nno changes\n");
    expect(await reads.artifactFile!(5, "terragucci-report/status")).toBeUndefined();
    expect(urls()).toEqual([`GET ${P}/jobs/5/artifacts/terragucci-report/plan%20note.md`, `GET ${P}/jobs/5/artifacts/terragucci-report/status`]);
    expect(calls[0]!.headers["private-token"]).toBe("glpat");
  });

  test("gitlab: another error throws", async () => {
    routes[`GET ${P}/jobs/5/artifacts/r/x`] = 500;
    await expect(gl().artifactFile!(5, "r/x")).rejects.toThrow(/500/);
  });

  test("github and forgejo hand an artifact out as one archive, so they read no file of one", () => {
    expect(gh().artifactFile).toBeUndefined();
    expect(fj().artifactFile).toBeUndefined();
  });
});
