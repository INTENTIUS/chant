import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initFromCommand, parseTemplateSpec } from "./lineage-init";
import { LOCK_FILE, fileHash, readLock } from "./lineage-lock";
import { initCommand } from "../cli/commands/init";

let root: string;
let tpl: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}
function put(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-init-from-test-")));
  tpl = join(root, "tpl");
  mkdirSync(tpl);
  git(tpl, ["init", "-q", "-b", "main"]);
  put(tpl, "README.md", "template\n");
  put(tpl, "svc/src/main.ts", "export const a = 1;\n");
  put(tpl, "svc/run.sh", "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(tpl, "svc/run.sh")]);
  put(tpl, "svc/.mcp.json", "{}\n");
  put(tpl, `svc/${LOCK_FILE}`, JSON.stringify({ lockVersion: 1, scopes: {} }));
  git(tpl, ["add", "-A"]);
  git(tpl, ["commit", "-q", "-m", "v1"]);
  git(tpl, ["tag", "-a", "v1", "-m", "v1"]);
  put(tpl, "svc/src/main.ts", "export const a = 2;\n");
  git(tpl, ["commit", "-q", "-am", "v2"]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseTemplateSpec", () => {
  test("owner/name is a GitHub repository", () => {
    expect(parseTemplateSpec("acme/starter@v1.2.0#service", root)).toEqual({
      repo: "acme/starter",
      url: "https://github.com/acme/starter.git",
      ref: "v1.2.0",
      member: "service",
      id: "github.com/acme/starter#service",
    });
  });
  test("URLs and scp-style remotes keep their @ and :", () => {
    expect(parseTemplateSpec("https://git.example.com/acme/starter.git@main", root)).toMatchObject({
      url: "https://git.example.com/acme/starter.git",
      ref: "main",
      id: "git.example.com/acme/starter",
    });
    expect(parseTemplateSpec("git@github.com:acme/starter.git@v2", root)).toMatchObject({
      url: "git@github.com:acme/starter.git",
      ref: "v2",
      id: "github.com/acme/starter",
    });
    expect(parseTemplateSpec("gitlab.com/acme/starter@v3", root)).toMatchObject({ url: "https://gitlab.com/acme/starter.git", id: "gitlab.com/acme/starter" });
  });
  test("a local path is used as is", () => {
    expect(parseTemplateSpec("./tpl@main", root)).toMatchObject({ url: tpl, repo: "./tpl", id: "./tpl" });
  });
  test("a missing ref or an escaping member is refused", () => {
    expect(() => parseTemplateSpec("acme/starter", root)).toThrow(/<repo>@<ref>/);
    expect(() => parseTemplateSpec("git@github.com:acme/starter", root)).toThrow(/<repo>@<ref>/);
    expect(() => parseTemplateSpec("acme/starter@", root)).toThrow(/<repo>@<ref>/);
    expect(() => parseTemplateSpec("acme/starter@v1#../x", root)).toThrow(/not a directory/);
  });
});

describe("chant init --from", () => {
  test("copies one directory at a tag and records its lineage", async () => {
    const target = join(root, "proj");
    const result = await initFromCommand({ from: `${tpl}@v1#svc`, path: target });
    expect(result.error).toBeUndefined();
    expect(result.createdFiles).toEqual([".mcp.json", "run.sh", "src/main.ts", LOCK_FILE]);
    expect(readFileSync(join(target, "src/main.ts"), "utf-8")).toBe("export const a = 1;\n");
    expect(statSync(join(target, "run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(target, "README.md"))).toBe(false);

    const lock = readLock(target)!;
    const scope = lock.scopes["."];
    const commit = git(tpl, ["rev-parse", "v1^{commit}"]);
    expect(scope).toMatchObject({
      kind: "template",
      source: { type: "git", repo: tpl, url: "../tpl", path: "svc" },
      ref: "v1",
      parameters: {},
      migrations: [],
      manualSteps: [],
    });
    expect(scope.address).toMatchObject({ commit, tree: git(tpl, ["rev-parse", `${commit}:svc`]) });
    expect(scope.files["src/main.ts"]).toEqual({ class: "owned", sha256: fileHash("export const a = 1;\n") });
    expect(scope.files[".mcp.json"].class).toBe("seed");
    // The template's own lock described the template, not this project.
    expect(scope.files[LOCK_FILE]).toBeUndefined();
  });

  test("a branch resolves to its head commit, and the whole repository is the default", async () => {
    const target = join(root, "proj");
    const result = await initFromCommand({ from: `${tpl}@main`, path: target });
    expect(result.success).toBe(true);
    expect(readLock(target)!.scopes["."].address?.commit).toBe(git(tpl, ["rev-parse", "main"]));
    expect(readFileSync(join(target, "svc/src/main.ts"), "utf-8")).toBe("export const a = 2;\n");
  });

  test("refuses a non-empty directory, an unknown ref and a missing directory", async () => {
    const target = join(root, "proj");
    put(target, "keep.txt", "x");
    expect((await initFromCommand({ from: `${tpl}@v1`, path: target })).error).toMatch(/not empty/);
    expect((await initFromCommand({ from: `${tpl}@nope`, path: join(root, "p2") })).error).toMatch(/could not fetch/);
    expect((await initFromCommand({ from: `${tpl}@v1#nope`, path: join(root, "p3") })).error).toMatch(/no directory nope/);
    expect(existsSync(join(root, "p2"))).toBe(false);
  });

  test("--force keeps existing files and leaves them out of the lineage", async () => {
    const target = join(root, "proj");
    put(target, "src/main.ts", "mine\n");
    const result = await initFromCommand({ from: `${tpl}@v1#svc`, path: target, force: true });
    expect(result.warnings).toContain("src/main.ts already exists, skipping");
    expect(readFileSync(join(target, "src/main.ts"), "utf-8")).toBe("mine\n");
    expect(readLock(target)!.scopes["."].files["src/main.ts"]).toBeUndefined();
  });
});

describe("chant init --template", () => {
  test("writes the lock; plain init does not", async () => {
    const withTemplate = join(root, "a");
    const r = await initCommand({ path: withTemplate, lexicon: "github", template: "node-pipeline", skipInstall: true });
    expect(r.success).toBe(true);
    expect(r.createdFiles).toContain(LOCK_FILE);
    const scope = readLock(withTemplate)!.scopes["."];
    expect(scope).toMatchObject({
      kind: "template",
      template: "lexicon:github/node-pipeline",
      source: { type: "lexicon", lexicon: "github", template: "node-pipeline" },
      address: { package: "@intentius/chant-lexicon-github" },
    });
    expect(Object.keys(scope.files)).toContain("src/pipeline.ts");
    expect(Object.keys(scope.files).some((f) => f.startsWith(".chant/"))).toBe(false);
    expect(scope.files[".mcp.json"].class).toBe("seed");
    for (const f of r.createdFiles.filter((f) => !f.startsWith(".chant/"))) {
      expect(scope.files[f]?.sha256, f).toBe(fileHash(readFileSync(join(withTemplate, f))));
    }

    const plain = join(root, "b");
    const p = await initCommand({ path: plain, lexicon: "github", skipInstall: true });
    expect(p.success).toBe(true);
    expect(p.createdFiles).not.toContain(LOCK_FILE);
    expect(existsSync(join(plain, LOCK_FILE))).toBe(false);
  });
});
