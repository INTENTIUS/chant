/**
 * Which commit's `chant` run the publish gate checks (#2817). A release tags a
 * bump commit, which has no run of its own, on top of a green commit; the gate
 * checks the parent then, and only then.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "publish-verify-ci.sh");
let dir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf-8" }).trim();
const put = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const pkg = (version: string, extra = "") =>
  `{\n  "name": "@intentius/chant-lexicon-aws",\n  "version": "${version}",${extra}\n  "peerDependencies": {\n    "@intentius/chant": "^${version}"\n  }\n}\n`;
const commit = (message: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};
const target = () =>
  execFileSync("bash", [script], { cwd: dir, encoding: "utf-8", env: { ...process.env, PUBLISH_VERIFY_TARGET_ONLY: "1" } })
    .trim()
    .split("\n")
    .at(-1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-publish-verify-"));
  git("init", "-q", "-b", "main");
  put("lexicons/aws/package.json", pkg("0.91.0"));
  put("package-lock.json", '{ "version": "0.91.0" }\n');
  put("src/a.ts", "export const a = 1;\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("publish-verify-ci.sh (#2817)", () => {
  it("a bump commit is checked through its parent", () => {
    const green = commit("feat: something");
    put("lexicons/aws/package.json", pkg("0.92.0"));
    put("package-lock.json", '{ "version": "0.92.0" }\n');
    commit("chant-v0.92.0");
    expect(target()).toBe(`target ${green}`);
  });

  it("a commit that changes source is checked itself", () => {
    commit("feat: something");
    put("src/a.ts", "export const a = 2;\n");
    const own = commit("fix: a");
    expect(target()).toBe(`target ${own}`);
  });

  it("a package.json change beyond the version fields is checked itself", () => {
    commit("feat: something");
    put("lexicons/aws/package.json", pkg("0.92.0", '\n  "scripts": { "prepack": "true" },'));
    const own = commit("chant-v0.92.0, and more");
    expect(target()).toBe(`target ${own}`);
    expect(readFileSync(join(dir, "lexicons/aws/package.json"), "utf-8")).toContain('"prepack"');
  });
});
