/**
 * #4169 end to end: `chant ci tick` and `chant ci run --at`, as a process,
 * against a bare git remote and a local server that answers GitHub's check
 * run, re-run and workflow dispatch calls the way Actions would for a
 * `suites` phase declared `build: "newest"`.
 *
 * Seven commits go to main at once: a green base, five commits the suites
 * never ran on (GitHub dropped their waiting runs), and the newest, whose
 * suites run fails. The fourth of the five broke the suites. The tick runs
 * each failed job again once, then bisects: it halves the five, steps back
 * from the red, and names the culprit, leaving the two commits below the
 * green middle one unbuilt.
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, git, REPO, scratchDir, writeFiles } from "./__fixtures__/contract-repo";

afterAll(cleanScratch);

const GREEN = {
  branch: "main",
  phases: { check: { runs: ["check"], build: "every" }, suites: { runs: ["suites"], build: "newest" } },
  require: ["check", "suites"],
};
const SUITES_WORKFLOW = "name: release-suites\non:\n  push:\n    branches: [main]\n  workflow_dispatch: {}\njobs:\n  suites:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";

interface Run {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

/** The fake GitHub: runs per commit, and what dispatching the suites at a commit concludes. */
class FakeGithub {
  runs = new Map<string, Run[]>();
  dispatched: string[] = [];
  reruns: number[] = [];
  private id = 1;
  server!: Server;
  constructor(
    readonly origin: string,
    readonly suitesPass: (sha: string) => boolean,
  ) {}

  add(sha: string, name: string, conclusion: string): void {
    this.runs.set(sha, [...(this.runs.get(sha) ?? []), { id: this.id++, name, status: "completed", conclusion }]);
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await new Promise<string>((done) => {
      let text = "";
      req.on("data", (c) => (text += c));
      req.on("end", () => done(text));
    });
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, json?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    let m = /^\/repos\/acme\/app\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const runs = this.runs.get(m[1]) ?? [];
      return send(200, { total_count: runs.length, check_runs: runs.map((r) => ({ ...r, completed_at: null, html_url: null })) });
    }
    m = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)\/rerun$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const id = Number(m[1]);
      this.reruns.push(id);
      // The job runs again and fails the same way.
      for (const [sha, runs] of this.runs) {
        const r = runs.find((x) => x.id === id);
        if (r) this.add(sha, r.name, r.conclusion ?? "failure");
      }
      return send(201, {});
    }
    m = /^\/repos\/acme\/app\/actions\/workflows\/([^/]+)\/dispatches$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const ref = (JSON.parse(body) as { ref: string }).ref;
      const sha = git(this.origin, "rev-parse", `refs/tags/${ref}^{commit}`);
      this.dispatched.push(sha);
      this.add(sha, "suites", this.suitesPass(sha) ? "success" : "failure");
      return send(204);
    }
    send(404, { message: "not found" });
  }
}

function chant(cwd: string, api: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href, join(REPO, "packages/core/src/cli/main.ts"), ...args], {
      cwd,
      env: { ...process.env, GITHUB_API_URL: api, GITHUB_REPOSITORY: "acme/app", GITHUB_TOKEN: "t", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code: code ?? 1, out, err }));
  });
}

describe("a newest phase, bisected end to end (#4169)", () => {
  let root: string;
  let origin: string;
  let forge: FakeGithub;
  let api: string;
  const shas: Record<string, string> = {};

  beforeAll(async () => {
    origin = scratchDir("chant-builds-e2e-origin-");
    git(origin, "init", "-q", "--bare");
    root = scratchDir("chant-builds-e2e-work-");
    git(root, "init", "-q");
    git(root, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "config", "user.name", "t");
    git(root, "config", "user.email", "t@example.com");
    git(root, "remote", "add", "origin", origin);
    writeFiles(root, {
      "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: GREEN } }),
      ".github/workflows/release-suites.yml": SUITES_WORKFLOW,
    });
    for (const name of ["base", "u1", "u2", "u3", "u4", "u5", "top"]) {
      writeFiles(root, { [`app/${name}.txt`]: `${name}\n` });
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", name);
      shas[name] = git(root, "rev-parse", "HEAD");
    }
    git(root, "push", "-q", "origin", "main");
    const order = ["base", "u1", "u2", "u3", "u4", "u5", "top"].map((n) => shas[n]);
    // u4 broke the suites: they pass below it.
    forge = new FakeGithub(origin, (sha) => order.indexOf(sha) < order.indexOf(shas.u4));
    for (const sha of order) forge.add(sha, "check", "success");
    forge.add(shas.base, "suites", "success");
    forge.add(shas.top, "suites", "failure");
    api = await forge.listen();
  });

  afterAll(() => forge?.server.close());

  const tags = () => git(origin, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/tags/").split("\n").filter(Boolean).sort();
  const record = (name: string) => JSON.parse(git(origin, "show", `refs/heads/chant/lifecycle:_ci/${shas[name]}.json`));
  const tick = async () => {
    const r = await chant(root, api, "ci", "tick");
    expect(r.code, r.err).toBe(0);
    return r.out;
  };

  test("retries once, bisects to the culprit, and leaves the commits below the green one unbuilt", async () => {
    // The failed suites run again once, and fail again.
    expect(await tick()).toContain(`ran suites at ${shas.top.slice(0, 12)} again`);
    expect(forge.reruns).toHaveLength(1);
    expect(record("top")).toMatchObject({ state: "pending", phases: { suites: { reason: "retrying" } } });

    // Red now: five unbuilt below it, so the middle one, u3.
    await tick();
    expect(forge.dispatched).toEqual([shas.u3]);
    // u3 passes and goes green; then the step back from the red, u5, then u4,
    // each red run of them run again once before the next step.
    await tick();
    expect(tags()).toContain(`ci/green/${shas.u3}`);
    expect(forge.dispatched).toEqual([shas.u3, shas.u5]);
    expect(await tick()).toContain(`ran suites at ${shas.u5.slice(0, 12)} again`);
    await tick();
    expect(forge.dispatched).toEqual([shas.u3, shas.u5, shas.u4]);
    expect(await tick()).toContain(`ran suites at ${shas.u4.slice(0, 12)} again`);
    await tick();
    expect(forge.dispatched).toHaveLength(3);
    expect(forge.reruns).toHaveLength(3);

    for (const name of ["u4", "u5", "top"]) expect(record(name), name).toMatchObject({ state: "red", phases: { suites: { culprit: shas.u4 } } });
    for (const name of ["u1", "u2"]) expect(record(name), name).toMatchObject({ state: "unbuilt", phases: { suites: { verdict: "unbuilt", reason: "superseded" } } });
    expect(record("u3")).toMatchObject({ state: "green" });
    expect(tags().filter((t) => t.startsWith("ci/build/"))).toEqual([]);
    expect(tags()).toEqual([`ci/green/${shas.base}`, `ci/green/${shas.u3}`].sort());

    const last = await chant(root, api, "ci", "last-green", "--json");
    const doc = JSON.parse(last.out);
    expect(doc.commit.sha).toBe(shas.u3);
    expect(doc.newer.map((n: { sha: string; record: { state: string; culprit?: string } }) => [n.sha, n.record.state, n.record.culprit])).toEqual([
      [shas.top, "red", shas.u4],
      [shas.u5, "red", shas.u4],
      [shas.u4, "red", shas.u4],
    ]);
  }, 180_000);

  test("ci run --at asks for a chosen commit and starts the suites there", async () => {
    const r = await chant(root, api, "ci", "run", "--at", shas.u1);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`Asked for check, suites at ${shas.u1.slice(0, 12)}: ci/build/${shas.u1}. Started release-suites.yml.`);
    expect(tags()).toContain(`ci/build/${shas.u1}`);
    await tick();
    expect(tags()).toContain(`ci/green/${shas.u1}`);
    expect(tags()).not.toContain(`ci/build/${shas.u1}`);
  }, 60_000);
});
