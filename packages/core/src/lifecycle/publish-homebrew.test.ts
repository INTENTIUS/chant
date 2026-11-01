/**
 * #4676: the Homebrew tap target against a GitHub repository fake. The stage
 * commits the rendered formula to a staging branch that brew does not read,
 * and the tap branch moves only at the reveal. Nothing reaches a network:
 * over SSH (#4699), git pushes to a bare repository through a fake ssh.
 */

import { afterAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { githubSshHost } from "./publish-git-ssh";
import { fillUrl, releaseVersion, renderFormula } from "./publish-homebrew";
import { createPublishTargets } from "./publish-targets";
import { PublishTargetError, type PublishContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeGitHubRepo } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function context(cwd: string, over: Partial<PublishContext> & { artifacts?: ReleaseArtifact[] } = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? { HOMEBREW_TAP_TOKEN: "ghp_taptokentap" };
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: "c0ffee".padEnd(40, "0"), artifactDigests: over.artifacts ?? [], targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "release/v1.4.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), ...over, lines };
}

async function refused(p: Promise<unknown>): Promise<PublishTargetError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PublishTargetError) return err;
    throw err;
  }
  throw new Error("expected a PublishTargetError");
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const API = "https://api.github.test";
const FILES = { "arugula-darwin-arm64.tar.gz": "mac arm", "arugula-darwin-amd64.tar.gz": "mac intel", "arugula-linux-arm64.tar.gz": "linux arm", "arugula-linux-amd64.tar.gz": "linux intel" };
const TEMPLATE = `class Arugula < Formula
  desc "Arugula daemon"
  homepage "https://arugula.example"
  version "{{version}}"

  on_macos do
    on_arm do
      url "{{url:arugula-darwin-arm64.tar.gz}}"
      sha256 "{{sha256:arugula-darwin-arm64.tar.gz}}"
    end
    on_intel do
      url "{{url:arugula-darwin-amd64.tar.gz}}"
      sha256 "{{sha256:arugula-darwin-amd64.tar.gz}}"
    end
  end

  on_linux do
    on_arm do
      url "{{url:arugula-linux-arm64.tar.gz}}"
      sha256 "{{sha256:arugula-linux-arm64.tar.gz}}"
    end
    on_intel do
      url "{{url:arugula-linux-amd64.tar.gz}}"
      sha256 "{{sha256:arugula-linux-amd64.tar.gz}}"
    end
  end

  def install
    bin.install "arugula"
  end
end
`;

function member(template = TEMPLATE): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-homebrew-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "packaging"));
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(dir, "dist", name), bytes);
  writeFileSync(join(dir, "packaging", "arugula.rb"), template);
  return dir;
}

const declaration = (over: Record<string, unknown> = {}) =>
  PublishDeclarationSchema.parse({
    type: "homebrew",
    tap: "arugula-salad/homebrew-tap",
    formula: "Formula/arugula.rb",
    template: "packaging/arugula.rb",
    assets: Object.keys(FILES).map((n) => `dist/${n}`),
    url: "https://github.com/arugula-salad/arugula/releases/download/{tag}/{name}",
    api: API,
    ...over,
  });

describe("homebrew tap (#4676)", () => {
  test("renders the formula per platform, commits it to a staging branch brew does not read, and fast-forwards the tap branch only at the reveal", async () => {
    const dir = member();
    const tap = startFakeGitHubRepo(API, "arugula-salad/homebrew-tap", "main", { "Formula/arugula.rb": "old formula\n", "README.md": "tap\n" });
    const [target] = await createPublishTargets([declaration()], { fetch: tap.fetch });
    const ctx = context(dir);
    const formula = TEMPLATE.replace("{{version}}", "1.4.0").replace(/\{\{(url|sha256):([^}]+)\}\}/g, (_, k: string, name: string) =>
      k === "url" ? `https://github.com/arugula-salad/arugula/releases/download/release/v1.4.0/${name}` : sha(FILES[name as keyof typeof FILES]),
    );
    const digest = `sha256:${sha(formula)}`;
    expect(await target!.plan(ctx)).toEqual([{ name: "Formula/arugula.rb", destination: "arugula-salad/homebrew-tap@the default branch:Formula/arugula.rb", digest }]);
    expect(tap.calls).toEqual([]);

    const main = tap.branches.get("main");
    const staged = await target!.stage(ctx);
    expect(staged.items).toEqual([{ name: "Formula/arugula.rb", destination: "arugula-salad/homebrew-tap@main:Formula/arugula.rb", digest }]);
    expect(staged.state).toMatchObject({ branch: "main", staging: "chant-publish/arugula-1.4.0" });
    expect(tap.branches.get("main")).toBe(main);
    expect(tap.read("main", "Formula/arugula.rb")).toBe("old formula\n");
    expect(tap.read("chant-publish/arugula-1.4.0", "Formula/arugula.rb")).toBe(formula);
    expect(tap.calls[0]!.headers).toMatchObject({ authorization: "Bearer ghp_taptokentap" });

    // A stage run again finds the staging branch holding the formula and commits nothing.
    const n = tap.calls.length;
    const again = await target!.stage(ctx);
    expect(again.state).toEqual(staged.state);
    expect(tap.calls.slice(n).map((c) => c.method)).toEqual(["GET", "GET", "GET", "GET", "GET"]);

    await target!.reveal(ctx, staged);
    expect(tap.read("main", "Formula/arugula.rb")).toBe(formula);
    expect(tap.read("main", "README.md")).toBe("tap\n");
    expect(tap.log("main")).toEqual(["init", "arugula 1.4.0"]);
    expect(tap.branches.has("chant-publish/arugula-1.4.0")).toBe(false);
    expect(ctx.lines.join("\n")).not.toContain("ghp_taptokentap");

    // Revealed: a stage finds the tap holding the formula and stages nothing.
    const done = await target!.stage(ctx);
    expect(done.state).toEqual({ branch: "main", present: "true" });
    expect(done.items[0]!.present).toBe(true);
    expect(await target!.reveal(ctx, done)).toMatchObject({ items: [{ present: true }] });
    expect(tap.log("main")).toEqual(["init", "arugula 1.4.0"]);
  });

  test("a tap branch that moved since the stage gets the formula as one commit on top", async () => {
    const dir = member();
    const tap = startFakeGitHubRepo(API, "arugula-salad/homebrew-tap", "main", { "Formula/arugula.rb": "old formula\n" });
    const [target] = await createPublishTargets([declaration({ branch: "main" })], { fetch: tap.fetch });
    const ctx = context(dir);
    const staged = await target!.stage(ctx);
    tap.push("main", { "Formula/other.rb": "other\n" });
    await target!.reveal(ctx, staged);
    expect(tap.log("main")).toEqual(["init", "someone else", "arugula 1.4.0"]);
    expect(tap.read("main", "Formula/other.rb")).toBe("other\n");
    expect(tap.read("main", "Formula/arugula.rb")).toContain('version "1.4.0"');
    expect(tap.branches.has("chant-publish/arugula-1.4.0")).toBe(false);
  });

  test("refuses an asset that is not the release's, a placeholder it can't fill, a release with no version, and a missing token, before any request", async () => {
    const tap = startFakeGitHubRepo(API, "arugula-salad/homebrew-tap", "main", {});
    const make = async (over: Record<string, unknown> = {}) => (await createPublishTargets([declaration(over)], { fetch: tap.fetch }))[0]!;
    const artifacts: ReleaseArtifact[] = [{ component: "daemon", kind: "asset", path: "dist/arugula-linux-amd64.tar.gz", digest: `sha256:${"0".repeat(64)}` }];
    expect((await refused((await make()).plan(context(member(), { artifacts })))).code).toBe("publish-artifact-digest-mismatch");
    expect((await refused((await make()).plan(context(member(TEMPLATE.replace("{{version}}", "{{revision}}")))))).code).toBe("publish-homebrew-template");
    expect((await refused((await make()).plan(context(member(`url "{{url:arugula-windows.zip}}"`))))).message).toContain("no declared asset is named arugula-windows.zip");
    expect((await refused((await make()).plan(context(member(), { label: null, releaseTag: null })))).code).toBe("publish-homebrew-no-version");
    expect((await refused((await make({ tokenEnv: "TAP_PAT" })).plan(context(member())))).code).toBe("publish-credentials-missing");
    expect(tap.calls).toEqual([]);
    expect(() => declaration({ tap: "no-slash" })).toThrow();
    expect(() => declaration({ token: "ghp_x" })).toThrow();
  });

  test("the version, URL and template helpers", () => {
    expect(releaseVersion("v1.4.0")).toBe("1.4.0");
    expect(releaseVersion("app-v2.0.0-rc.1")).toBe("2.0.0-rc.1");
    expect(releaseVersion("latest")).toBeNull();
    expect(fillUrl("https://x.test/{tag}/{name}?v={version}", { tag: "release/v1 0", label: "v1", version: "1", name: "a b.tgz" })).toBe("https://x.test/release/v1%200/a%20b.tgz?v=1");
    expect(renderFormula('version "{{ version }}" # #{bin}', { version: "1.0", label: "v1.0", tag: "t" }, new Map())).toBe('version "1.0" # #{bin}');
  });
});

describe("homebrew tap over SSH with a deploy key (#4699)", () => {
  const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAfakedeploykeymaterial\n-----END OPENSSH PRIVATE KEY-----\n";
  const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  /** A bare tap under `root`, as `git@github.com:<repo>.git` reaches it through the fake ssh, with one commit on main. */
  function bareTap(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "chant-tap-ssh-"));
    dirs.push(root);
    const bare = join(root, "arugula-salad", "homebrew-tap.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "-q", "--bare", "-b", "main"]);
    const work = join(root, "work");
    mkdirSync(work);
    git(work, ["init", "-q", "-b", "main"]);
    const commit = (message: string, more: Record<string, string>) => {
      for (const [p, text] of Object.entries(more)) {
        mkdirSync(join(work, p, ".."), { recursive: true });
        writeFileSync(join(work, p), text);
      }
      git(work, ["add", "-A"]);
      git(work, ["commit", "-q", "-m", message]);
      git(work, ["push", "-q", bare, "HEAD:refs/heads/main"]);
    };
    commit("init", files);
    return {
      root,
      bare,
      push: (more: Record<string, string>) => commit("someone else", more),
      log: (branch: string) => git(bare, ["log", "--format=%s", branch]).split("\n").reverse(),
      read: (branch: string, path: string) => git(bare, ["show", `${branch}:${path}`]) + "\n",
      head: (branch: string) => git(bare, ["rev-parse", branch]),
      branches: () => git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean),
    };
  }

  /**
   * An ssh that serves the bare taps under `root` when it is handed `KEY`
   * and a known-hosts file holding `HOST_KEY` for the host, and logs each
   * call's host and options.
   */
  function fakeSsh(root: string) {
    const bin = join(root, "ssh");
    const log = join(root, "ssh.log");
    writeFileSync(
      bin,
      `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
const opts = [];
let key = "";
for (let i = 0; i < args.length - 2; i++) {
  if (args[i] === "-o") opts.push(args[++i]);
  else if (args[i] === "-i") key = fs.readFileSync(args[++i], "utf-8");
  else if (args[i] === "-F") i++;
}
const host = args[args.length - 2].replace(/^git@/, "");
const known = opts.find((o) => o.startsWith("UserKnownHostsFile="));
const hosts = known ? fs.readFileSync(known.slice("UserKnownHostsFile=".length), "utf-8") : "";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ host, opts, mode: (fs.statSync(args[args.indexOf("-i") + 1]).mode & 0o777).toString(8) }) + "\\n");
if (!opts.includes("StrictHostKeyChecking=yes") || !hosts.split("\\n").includes(host + " " + ${JSON.stringify(HOST_KEY)})) { console.error("Host key verification failed."); process.exit(255); }
if (key !== ${JSON.stringify(KEY)}) { console.error("git@" + host + ": Permission denied (publickey)."); process.exit(255); }
const cmd = args[args.length - 1].replace(/'([^']+\\.git)'/, (_, p) => "'" + ${JSON.stringify(root)} + "/" + p + "'");
const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`,
    );
    chmodSync(bin, 0o755);
    const calls = () => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { host: string; opts: string[]; mode: string }) : []);
    return { bin, calls };
  }

  /** The API's /meta, which lists the host keys; nothing else is asked of it. */
  function fakeMeta(keys: string[] = [HOST_KEY]) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      const body = url === `${API}/meta` ? JSON.stringify({ ssh_keys: keys }) : "";
      return { ok: body !== "", status: body ? 200 : 404, headers: { get: () => null }, text: async () => body };
    };
    return { fetch, calls };
  }

  const sshCtx = (dir: string, env: NodeJS.ProcessEnv = { HOMEBREW_TAP_KEY: KEY, PATH: process.env.PATH }) => context(dir, { env });

  test("stages the formula on a branch over SSH, and fast-forwards the tap branch at the reveal, with no token", async () => {
    const dir = member();
    const tap = bareTap({ "Formula/arugula.rb": "old formula\n", "README.md": "tap\n" });
    const ssh = fakeSsh(tap.root);
    const meta = fakeMeta();
    const [target] = await createPublishTargets([declaration({ sshKeyEnv: "HOMEBREW_TAP_KEY" })], { fetch: meta.fetch, ssh: ssh.bin });
    expect(target!.credentialEnv).toEqual(["HOMEBREW_TAP_KEY"]);
    const ctx = sshCtx(dir);
    await target!.plan(ctx);
    expect(ssh.calls()).toEqual([]);

    const main = tap.head("main");
    const staged = await target!.stage(ctx);
    expect(staged.state).toMatchObject({ branch: "main", staging: "chant-publish/arugula-1.4.0" });
    expect(staged.state.commit).toBe(tap.head("chant-publish/arugula-1.4.0"));
    expect(tap.head("main")).toBe(main);
    expect(tap.read("main", "Formula/arugula.rb")).toBe("old formula\n");
    expect(tap.read("chant-publish/arugula-1.4.0", "Formula/arugula.rb")).toContain('version "1.4.0"');
    expect(new Set(ssh.calls().map((c) => c.host))).toEqual(new Set(["api.github.test"]));
    expect(ssh.calls()[0]!.opts).toEqual(expect.arrayContaining(["IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "BatchMode=yes"]));
    expect(ssh.calls()[0]!.mode).toBe("600");
    // The API is asked for the host keys only, without a token.
    expect(meta.calls.map((c) => c.url)).toEqual([`${API}/meta`]);
    expect(meta.calls[0]!.headers.authorization).toBeUndefined();

    // A stage run again finds the staging branch holding the formula and pushes nothing.
    const again = await target!.stage(ctx);
    expect(again.state).toEqual(staged.state);
    expect(tap.log("chant-publish/arugula-1.4.0")).toEqual(["init", "arugula 1.4.0"]);

    // The reveal is a fast-forward to the staged commit, from a session of its own, as on a fresh clone.
    await target!.reveal(ctx, staged);
    expect(tap.head("main")).toBe(staged.state.commit);
    expect(tap.log("main")).toEqual(["init", "arugula 1.4.0"]);
    expect(tap.read("main", "README.md")).toBe("tap\n");
    expect(tap.branches()).toEqual(["main"]);
    expect(ctx.lines.join("\n")).not.toContain("fakedeploykeymaterial");

    const done = await target!.stage(ctx);
    expect(done.state).toEqual({ branch: "main", present: "true" });
    expect(await target!.reveal(ctx, done)).toMatchObject({ items: [{ present: true }] });
    expect(tap.log("main")).toEqual(["init", "arugula 1.4.0"]);
  });

  test("a tap branch that moved since the stage gets the formula as one commit on top", async () => {
    const dir = member();
    const tap = bareTap({ "Formula/arugula.rb": "old formula\n" });
    const [target] = await createPublishTargets([declaration({ sshKeyEnv: "HOMEBREW_TAP_KEY", branch: "main" })], { fetch: fakeMeta().fetch, ssh: fakeSsh(tap.root).bin });
    const ctx = sshCtx(dir);
    const staged = await target!.stage(ctx);
    tap.push({ "Formula/other.rb": "other\n" });
    await target!.reveal(ctx, staged);
    expect(tap.log("main")).toEqual(["init", "someone else", "arugula 1.4.0"]);
    expect(tap.read("main", "Formula/other.rb")).toBe("other\n");
    expect(tap.read("main", "Formula/arugula.rb")).toContain('version "1.4.0"');
    expect(tap.branches()).toEqual(["main"]);
  });

  test("refuses a missing key, a key beside a token, a key the remote refuses, and a host whose key the API doesn't list", async () => {
    const dir = member();
    const tap = bareTap({ "Formula/arugula.rb": "old formula\n" });
    const ssh = fakeSsh(tap.root);
    const make = async (fetch = fakeMeta().fetch) => (await createPublishTargets([declaration({ sshKeyEnv: "HOMEBREW_TAP_KEY" })], { fetch, ssh: ssh.bin }))[0]!;

    const missing = await refused((await make()).plan(sshCtx(dir, { HOMEBREW_TAP_TOKEN: "ghp_not_read" })));
    expect(missing.code).toBe("publish-credentials-missing");
    expect(missing.message).toContain("SSH key from HOMEBREW_TAP_KEY");

    expect((await refused(createPublishTargets([declaration({ sshKeyEnv: "HOMEBREW_TAP_KEY", tokenEnv: "HOMEBREW_TAP_TOKEN" })]))).code).toBe("publish-homebrew-auth-invalid");

    const wrongKey = await refused((await make()).stage(sshCtx(dir, { HOMEBREW_TAP_KEY: KEY.replace("fake", "other"), PATH: process.env.PATH })));
    expect(wrongKey.code).toBe("publish-homebrew-failed");
    expect(wrongKey.message).toContain("Permission denied (publickey)");
    expect(wrongKey.message).not.toContain("otherdeploykeymaterial");

    const otherHost = await refused((await make(fakeMeta(["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsomeoneelse"]).fetch)).stage(sshCtx(dir)));
    expect(otherHost.message).toContain("Host key verification failed");

    const noMeta = await refused((await make(fakeMeta([]).fetch)).stage(sshCtx(dir)));
    expect(noMeta.message).toContain("gave no SSH host keys");
    expect(tap.branches()).toEqual(["main"]);
  });

  test("the SSH host is github.com for api.github.com and the API's own host for GitHub Enterprise Server", () => {
    expect(githubSshHost("https://api.github.com")).toBe("github.com");
    expect(githubSshHost("https://ghe.acme.test/api/v3")).toBe("ghe.acme.test");
  });
});
