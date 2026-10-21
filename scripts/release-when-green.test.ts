/**
 * `just release-when-green` (#4218): scripts/release-when-green.sh against a
 * local bare origin, with a fake `gh` whose check runs live in a state file,
 * a fake `npm`, and a fake release command. Dispatching release-suites adds a
 * `suites` check run; dispatching the tick pushes ci/green/<sha> to the origin.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "release-when-green.sh");
let dir: string;
let work: string;
let origin: string;
let state: string;
let sha: string;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

const DECL = {
  name: "t",
  ci: {
    green: {
      branch: "main",
      phases: { check: { runs: ["check"], build: "every" }, suites: { runs: ["suites"], build: "newest" } },
      require: ["check", "suites"],
    },
  },
};

function bin(name: string, body: string) {
  const b = join(dir, "bin");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(b, name), 0o755);
}

function fakes(suitesResult = "success") {
  bin(
    "gh",
    `echo "gh $*" >> "${state}/log"
case "$1 $2" in
  "api "*) cat "${state}/checks" ;;
  "workflow run")
    case "$3" in
      release-suites.yml) echo "suites|completed|${suitesResult}" >> "${state}/checks" ;;
      chant-ci-green.yml) git -C "${origin}" tag "ci/green/${sha}" "${sha}" ;;
    esac ;;
  "run list")
    case "$*" in
      *chant-ci-green.yml*) echo "completed|success" ;;
      *publish.yml*) echo "42|completed|success" ;;
    esac ;;
esac`,
  );
  bin("npm", 'echo "9.9.9"');
  bin("fake-release", `echo "release $*" >> "${state}/log"; echo "Released 9.9.9: publish.yml runs on release/npm/9.9.9"`);
}

function run(...args: string[]) {
  return spawnSync("bash", [script, ...args], {
    cwd: work,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      RWG_POLL: "0",
      RWG_RELEASE_CMD: join(dir, "bin", "fake-release"),
      RWG_CHANT: "false",
    },
  });
}

const log = () => (existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf-8") : "");
const checks = (...lines: string[]) => writeFileSync(join(state, "checks"), lines.map((l) => `${l}\n`).join(""));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-rwg-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  state = join(dir, "state");
  mkdirSync(state);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, work);
  git(work, "config", "user.email", "t@chant.dev");
  git(work, "config", "user.name", "T");
  mkdirSync(join(work, ".github", "workflows"), { recursive: true });
  writeFileSync(join(work, "chant.workspace.json"), JSON.stringify(DECL));
  writeFileSync(join(work, ".github", "workflows", "chant.yml"), "on:\n  push:\n    branches: [main]\n");
  writeFileSync(join(work, ".github", "workflows", "release-suites.yml"), "on:\n  push:\n    branches: [main]\n  workflow_dispatch: {}\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  sha = git(work, "rev-parse", "HEAD");
  checks();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("release-when-green (#4218)", () => {
  it("cuts a commit that is already green, starting nothing", () => {
    fakes();
    checks("check|completed|success", "suites|completed|success");
    git(origin, "tag", `ci/green/${sha}`, sha);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toContain("workflow run");
    expect(log()).toContain(`release patch ${sha}`);
    expect(r.stdout).toContain("published 9.9.9; npm latest is 9.9.9");
  });

  it("starts the missing suites, then the tick once every phase passed, then cuts", () => {
    fakes();
    checks("check|completed|success");
    const r = run("minor");
    expect(r.status, r.stderr).toBe(0);
    const l = log();
    expect(l).toContain("gh workflow run release-suites.yml --ref main");
    expect(l).toContain("gh workflow run chant-ci-green.yml --ref main");
    expect(l.indexOf("release-suites.yml")).toBeLessThan(l.indexOf("chant-ci-green.yml"));
    expect(l).toContain(`release minor ${sha}`);
  });

  it("starts the tick for a commit whose phases passed but has no green tag", () => {
    fakes();
    checks("check|completed|success", "suites|completed|success");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toContain("release-suites.yml");
    expect(log()).toContain("gh workflow run chant-ci-green.yml --ref main");
  });

  it("stops on a failed job, naming it, and cuts nothing", () => {
    fakes("failure");
    checks("check|completed|success");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("phase suites failed");
    expect(r.stderr).toContain("suites (failure)");
    expect(log()).not.toContain("chant-ci-green.yml");
    expect(log()).not.toContain("release ");
  });

  it("refuses a missing phase whose workflow takes no dispatch", () => {
    fakes();
    checks("suites|completed|success");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("chant.yml takes no workflow_dispatch");
    expect(log()).not.toContain("workflow run");
  });

  it("--dry-run says what it would start and dispatches nothing", () => {
    fakes();
    checks("check|completed|success");
    const r = run("--dry-run");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("starting release-suites.yml on main for suites");
    expect(r.stdout).toContain("dry run: would wait");
    expect(log()).not.toContain("workflow run");
    expect(log()).not.toContain("release ");
  });
});
