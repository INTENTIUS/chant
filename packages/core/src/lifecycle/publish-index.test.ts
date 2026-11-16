/**
 * #5158: the index-repository target, against a GitHub fake with forks and
 * pull requests, and over SSH against a local bare repository. No request
 * reaches a network, and no real pull request is opened.
 */

import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "./publish-credentials";
import { PublishDeclarationSchema } from "./publish-declaration";
import { fillIndexPath, indexSettings, setTomlTableVersion } from "./publish-index";
import { createPublishTargets } from "./publish-targets";
import { releaseDoctor } from "./release-doctor";
import { PublishTargetError, runPublish, type PublishContext, type PublishItem, type PublishTarget, type StatusContext } from "./release-publish";
import { makeRelease, type ReleaseArtifact } from "./release-store";
import { startFakeGitHub } from "./__fixtures__/publish-fakes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const API = "https://api.github.test";
const COMMIT = "c0ffee".padEnd(40, "0");
const SHA_LINUX = "a".repeat(64);
const SHA_MAC = "b".repeat(64);
const SHA_WIN = "c".repeat(64);
/** What the release records. The files are never in the member: the target reads the record, not the files. */
const RECORDED: ReleaseArtifact[] = [
  { component: "behold", kind: "asset", path: "dist/behold_linux_amd64.tar.gz", digest: `sha256:${SHA_LINUX}` },
  { component: "behold", kind: "asset", path: "dist/behold_darwin_arm64.tar.gz", digest: `sha256:${SHA_MAC}` },
  { component: "behold-windows", kind: "asset", path: "dist/behold_windows_amd64.zip", digest: `sha256:${SHA_WIN}` },
];

function context(cwd: string, over: Partial<PublishContext> = {}): PublishContext & { lines: string[] } {
  const env = over.env ?? { INDEX_TOKEN: "ghp_indextokenindex" };
  const redactor = createRedactor(env);
  const lines: string[] = [];
  const release = makeRelease({ member: null, commit: COMMIT, artifactDigests: RECORDED, targets: [{ env: "dev", params: [], templates: [] }] });
  return { release, label: "v1.4.0", releaseTag: "v1.4.0", provenance: { oidc: false, ci: null, reason: "" }, cwd, tag: null, env, redactor, log: (l) => lines.push(redactor.redact(l)), ...over, lines };
}

function member(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-publish-index-"));
  dirs.push(dir);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
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

const URL_PATTERN = "https://github.com/acme/behold/releases/download/{tag}/{name}";
const KREW = `apiVersion: krew.googlecontainertools.github.com/v1alpha2
kind: Plugin
metadata:
  name: {{name}}
spec:
  version: v{{version}}
  platforms:
  - uri: {{url:behold_linux_amd64.tar.gz}}
    sha256: {{sha256:behold_linux_amd64.tar.gz}}
  - uri: {{url:behold_darwin_arm64.tar.gz}}
    sha256: {{sha256:behold_darwin_arm64.tar.gz}}
`;

const decl = (over: Record<string, unknown>) => PublishDeclarationSchema.parse({ type: "index", api: API, ...over });

describe("index target settings (#5158)", () => {
  test("presets fill in the repository, mode, path and title, and a declaration overrides them", () => {
    const krew = indexSettings(decl({ preset: "krew", name: "behold", template: "packaging/krew.yaml" }) as never);
    expect(krew).toMatchObject({ repo: "kubernetes-sigs/krew-index", mode: "pull-request", files: [{ path: "plugins/{name}.yaml", template: "packaging/krew.yaml" }], title: "Update {name} to {version}", tokenEnv: "INDEX_TOKEN", revealsLast: true, refusalWarns: true });
    const tap = indexSettings(decl({ preset: "homebrew-tap", repo: "acme/homebrew-tap", name: "behold", template: "f.rb", onRefusal: "fail" }) as never);
    expect(tap).toMatchObject({ mode: "commit", files: [{ path: "Formula/{name}.rb" }], tokenEnv: "HOMEBREW_TAP_TOKEN", refusalWarns: false });
    expect(indexSettings(decl({ preset: "homebrew-core", name: "behold", template: "f.rb", mode: "commit", repo: "acme/core" }) as never)).toMatchObject({ repo: "acme/core", mode: "commit" });
    expect(fillIndexPath("Formula/{letter}/{name}.rb", { name: "Behold", version: "1.4.0", label: "v1.4.0" }, "x")).toBe("Formula/b/Behold.rb");
    expect(fillIndexPath("manifests/{letter}/{namePath}/{version}/{name}.yaml", { name: "Acme.Behold", version: "1.4.0", label: "v1.4.0" }, "x")).toBe("manifests/a/Acme/Behold/1.4.0/Acme.Behold.yaml");
  });

  test("refuses what can't publish: no repository, winget without files, a template for zed, SSH for a pull request, a path outside the repository", async () => {
    const code = (d: Record<string, unknown>) => {
      try {
        indexSettings(decl(d) as never);
      } catch (err) {
        return (err as PublishTargetError).code;
      }
      return "ok";
    };
    expect(code({ preset: "scoop", name: "behold", template: "s.json" })).toBe("publish-index-invalid");
    expect(code({ preset: "winget", name: "Acme.Behold", template: "w.yaml" })).toBe("publish-index-invalid");
    expect(code({ preset: "zed", name: "behold", template: "z.toml" })).toBe("publish-index-invalid");
    expect(code({ preset: "krew", name: "behold", template: "k.yaml", sshKeyEnv: "KEY" })).toBe("publish-index-invalid");
    expect(code({ preset: "scoop", repo: "acme/bucket", name: "behold", template: "s.json", fork: "me/bucket" })).toBe("publish-index-invalid");
    expect(code({ preset: "zed", name: "behold" })).toBe("ok");
    expect(() => decl({ preset: "krew", name: "behold", template: "k.yaml", assets: ["artifact:behold"] })).toThrow(/url/);
    expect(() => fillIndexPath("../{name}.yaml", { name: "b", version: "1", label: "v1" }, "publish-index-path")).toThrow(/not a path inside/);
    expect(() => fillIndexPath("{nope}.yaml", { name: "b", version: "1", label: "v1" }, "publish-index-path")).toThrow(/\{nope\}/);
  });

  test("sets version in one TOML table and leaves the rest of the file as it was", () => {
    const toml = `[alpha]\nsubmodule = "extensions/alpha"\nversion = "0.1.0"\n\n[behold]\nsubmodule = "extensions/behold"\npath = "editors/zed"\nversion = "1.3.0"\n\n[zeta]\nversion = "2.0.0"\n`;
    expect(setTomlTableVersion(toml, "behold", "1.4.0")).toBe(toml.replace('version = "1.3.0"', 'version = "1.4.0"'));
    expect(setTomlTableVersion(toml, "nope", "1.4.0")).toBeNull();
  });
});

describe("index target, pull request from a fork (#5158)", () => {
  const setup = (forkDelay = 0) => {
    const gh = startFakeGitHub(API, { user: "behold-bot", forkDelay });
    gh.repo("kubernetes-sigs/krew-index", "master", { "plugins/behold.yaml": "old\n", "plugins/other.yaml": "other\n" });
    const dir = member({ "packaging/krew.yaml": KREW });
    const d = decl({ preset: "krew", name: "behold", template: "packaging/krew.yaml", assets: ["artifact:behold"], url: URL_PATTERN });
    return { gh, dir, d };
  };
  const rendered = KREW.replace("{{name}}", "behold")
    .replace("{{version}}", "1.4.0")
    .replace("{{url:behold_linux_amd64.tar.gz}}", "https://github.com/acme/behold/releases/download/v1.4.0/behold_linux_amd64.tar.gz")
    .replace("{{sha256:behold_linux_amd64.tar.gz}}", SHA_LINUX)
    .replace("{{url:behold_darwin_arm64.tar.gz}}", "https://github.com/acme/behold/releases/download/v1.4.0/behold_darwin_arm64.tar.gz")
    .replace("{{sha256:behold_darwin_arm64.tar.gz}}", SHA_MAC);

  test("stages the manifest on a branch of a fork it makes, opens the pull request at the reveal, and a resume finds it rather than opening another", async () => {
    const { gh, dir, d } = setup(2);
    const sleeps: number[] = [];
    const [target] = await createPublishTargets([d], { fetch: gh.fetch, sleep: async (ms) => void sleeps.push(ms) });
    expect(target!.revealsLast).toBe(true);
    expect(target!.refusalWarns).toBe(true);
    const ctx = context(dir);
    const plan = await target!.plan(ctx);
    expect(plan.map((i) => i.name)).toEqual(["plugins/behold.yaml"]);
    expect(gh.calls).toEqual([]);

    const staged = await target!.stage(ctx);
    expect(staged.state).toMatchObject({ branch: "master", staging: "chant-publish/behold-1.4.0", fork: "behold-bot/krew-index" });
    expect(sleeps.length).toBe(2);
    // The SHA-256s are the release's record of each file: none of them is in the member.
    expect(gh.read("behold-bot/krew-index", "chant-publish/behold-1.4.0", "plugins/behold.yaml")).toBe(rendered);
    const commit = gh.commit(staged.state.commit!)!;
    expect(commit).toEqual({ message: "Update behold to 1.4.0", parent: gh.head("kubernetes-sigs/krew-index", "master") });
    expect(gh.read("kubernetes-sigs/krew-index", "master", "plugins/behold.yaml")).toBe("old\n");
    expect(gh.pulls).toEqual([]);

    const published = await target!.reveal(ctx, staged);
    expect(gh.pulls).toMatchObject([{ repo: "kubernetes-sigs/krew-index", head: "behold-bot:chant-publish/behold-1.4.0", base: "master", title: "Update behold to 1.4.0", body: "Updates behold to 1.4.0, released as v1.4.0.", state: "open" }]);
    expect(published.items).toEqual([expect.objectContaining({ name: "plugins/behold.yaml", destination: "https://github.test/kubernetes-sigs/krew-index/pull/1" })]);

    // A resume (the record line was lost) stages and reveals again: the branch holds the manifest, the pull request is found.
    const again = await target!.reveal(ctx, await target!.stage(ctx));
    expect(gh.pulls.length).toBe(1);
    expect(again.items[0]).toMatchObject({ present: true, destination: "https://github.test/kubernetes-sigs/krew-index/pull/1" });
    expect(gh.calls.every((c) => c.headers.authorization === "Bearer ghp_indextokenindex")).toBe(true);
  });

  test("a merged pull request is published; one the index closed is a refusal; an index that already holds the manifest gets nothing", async () => {
    const { gh, dir, d } = setup();
    const [target] = await createPublishTargets([d], { fetch: gh.fetch });
    const ctx = context(dir);
    const staged = await target!.stage(ctx);
    await target!.reveal(ctx, staged);
    gh.pulls[0]!.state = "closed";
    expect((await refused(target!.reveal(ctx, staged))).code).toBe("publish-index-pr-closed");
    gh.pulls[0]!.merged = true;
    expect((await target!.reveal(ctx, staged)).items[0]!.present).toBe(true);

    const bot = startFakeGitHub(API, { user: "behold-bot" });
    bot.repo("kubernetes-sigs/krew-index", "master", { "plugins/behold.yaml": rendered });
    const [same] = await createPublishTargets([d], { fetch: bot.fetch });
    const s = await same!.stage(ctx);
    expect(s.state.present).toBe("true");
    expect((await same!.reveal(ctx, s)).items[0]!.present).toBe(true);
    expect(bot.repos()).toEqual(["kubernetes-sigs/krew-index"]);
    expect(bot.pulls).toEqual([]);
  });

  test("winget: three manifests in one commit, under the package's version directory", async () => {
    const gh = startFakeGitHub(API, { user: "behold-bot" });
    gh.repo("microsoft/winget-pkgs", "master", { "README.md": "winget\n" });
    const dir = member({
      "packaging/winget/version.yaml": "PackageIdentifier: {{name}}\nPackageVersion: {{version}}\nManifestType: version\n",
      "packaging/winget/installer.yaml": "PackageIdentifier: {{name}}\nInstallers:\n- InstallerUrl: {{url:behold_windows_amd64.zip}}\n  InstallerSha256: {{sha256:behold_windows_amd64.zip}}\n",
      "packaging/winget/locale.yaml": "PackageIdentifier: {{name}}\nPackageLocale: en-US\n",
    });
    const dir2 = "manifests/{letter}/{namePath}/{version}";
    const d = decl({
      preset: "winget",
      name: "Acme.Behold",
      files: { [`${dir2}/{name}.yaml`]: "packaging/winget/version.yaml", [`${dir2}/{name}.installer.yaml`]: "packaging/winget/installer.yaml", [`${dir2}/{name}.locale.en-US.yaml`]: "packaging/winget/locale.yaml" },
      assets: ["artifact:behold-windows"],
      url: URL_PATTERN,
    });
    const [target] = await createPublishTargets([d], { fetch: gh.fetch });
    const ctx = context(dir);
    const staged = await target!.stage(ctx);
    const base = "manifests/a/Acme/Behold/1.4.0";
    expect(gh.read("behold-bot/winget-pkgs", staged.state.staging!, `${base}/Acme.Behold.installer.yaml`)).toContain(`InstallerSha256: ${SHA_WIN}`);
    expect(gh.read("behold-bot/winget-pkgs", staged.state.staging!, `${base}/Acme.Behold.yaml`)).toContain("PackageVersion: 1.4.0");
    expect(gh.commit(staged.state.commit!)!.parent).toBe(gh.head("microsoft/winget-pkgs", "master"));
    await target!.reveal(ctx, staged);
    expect(gh.pulls[0]!.title).toBe("New version: Acme.Behold version 1.4.0");
  });

  test("zed: the version in extensions.toml and the submodule at the release's commit; an extension not listed is refused", async () => {
    const gh = startFakeGitHub(API, { user: "behold-bot" });
    const toml = `[behold]\nsubmodule = "extensions/behold"\nversion = "1.3.0"\n\n[other]\nsubmodule = "extensions/other"\nversion = "0.1.0"\n`;
    gh.repo("zed-industries/extensions", "main", { "extensions.toml": toml, "extensions/behold": { gitlink: "1".repeat(40) }, "extensions/other": { gitlink: "2".repeat(40) } });
    const [target] = await createPublishTargets([decl({ preset: "zed", name: "behold" })], { fetch: gh.fetch });
    const ctx = context(member({}));
    const staged = await target!.stage(ctx);
    expect(gh.read("behold-bot/extensions", staged.state.staging!, "extensions.toml")).toBe(toml.replace('version = "1.3.0"', 'version = "1.4.0"'));
    expect(gh.gitlink("behold-bot/extensions", staged.state.staging!, "extensions/behold")).toBe(COMMIT);
    expect(gh.gitlink("behold-bot/extensions", staged.state.staging!, "extensions/other")).toBe("2".repeat(40));
    await target!.reveal(ctx, staged);
    expect(gh.pulls[0]).toMatchObject({ title: "Update behold to 1.4.0", base: "main" });

    const [missing] = await createPublishTargets([decl({ preset: "zed", name: "nope" })], { fetch: gh.fetch });
    expect((await refused(missing!.stage(ctx))).code).toBe("publish-index-not-listed");
  });

  test("refuses an asset the release does not record, a missing token and a prerelease is skipped, before any request", async () => {
    const { gh, dir } = setup();
    const [unrecorded] = await createPublishTargets([decl({ preset: "krew", name: "behold", template: "packaging/krew.yaml", assets: ["dist/behold_linux_amd64.tar.gz", "dist/other.tar.gz"], url: URL_PATTERN })], { fetch: gh.fetch });
    expect((await refused(unrecorded!.plan(context(dir)))).code).toBe("publish-index-asset-not-recorded");
    const [target] = await createPublishTargets([decl({ preset: "krew", name: "behold", template: "packaging/krew.yaml", assets: ["artifact:behold"], url: URL_PATTERN })], { fetch: gh.fetch });
    const none = await refused(target!.plan(context(dir, { env: {} })));
    expect(none.code).toBe("publish-credentials-missing");
    expect(none.fix).toMatch(/public_repo/);
    const rc = context(dir, { label: "v1.5.0-rc.1", releaseTag: "v1.5.0-rc.1" });
    expect((await target!.plan(rc))[0]!.notes).toMatch(/prerelease/);
    expect((await target!.stage(rc)).items).toEqual([]);
    expect(gh.calls).toEqual([]);
  });
});

describe("index target, commit to a repository the publisher controls (#5158)", () => {
  test("Scoop bucket over the API: a staging branch, then a fast-forward", async () => {
    const gh = startFakeGitHub(API, { user: "acme" });
    gh.repo("acme/scoop-bucket", "main", { "bucket/behold.json": "{}\n" });
    const dir = member({ "packaging/scoop.json": `{"version":"{{version}}","url":"{{url:behold_windows_amd64.zip}}","hash":"{{sha256:behold_windows_amd64.zip}}"}\n` });
    const [target] = await createPublishTargets([decl({ preset: "scoop", repo: "acme/scoop-bucket", name: "behold", template: "packaging/scoop.json", assets: ["artifact:behold-windows"], url: URL_PATTERN })], { fetch: gh.fetch });
    const ctx = context(dir);
    const staged = await target!.stage(ctx);
    expect(gh.read("acme/scoop-bucket", "main", "bucket/behold.json")).toBe("{}\n");
    expect(gh.read("acme/scoop-bucket", "chant-publish/behold-1.4.0", "bucket/behold.json")).toContain(`"hash":"${SHA_WIN}"`);
    await target!.reveal(ctx, staged);
    expect(gh.read("acme/scoop-bucket", "main", "bucket/behold.json")).toContain('"version":"1.4.0"');
    expect(gh.head("acme/scoop-bucket", "chant-publish/behold-1.4.0")).toBeUndefined();
    expect(gh.commit(gh.head("acme/scoop-bucket", "main")!)!.message).toBe("behold: Update to version 1.4.0");
    expect(gh.repos()).toEqual(["acme/scoop-bucket"]);
  });

  test("Artifact Hub over SSH with a deploy key, against a local bare repository", async () => {
    const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nfakeindexdeploykey\n-----END OPENSSH PRIVATE KEY-----\n";
    const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const root = mkdtempSync(join(tmpdir(), "chant-index-ssh-"));
    dirs.push(root);
    const bare = join(root, "acme", "artifacthub.git");
    mkdirSync(bare, { recursive: true });
    git(bare, ["init", "-q", "--bare", "-b", "main"]);
    const work = join(root, "work");
    mkdirSync(work);
    git(work, ["init", "-q", "-b", "main"]);
    writeFileSync(join(work, "artifacthub-repo.yml"), "repositoryID: x\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-q", "-m", "init"]);
    git(work, ["push", "-q", bare, "HEAD:refs/heads/main"]);
    // An ssh that runs git's remote command against the bare repository, for this key only.
    const ssh = join(root, "ssh");
    writeFileSync(
      ssh,
      `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const args = process.argv.slice(2);
const key = fs.readFileSync(args[args.indexOf("-i") + 1], "utf-8");
if (key !== ${JSON.stringify(KEY)}) { console.error("Permission denied (publickey)."); process.exit(255); }
const cmd = args[args.length - 1].replace(/'([^']+\\.git)'/, (_, p) => "'" + ${JSON.stringify(root)} + "/" + p + "'");
const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`,
    );
    chmodSync(ssh, 0o755);
    const meta = async (url: string) => ({ ok: true, status: url === `${API}/meta` ? 200 : 404, headers: { get: () => null }, text: async () => JSON.stringify({ ssh_keys: [HOST_KEY] }) });
    const dir = member({ "packaging/artifacthub-pkg.yml": "version: {{version}}\nname: {{name}}\ndigest: {{commit}}\n" });
    const [target] = await createPublishTargets([decl({ preset: "artifacthub", repo: "acme/artifacthub", name: "behold", template: "packaging/artifacthub-pkg.yml", sshKeyEnv: "INDEX_KEY" })], { fetch: meta, ssh });
    const ctx = context(dir, { env: { INDEX_KEY: KEY, PATH: process.env.PATH } });
    const staged = await target!.stage(ctx);
    expect(git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").sort()).toEqual(["chant-publish/behold-1.4.0", "main"]);
    await target!.reveal(ctx, staged);
    expect(git(bare, ["show", "main:behold/1.4.0/artifacthub-pkg.yml"])).toBe(`version: 1.4.0\nname: behold\ndigest: ${COMMIT}`);
    expect(git(bare, ["log", "--format=%s", "main"]).split("\n")).toEqual(["behold 1.4.0", "init"]);
    expect(git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).toBe("main");

    // #5163: a yank of 1.5.0 over SSH removes its manifest; a restore puts it back from the history.
    const items14 = (await target!.reveal(ctx, staged)).items;
    const v15 = context(dir, { env: ctx.env, label: "v1.5.0", releaseTag: "v1.5.0" });
    const items15 = (await target!.reveal(v15, await target!.stage(v15))).items;
    expect(git(bare, ["show", "main:behold/1.5.0/artifacthub-pkg.yml"])).toContain("version: 1.5.0");
    const base = { reason: null, replacement: null, forgeYank: "prerelease" as const, apply: true, head: { releaseDigest: "sha256:v14", label: "v1.4.0", releaseTag: "v1.4.0", items: items14 } };
    await target!.setStatus!({ ...v15, ...base, status: "yanked", revealed: items15 });
    expect(git(bare, ["ls-tree", "-r", "--name-only", "main"]).split("\n")).toEqual(["artifacthub-repo.yml", "behold/1.4.0/artifacthub-pkg.yml"]);
    await target!.setStatus!({ ...v15, ...base, status: "active", revealed: items15 });
    expect(git(bare, ["show", "main:behold/1.5.0/artifacthub-pkg.yml"])).toContain("version: 1.5.0");
  });
});

describe("an index target's yank and restore (#5163)", () => {
  /** A status change of the release `ctx` publishes, the head release `head` (its label and what it revealed). */
  const status = (ctx: PublishContext, revealed: PublishItem[], over: Partial<StatusContext>): StatusContext => ({
    ...ctx,
    status: "yanked",
    reason: null,
    replacement: null,
    revealed,
    head: null,
    forgeYank: "prerelease",
    apply: true,
    ...over,
  });
  const headOf = (label: string, items: PublishItem[]) => ({ releaseDigest: `sha256:${label}`, label, releaseTag: label, items });
  const publish = async (target: PublishTarget, ctx: PublishContext) => (await target.reveal(ctx, await target.stage(ctx))).items;

  test("Scoop over the API: a yank puts back the manifest the head release published, a restore puts this one's back, and a dry run sends nothing", async () => {
    const gh = startFakeGitHub(API, { user: "acme" });
    gh.repo("acme/scoop-bucket", "main", { "bucket/behold.json": "{}\n" });
    const dir = member({ "packaging/scoop.json": `{"version":"{{version}}"}\n` });
    const [target] = await createPublishTargets([decl({ preset: "scoop", repo: "acme/scoop-bucket", name: "behold", template: "packaging/scoop.json" })], { fetch: gh.fetch });
    const v14 = context(dir);
    const items14 = await publish(target!, v14);
    const v15 = context(dir, { label: "v1.5.0", releaseTag: "v1.5.0" });
    const items15 = await publish(target!, v15);
    expect(gh.read("acme/scoop-bucket", "main", "bucket/behold.json")).toBe(`{"version":"1.5.0"}\n`);

    const dry = await target!.setStatus!(status(v15, items15, { head: headOf("v1.4.0", items14), apply: false }));
    expect(dry).toEqual([{ what: "revert acme/scoop-bucket:bucket/behold.json to the manifest v1.4.0 published, if it holds this release's" }]);
    expect(gh.read("acme/scoop-bucket", "main", "bucket/behold.json")).toBe(`{"version":"1.5.0"}\n`);

    await target!.setStatus!(status(v15, items15, { head: headOf("v1.4.0", items14) }));
    expect(gh.read("acme/scoop-bucket", "main", "bucket/behold.json")).toBe(`{"version":"1.4.0"}\n`);
    expect(gh.commit(gh.head("acme/scoop-bucket", "main")!)!.message).toBe("behold: Update to version 1.4.0");
    // Run again: the branch no longer holds this release's manifest, so nothing is sent.
    expect(await target!.setStatus!(status(v15, items15, { head: headOf("v1.4.0", items14) }))).toEqual([{ what: "acme/scoop-bucket:bucket/behold.json on main is not this release's manifest; not changed", already: true }]);

    await target!.setStatus!(status(v15, items15, { status: "active", head: { ...headOf("v1.5.0", items15), releaseDigest: v15.release.releaseDigest } }));
    expect(gh.read("acme/scoop-bucket", "main", "bucket/behold.json")).toBe(`{"version":"1.5.0"}\n`);
    // Deprecate changes nothing; a yank with no earlier active release is refused.
    expect((await target!.setStatus!(status(v15, items15, { status: "deprecated" })))[0]!.refused).toBeUndefined();
    expect((await target!.setStatus!(status(v15, items15, {})))[0]!.refused!.code).toBe("release-status-no-previous");
  });

  test("Artifact Hub over the API: a yank removes this version's manifest, which the head release did not publish, and a restore puts it back", async () => {
    const gh = startFakeGitHub(API, { user: "acme" });
    gh.repo("acme/artifacthub", "main", { "artifacthub-repo.yml": "repositoryID: x\n" });
    const dir = member({ "packaging/artifacthub-pkg.yml": "version: {{version}}\n" });
    const [target] = await createPublishTargets([decl({ preset: "artifacthub", repo: "acme/artifacthub", name: "behold", template: "packaging/artifacthub-pkg.yml" })], { fetch: gh.fetch });
    const items14 = await publish(target!, context(dir));
    const v15 = context(dir, { label: "v1.5.0", releaseTag: "v1.5.0" });
    const items15 = await publish(target!, v15);
    expect(gh.read("acme/artifacthub", "main", "behold/1.5.0/artifacthub-pkg.yml")).toBe("version: 1.5.0\n");

    const actions = await target!.setStatus!(status(v15, items15, { head: headOf("v1.4.0", items14) }));
    expect(actions).toEqual([{ what: "remove acme/artifacthub:behold/1.5.0/artifacthub-pkg.yml, which v1.4.0 did not publish, if it holds this release's" }]);
    expect(gh.read("acme/artifacthub", "main", "behold/1.5.0/artifacthub-pkg.yml")).toBeUndefined();
    expect(gh.read("acme/artifacthub", "main", "behold/1.4.0/artifacthub-pkg.yml")).toBe("version: 1.4.0\n");

    // Restored while v1.4.0 is still the head: v1.5.0's path is its own, so it goes back.
    await target!.setStatus!(status(v15, items15, { status: "active", head: headOf("v1.4.0", items14) }));
    expect(gh.read("acme/artifacthub", "main", "behold/1.5.0/artifacthub-pkg.yml")).toBe("version: 1.5.0\n");
  });

  test("a pull-request preset refuses a yank and a restore, and a deprecate changes nothing", async () => {
    const gh = startFakeGitHub(API, { user: "behold-bot" });
    const [target] = await createPublishTargets([decl({ preset: "krew", name: "behold", template: "packaging/krew.yaml", assets: ["artifact:behold"], url: URL_PATTERN })], { fetch: gh.fetch });
    const ctx = context(member({}));
    const items = [{ name: "plugins/behold.yaml", destination: "https://github.test/kubernetes-sigs/krew-index/pull/1", digest: "sha256:x" }];
    for (const s of ["yanked", "active"] as const) {
      const [a] = await target!.setStatus!(status(ctx, items, { status: s, head: headOf("v1.3.0", items) }));
      expect(a!.refused!.code).toBe("release-status-index-pull-request");
    }
    expect((await target!.setStatus!(status(ctx, items, { status: "deprecated" })))[0]).toEqual({ what: "kubernetes-sigs/krew-index:plugins/behold.yaml unchanged: an index has no deprecation; yank reverts it" });
    expect(gh.calls).toEqual([]);
  });
});

describe("an index target reveals after every other target (#5158)", () => {
  const toy = (name: string, log: string[], over: Partial<PublishTarget> = {}): PublishTarget => ({
    kind: "forge",
    name,
    destination: name,
    credentialEnv: [],
    key: `toy:${name}`,
    plan: async () => [],
    stage: async () => (log.push(`stage ${name}`), { target: name, destination: name, items: [{ name, destination: name }], state: {} }),
    reveal: async () => (log.push(`reveal ${name}`), { target: name, destination: name, items: [{ name, destination: name }] }),
    ...over,
  });

  test("declared first, it stages with the rest and reveals last, after the uploads; beside an mcp-registry target, the two reveal in the order declared", async () => {
    const dir = member({});
    const log: string[] = [];
    const index = toy("index", log, { revealsLast: true, refusalWarns: true });
    const mcp = toy("mcp", log, { revealsLast: true });
    const pypi = toy("pypi", log, { uploadsAtReveal: true });
    const run = await runPublish({ cwd: dir, release: context(dir).release, label: "v1.4.0", targets: [index, pypi, toy("forge", log), mcp, toy("npm", log)], ctx: context(dir), record: false });
    expect(log).toEqual(["stage index", "stage pypi", "stage forge", "stage mcp", "stage npm", "reveal forge", "reveal npm", "reveal pypi", "reveal index", "reveal mcp"]);
    expect(run.published.map((p) => p.target)).toEqual(["forge", "npm", "pypi", "index", "mcp"]);
  });

  test("a refusal is a warning and the publish goes on, unless it fails on refusal", async () => {
    const dir = member({});
    const refuse = async (): Promise<never> => {
      throw new PublishTargetError("publish-index-failed", "opening a pull request answered 403");
    };
    const no = toy("index", [], { revealsLast: true, refusalWarns: true, reveal: refuse });
    const warned = await runPublish({ cwd: dir, release: context(dir).release, label: "v1.4.0", targets: [toy("forge", []), no], ctx: context(dir), record: false });
    expect(warned.published[1]).toMatchObject({ target: "index", warning: "opening a pull request answered 403", items: [{ refused: true }] });

    const log: string[] = [];
    const noStage = toy("index", log, { revealsLast: true, refusalWarns: true, stage: refuse });
    const skipped = await runPublish({ cwd: dir, release: context(dir).release, label: "v1.4.0", targets: [noStage, toy("forge", log)], ctx: context(dir), record: false });
    expect(log).toEqual(["stage forge", "reveal forge"]);
    expect(skipped.published.map((p) => [p.target, p.warning ?? null])).toEqual([
      ["forge", null],
      ["index", "opening a pull request answered 403"],
    ]);

    const failing = { ...no, refusalWarns: false };
    await expect(runPublish({ cwd: dir, release: context(dir).release, label: "v1.4.0", targets: [failing, toy("forge", [])], ctx: context(dir), record: false })).rejects.toMatchObject({ code: "publish-index-failed", step: "reveal", revealed: ["forge"] });
    const failingStage = { ...noStage, refusalWarns: false };
    await expect(runPublish({ cwd: dir, release: context(dir).release, label: "v1.4.0", targets: [toy("forge", []), failingStage], ctx: context(dir), record: false })).rejects.toMatchObject({ code: "publish-index-failed", step: "stage", revealed: [] });
  });
});

describe("release doctor on an index target (#5158)", () => {
  const doctor = async (d: Record<string, unknown>, env: NodeJS.ProcessEnv, fetch: ReturnType<typeof startFakeGitHub>["fetch"]) =>
    (await releaseDoctor({ cwd: member({}), publish: [decl(d) as never], env, releaseWorkflow: null, deps: { fetch } })).targets[0]!;

  test("a classic token with public_repo may fork, push and open the pull request", async () => {
    const gh = startFakeGitHub(API, { user: "behold-bot", scopes: "public_repo, workflow" });
    gh.repo("kubernetes-sigs/krew-index", "master", {});
    const t = await doctor({ preset: "krew", name: "behold", template: "k.yaml" }, { INDEX_TOKEN: "ghp_x", CI: "true", GITHUB_ACTIONS: "true" }, gh.fetch);
    expect(t.checks.map((c) => [c.check, c.status])).toEqual([
      ["index-upstream", "ok"],
      ["index-fork", "ok"],
      ["index-pull-request", "ok"],
    ]);
  });

  test("a token without the scope fails; a fine-grained token can't be read; a commit target needs write access", async () => {
    const gh = startFakeGitHub(API, { user: "behold-bot", scopes: "read:org" });
    gh.repo("kubernetes-sigs/krew-index", "master", {});
    const narrow = await doctor({ preset: "krew", name: "behold", template: "k.yaml" }, { INDEX_TOKEN: "ghp_x" }, gh.fetch);
    expect(narrow.checks.map((c) => [c.check, c.status])).toEqual([
      ["index-upstream", "ok"],
      ["index-fork", "fail"],
      ["index-pull-request", "fail"],
    ]);
    const fine = startFakeGitHub(API, { user: "behold-bot", scopes: null });
    fine.repo("kubernetes-sigs/krew-index", "master", {});
    fine.repo("behold-bot/krew-index", "master", {});
    const t = await doctor({ preset: "krew", name: "behold", template: "k.yaml" }, { INDEX_TOKEN: "github_pat_x" }, fine.fetch);
    expect(t.checks.map((c) => [c.check, c.status])).toEqual([
      ["index-upstream", "ok"],
      ["index-fork", "warn"],
      ["index-pull-request", "unknown"],
    ]);
    const own = startFakeGitHub(API, { user: "acme", scopes: null });
    own.repo("acme/scoop-bucket", "main", {});
    const c = await doctor({ preset: "scoop", repo: "acme/scoop-bucket", name: "behold", template: "s.json" }, { INDEX_TOKEN: "ghp_x" }, own.fetch);
    expect(c.checks).toEqual([expect.objectContaining({ check: "index-access", status: "ok" })]);
    const missing = await doctor({ preset: "scoop", repo: "acme/scoop-bucket", name: "behold", template: "s.json" }, { CI: "true" }, own.fetch);
    expect(missing.checks).toEqual([expect.objectContaining({ check: "index-credentials", status: "fail" })]);
  });
});
