/**
 * chant #3773: the gate-notice job's script, run.
 *
 * The generator emits a node script that posts through
 * `@intentius/chant/pr-forge`. These tests take that script out of the
 * generated workflow, run it with tsx against this checkout's chant, the way
 * the job runs it against the release it installs, and answer its calls from
 * a fake forge: GitHub's shapes at an `api.github.com`-style base, Forgejo's
 * at `/api/v1`.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Call {
  method: string;
  url: string;
  auth?: string;
  body?: Record<string, unknown>;
}

/** The node script inside the generated notice step's heredoc. */
function noticeScript(): string {
  const yaml = generateGithubOpPipeline([{ name: "app-apply", trigger: { kind: "push", branches: ["main"] } }]).files[0].yaml;
  const doc = parseYAML(yaml) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
  const shell = doc.jobs["app-apply-gate-notice"].steps[0].run ?? "";
  const m = /cat > notice\.mjs <<'NOTICE'\n([\s\S]*?)\nNOTICE\n/.exec(shell);
  if (!m) throw new Error("no notice.mjs heredoc in the notice step");
  return m[1];
}

const dirs: string[] = [];

/** A directory laid out like the job's: notice.mjs, and chant and tsx under node_modules. */
function jobDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-gate-notice-"));
  dirs.push(dir);
  mkdirSync(join(dir, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(join(REPO, "packages", "core"), join(dir, "node_modules", "@intentius", "chant"));
  symlinkSync(join(REPO, "node_modules", "tsx"), join(dir, "node_modules", "tsx"));
  writeFileSync(join(dir, "notice.mjs"), noticeScript());
  return dir;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => resolve(text ? (JSON.parse(text) as Record<string, unknown>) : undefined));
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake forge answering `routes` by `METHOD path`, query string dropped. */
async function fakeForge(routes: Record<string, (body?: Record<string, unknown>) => [number, unknown]>): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = (req.url ?? "").split("?")[0];
    calls.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, ...(body ? { body } : {}) });
    const route = routes[`${req.method} ${path}`];
    const [status, answer] = route ? route(body) : [404, { message: "not found" }];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

async function runNotice(env: Record<string, string>): Promise<string> {
  const { stdout } = await run(process.execPath, ["--import", "tsx", "notice.mjs"], {
    cwd: jobDir(),
    env: {
      PATH: process.env.PATH ?? "",
      TSX_DISABLE_CACHE: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "acme/infra",
      GITHUB_SHA: SHA,
      GITHUB_TOKEN: "job-token",
      CHANT_OP: "app-apply",
      CHANT_GATE: "apply",
      CHANT_APPROVE: "chant approve app-apply apply",
      ...env,
    },
  });
  return stdout.trim();
}

describe("the gate-notice script (#3773)", () => {
  test("on GitHub it comments on the pull request the commit merged", async () => {
    const { base, calls } = await fakeForge({
      [`GET /repos/acme/infra/commits/${SHA}/pulls`]: () => [200, [{ number: 7, merged_at: "2026-10-11T00:00:00Z", merge_commit_sha: SHA }]],
      "GET /repos/acme/infra/issues/7/comments": () => [200, []],
      "POST /repos/acme/infra/issues/7/comments": () => [201, { id: 11, html_url: "https://github.example/acme/infra/pull/7#c11" }],
    });
    const out = await runNotice({ GITHUB_API_URL: base, GITHUB_SERVER_URL: "https://github.com" });
    expect(out).toBe("https://github.example/acme/infra/pull/7#c11");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.auth).toBe("Bearer job-token");
    const body = String(post.body?.body);
    expect(body.startsWith("<!-- chant-gate:app-apply -->\n\nThe `app-apply` apply for " + SHA + " stopped at gate `apply`")).toBe(true);
    expect(body).toContain("```\nchant approve app-apply apply --approver <you>\n```");
    expect(body).toContain("`_gates/app-apply.jsonl` on the `chant/lifecycle` branch");
  });

  test("on GitHub it edits its own comment on a later gated push", async () => {
    const { base, calls } = await fakeForge({
      [`GET /repos/acme/infra/commits/${SHA}/pulls`]: () => [200, [{ number: 7, merged_at: "x", merge_commit_sha: SHA }]],
      "GET /repos/acme/infra/issues/7/comments": () => [200, [{ id: 5, body: "<!-- chant-gate:app-apply -->\n\nolder", html_url: "u5" }]],
      "PATCH /repos/acme/infra/issues/comments/5": () => [200, { id: 5, html_url: "u5" }],
    });
    expect(await runNotice({ GITHUB_API_URL: base })).toBe("u5");
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
  });

  test("on Forgejo a commit with no pull request gets a tracking issue", async () => {
    const { base, calls } = await fakeForge({
      "GET /api/v1/repos/acme/infra/issues": () => [200, []],
      "POST /api/v1/repos/acme/infra/issues": () => [201, { number: 3, html_url: "https://forgejo.example/acme/infra/issues/3" }],
    });
    const out = await runNotice({ FORGEJO_ACTIONS: "true", GITHUB_API_URL: `${base}/api/v1`, GITHUB_SERVER_URL: base });
    expect(out).toBe("https://forgejo.example/acme/infra/issues/3");
    // Forgejo's own lookup, answered 404 here: no pull request merged this commit.
    expect(calls[0]).toMatchObject({ method: "GET", url: `/api/v1/repos/acme/infra/commits/${SHA}/pull` });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.auth).toBe("token job-token");
    expect(post.body?.title).toBe("app-apply is waiting on gate apply");
    expect(String(post.body?.body).startsWith("<!-- chant-gate:app-apply -->")).toBe(true);
  });
});
