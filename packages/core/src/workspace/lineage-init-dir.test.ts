/**
 * chant #2647: `chant init --from <dir>[#<member>]`, a template directory on
 * disk. The same files and parameters as the git form for the same tree, a
 * lock whose address is the digest alone, and `chant workspace upgrade`
 * from a directory, which rebuilds its merge base only while the recorded
 * directory still holds what the scope was made from.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initFromCommand, parseDirSpec, recordedDirPath } from "./lineage-init";
import { LOCK_FILE, readLock } from "./lineage-lock";
import { describeSource, lineageView } from "./lineage-cli";
import { stageUpgrade, type ChantRunner } from "./lineage-upgrade";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let root: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function put(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}
function read(base: string, rel: string): string {
  return readFileSync(join(base, rel), "utf-8");
}
/** Every file under `dir` except the lock, with its content and executable bit. */
function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, tree(dir, rel));
    else if (rel !== LOCK_FILE) out[rel] = `${statSync(join(dir, rel)).mode & 0o100 ? "x " : ""}${readFileSync(join(dir, rel), "utf-8")}`;
  }
  return out;
}

/** A template directory with a manifest, an executable, a seed and a lock of its own. */
function writeTemplate(dir: string, version = "1"): void {
  put(dir, "svc/README.md", `template v${version}\n`);
  put(dir, "svc/src/main.ts", 'export const name = "{{chant:name}}";\n');
  put(dir, "svc/run.sh", "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(dir, "svc/run.sh")]);
  put(dir, "svc/.mcp.json", "{}\n");
  put(dir, `svc/${LOCK_FILE}`, JSON.stringify({ lockVersion: 1, scopes: {} }));
  put(
    dir,
    "svc/chant.template.json",
    JSON.stringify({ parameters: { name: { type: "string", default: "app" }, owner: { type: "string", default: "ops" } }, files: ["src/main.ts"] }),
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-init-dir-test-")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("parseDirSpec", () => {
  test("an existing directory is the directory form, with or without #<member>", () => {
    mkdirSync(join(root, "tpl", "svc"), { recursive: true });
    expect(parseDirSpec("tpl#svc", root)).toEqual({ kind: "dir", path: "tpl", abs: join(root, "tpl"), member: "svc" });
    expect(parseDirSpec(join(root, "tpl"), root)).toEqual({ kind: "dir", path: join(root, "tpl"), abs: join(root, "tpl") });
  });
  test("a directory whose name parses as <repo>@<ref> is still a directory", () => {
    mkdirSync(join(root, "starter@v1"));
    expect(parseDirSpec("starter@v1", root)).toMatchObject({ kind: "dir", abs: join(root, "starter@v1") });
  });
  test("<repo>@<ref> with no such directory is the git form", () => {
    expect(parseDirSpec("acme/starter@v1.2.0#service", root)).toBeNull();
  });
  test("a path with no @ that is not a directory is refused", () => {
    expect(() => parseDirSpec("missing", root)).toThrow(/no directory missing, and not <repo>@<ref>/);
    put(root, "file", "x");
    expect(() => parseDirSpec("file", root)).toThrow(/file is not a directory/);
    mkdirSync(join(root, "tpl"));
    expect(() => parseDirSpec("tpl#../x", root)).toThrow(/not a directory in the directory/);
  });
  test("a relative directory is recorded from the project, an absolute one as given", () => {
    expect(recordedDirPath("../tpl", join(root, "tpl"), join(root, "proj"))).toBe("../tpl");
    expect(recordedDirPath("tpl", join(root, "tpl"), root)).toBe("./tpl");
    expect(recordedDirPath(join(root, "tpl"), join(root, "tpl"), join(root, "proj"))).toBe(join(root, "tpl"));
  });
});

describe("chant init --from <dir>", () => {
  test("copies the same files, with the same parameters and digest, as the git form of the same tree", async () => {
    const tpl = join(root, "tpl");
    writeTemplate(tpl);
    git(tpl, ["init", "-q", "-b", "main"]);
    git(tpl, ["add", "-A"]);
    git(tpl, ["commit", "-q", "-m", "v1"]);

    const fromGit = await initFromCommand({ from: `${tpl}@main#svc`, path: join(root, "a"), params: { name: "billing" } });
    const fromDir = await initFromCommand({ from: `${tpl}#svc`, path: join(root, "b"), params: { name: "billing" } });
    expect(fromGit.error).toBeUndefined();
    expect(fromDir.error).toBeUndefined();
    expect(fromDir.createdFiles).toEqual(fromGit.createdFiles);
    expect(tree(join(root, "b"))).toEqual(tree(join(root, "a")));
    expect(read(join(root, "b"), "src/main.ts")).toBe('export const name = "billing";\n');
    expect(statSync(join(root, "b", "run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(root, "b", "chant.template.json"))).toBe(false);

    const a = readLock(join(root, "a"))!.scopes["."];
    const b = readLock(join(root, "b"))!.scopes["."];
    expect(b.parameters).toEqual({ name: "billing", owner: "ops" });
    expect(b.parameters).toEqual(a.parameters);
    expect(b.files).toEqual(a.files);
    expect(b.address).toEqual({ digest: a.address!.digest });
    // The lock shape: the digest alone, a dir source, no ref.
    expect(b.source).toEqual({ type: "dir", path: tpl, member: "svc" });
    expect(b.template).toBe(`dir:${tpl}#svc`);
    expect(b.ref).toBeUndefined();
    expect(fromDir.template).toBe(`dir:${tpl}#svc`);
    expect(fromDir.commit).toBeUndefined();
    expect(a.source).toMatchObject({ type: "git", path: "svc" });
  });

  test("inside a git checkout, .gitignore is respected and untracked files are copied", async () => {
    const tpl = join(root, "tpl");
    git(root, ["init", "-q", "-b", "main"]);
    put(tpl, "keep.ts", "keep\n");
    put(tpl, ".gitignore", "out/\n*.log\n");
    put(tpl, "out/built.js", "built\n");
    put(tpl, "debug.log", "noise\n");
    git(root, ["add", "tpl/keep.ts", "tpl/.gitignore"]);
    git(root, ["commit", "-q", "-m", "t"]);
    put(tpl, "untracked.ts", "new\n");

    const result = await initFromCommand({ from: tpl, path: join(root, "proj") });
    expect(result.error).toBeUndefined();
    expect(result.createdFiles.sort()).toEqual([".gitignore", LOCK_FILE, "keep.ts", "untracked.ts"].sort());
  });

  test("outside git every file is copied, except node_modules, symbolic links and the template's own lock", async () => {
    const tpl = join(root, "tpl");
    writeTemplate(tpl);
    put(tpl, "svc/.gitignore", "*.log\n");
    put(tpl, "svc/debug.log", "copied: no git to read .gitignore\n");
    put(tpl, "svc/node_modules/dep/index.js", "x\n");
    symlinkSync("README.md", join(tpl, "svc", "link.md"));

    const result = await initFromCommand({ from: `${tpl}#svc`, path: join(root, "proj") });
    expect(result.error).toBeUndefined();
    expect(result.createdFiles.sort()).toEqual([".gitignore", ".mcp.json", LOCK_FILE, "README.md", "debug.log", "run.sh", "src/main.ts"].sort());
    expect(result.warnings).toEqual(["link.md is a symbolic link, not copied", "node_modules is node_modules, not copied"]);
    expect(readLock(join(root, "proj"))!.scopes["."].files).not.toHaveProperty(LOCK_FILE);
  });

  test("refuses a missing member, a missing directory and an undeclared --param, writing nothing", async () => {
    const tpl = join(root, "tpl");
    writeTemplate(tpl);
    const target = join(root, "proj");
    expect((await initFromCommand({ from: `${tpl}#nope`, path: target })).error).toBe(`${tpl} has no directory nope`);
    expect((await initFromCommand({ from: join(root, "missing"), path: target })).error).toMatch(/no directory .*missing, and not <repo>@<ref>/);
    expect((await initFromCommand({ from: `${tpl}#svc`, path: target, params: { title: "x" } })).error).toBe("unknown parameter title (declared: name, owner)");
    expect(existsSync(target)).toBe(false);
  });

  test("chant workspace lineage names the source kind and path", async () => {
    const tpl = join(root, "tpl");
    writeTemplate(tpl);
    await initFromCommand({ from: `${tpl}#svc`, path: join(root, "proj") });
    const view = lineageView(join(root, "proj"))!;
    expect(view.scopes[0].source).toEqual({ type: "dir", path: tpl, member: "svc" });
    expect(describeSource(view.scopes[0].source)).toBe(`dir ${tpl}#svc`);
    expect(describeSource({ type: "git", repo: "acme/starter", url: "https://github.com/acme/starter.git", path: "svc" })).toBe("git acme/starter#svc");
  });
});

describe("chant workspace upgrade on a directory scope", () => {
  const passing: ChantRunner = async () => ({ exitCode: 0, output: "" });
  let v1: string;
  let v2: string;
  let proj: string;

  beforeEach(async () => {
    v1 = join(root, "bundle-v1");
    v2 = join(root, "bundle-v2");
    proj = join(root, "proj");
    writeTemplate(v1);
    put(v1, "svc/src/lib.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    const made = await initFromCommand({ from: `${v1}#svc`, path: proj, params: { name: "billing" } });
    expect(made.error).toBeUndefined();
    git(proj, ["init", "-q", "-b", "main"]);
    put(proj, "src/lib.ts", "ONE (ours)\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    git(proj, ["add", "-A"]);
    git(proj, ["commit", "-q", "-m", "init and edit"]);

    cpSync(v1, v2, { recursive: true });
    put(v2, "svc/README.md", "template v2\n");
    put(v2, "svc/src/lib.ts", "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN (theirs)\n");
    put(v2, "svc/src/new.ts", "new\n");
  });

  test("without --to it refuses, naming adopt-lineage", async () => {
    await expect(stageUpgrade({ root: proj, runChant: passing })).rejects.toThrow(/no --to directory\. .*has no git history.*chant workspace adopt-lineage/);
  });

  test("with --to a directory, the recorded directory is the merge base while it holds the same digest", async () => {
    const staged = await stageUpgrade({ root: proj, to: v2, runChant: passing });
    try {
      expect(staged.merged).toEqual(["src/lib.ts"]);
      expect(staged.written.sort()).toEqual(["README.md", "src/new.ts"]);
      expect(staged.manualSteps).toEqual([]);
      expect(staged.from).toBe(`${v1}#svc`);
      expect(staged.to).toBe(`${v2}#svc`);
      expect(read(staged.worktreeProject, "src/lib.ts")).toBe("ONE (ours)\ntwo\nthree\nfour\nfive\nsix\nSEVEN (theirs)\n");
      // The parameter carried into the new version's files.
      expect(read(staged.worktreeProject, "src/main.ts")).toBe('export const name = "billing";\n');
      const lock = readLock(staged.worktreeProject)!.scopes["."];
      expect(lock.source).toEqual({ type: "dir", path: v2, member: "svc" });
      expect(Object.keys(lock.address!)).toEqual(["digest"]);
      expect(lock.ref).toBeUndefined();
      expect(lock.parameters).toEqual({ name: "billing", owner: "ops" });
    } finally {
      staged.dispose();
    }
  });

  test("refuses when the recorded directory changed or is gone, naming adopt-lineage", async () => {
    put(v1, "svc/README.md", "replaced in place\n");
    await expect(stageUpgrade({ root: proj, to: v2, runChant: passing })).rejects.toThrow(
      /no longer holds the files the scope was made from.*chant workspace adopt-lineage/,
    );
    rmSync(v1, { recursive: true, force: true });
    await expect(stageUpgrade({ root: proj, to: v2, runChant: passing })).rejects.toThrow(/is gone\. .*chant workspace adopt-lineage/);
  });

  test("--to must be a directory", async () => {
    await expect(stageUpgrade({ root: proj, to: "v2.0.0", runChant: passing })).rejects.toThrow(/--to v2\.0\.0: a scope made from a directory upgrades from a directory/);
  });
});
