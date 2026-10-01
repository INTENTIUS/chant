/**
 * Which commit's `chant` run the publish gate checks (#2817). A release tags a
 * bump commit, which has no run of its own, on top of a green commit; the gate
 * checks the parent then, and only then. And how it waits for that run when it
 * has not finished yet (#3027).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("a bump whose rewrite only re-escapes a string is still a bump (chant-v0.99.0)", () => {
    // jq writes "\u2014" back as the character itself. The JSON is the same.
    put("lexicons/aws/package.json", pkg("0.91.0", '\n  "description": "aws \\u2014 typed",'));
    const green = commit("feat: something");
    put("lexicons/aws/package.json", pkg("0.92.0", '\n  "description": "aws \u2014 typed",'));
    put("package-lock.json", '{ "version": "0.92.0" }\n');
    commit("chant-v0.92.0");
    expect(target()).toBe(`target ${green}`);
  });

  it("a description that really changed is not a bump", () => {
    put("lexicons/aws/package.json", pkg("0.91.0", '\n  "description": "aws",'));
    commit("feat: something");
    put("lexicons/aws/package.json", pkg("0.92.0", '\n  "description": "aws, renamed",'));
    const own = commit("chant-v0.92.0, and more");
    expect(target()).toBe(`target ${own}`);
  });
});

describe("publish-verify-ci.sh waits for the run (#3027)", () => {
  // A fake `gh` that answers each `gh api` call with the next canned line
  // set (the last one repeats), in the format the script's --jq produces.
  const gate = (answers: string[], env: Record<string, string> = {}) => {
    commit("feat: something");
    const bin = join(dir, ".fake-bin");
    mkdirSync(bin);
    answers.forEach((a, i) => writeFileSync(join(bin, `answer.${i + 1}`), a));
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash\nn=$(( $(cat "${bin}/count" 2>/dev/null || echo 0) + 1 ))\necho $n > "${bin}/count"\nf="${bin}/answer.$n"\n[ -f "$f" ] || f="${bin}/answer.${answers.length}"\ncat "$f"\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const out = join(dir, ".gh-output");
    const r = spawnSync("bash", [script], {
      cwd: dir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: "",
        PUBLISH_VERIFY_POLL_SECONDS: "0",
        ...env,
      },
    });
    let outcome = "";
    try {
      outcome = readFileSync(out, "utf-8").trim();
    } catch {}
    return { status: r.status, outcome, calls: Number(readFileSync(join(bin, "count"), "utf-8")) };
  };
  const run = (status: string, conclusion = "-") => `1 ${status} ${conclusion} https://example/runs/1\n`;

  it("waits through queued and in_progress, then passes", () => {
    const r = gate([run("queued"), run("in_progress"), run("completed", "success")]);
    expect(r).toEqual({ status: 0, outcome: "outcome=passed", calls: 3 });
  });

  it("waits for a run to appear", () => {
    const r = gate(["", "", run("completed", "success")]);
    expect(r).toEqual({ status: 0, outcome: "outcome=passed", calls: 3 });
  });

  it("fails once the run completes without success", () => {
    const r = gate([run("in_progress"), run("completed", "failure")]);
    expect(r).toEqual({ status: 1, outcome: "outcome=failed", calls: 2 });
  });

  it("fails as missing when no run appears in time", () => {
    const r = gate([""], { PUBLISH_VERIFY_APPEAR_SECONDS: "0" });
    expect(r).toMatchObject({ status: 1, outcome: "outcome=missing" });
  });

  it("ends as timeout, not failed, when the run is still going", () => {
    const r = gate([run("in_progress")], { PUBLISH_VERIFY_WAIT_SECONDS: "0" });
    expect(r).toMatchObject({ status: 1, outcome: "outcome=timeout" });
  });
});
