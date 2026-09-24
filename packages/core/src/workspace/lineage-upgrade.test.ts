/**
 * chant #2550 — `chant workspace upgrade`, end to end over real git
 * repositories: a template with tagged versions, a project made with
 * `init --from <template>@v1`, edits in the project, and upgrades that merge,
 * conflict, migrate, refuse a gap, and wait on a gate bound to the patch.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateLedgerPort } from "../op/gate";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { WORKSPACE_UPGRADE_GATE_OP } from "../op/gate-name";
import { proposeWorkspaceUpgrade } from "../op/activities/propose-upgrade";
import { checkLineage } from "./lineage-check";
import { initFromCommand } from "./lineage-init";
import { LOCK_FILE, fileHash, readLock, writeLock } from "./lineage-lock";
import { stageUpgrade, isGovernancePath, UPGRADE_DIR, type ChantRunner } from "./lineage-upgrade";
import { upgradeCommand } from "./lineage-upgrade-cli";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let root: string;
let tpl: string;
let proj: string;

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
function release(tag: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) rmSync(join(tpl, rel));
    else put(tpl, rel, content);
  }
  git(tpl, ["add", "-A"]);
  git(tpl, ["commit", "-q", "--allow-empty", "-m", tag]);
  git(tpl, ["tag", tag]);
}
function commitProject(message: string): void {
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-q", "-m", message]);
}

/** A gate ledger in memory that a test can approve into. */
function ledger(): GateLedgerPort & { pending: PendingGateRecord[]; approve(digest: string, at: string, by?: string): void } {
  const pending: PendingGateRecord[] = [];
  const resolutions: GateResolutionRecord[] = [];
  return {
    pending,
    approve(digest, at, by = "alice") {
      resolutions.push({ version: 1, op: WORKSPACE_UPGRADE_GATE_OP, gate: pending.at(-1)?.gate ?? ".", resolvedBy: by, timestamp: at, planDigest: digest });
    },
    async read() {
      return { resolutions: [...resolutions], pending: [...pending] };
    },
    async appendPending(input) {
      const record: PendingGateRecord = { version: 1, kind: "pending", ...input };
      pending.push(record);
      return { record, pushed: true };
    },
  };
}

const passing: ChantRunner = async () => ({ exitCode: 0, output: "" });

const V1 = {
  "README.md": "starter\n",
  "src/a.ts": "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
  "src/old.ts": "export const old = 1;\n\n\n\nexport const tail = 1;\n",
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-upgrade-test-")));
  tpl = join(root, "tpl");
  proj = join(root, "proj");
  mkdirSync(tpl);
  git(tpl, ["init", "-q", "-b", "main"]);
  release("v1.0.0", V1);
  const made = await initFromCommand({ from: `${tpl}@v1.0.0`, path: proj });
  expect(made.error).toBeUndefined();
  git(proj, ["init", "-q", "-b", "main"]);
  commitProject("init from v1");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("chant workspace upgrade", () => {
  test("merges a customised file whose hunks are clean, and updates an unedited one", async () => {
    put(proj, "src/a.ts", "ONE (ours)\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    commitProject("edit");
    release("v2.0.0", { "README.md": "starter v2\n", "src/a.ts": "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN (theirs)\n", "src/new.ts": "new\n" });

    const staged = await stageUpgrade({ root: proj, to: "v2.0.0", runChant: passing });
    try {
      expect(staged.merged).toEqual(["src/a.ts"]);
      expect(staged.written.sort()).toEqual(["README.md", "src/new.ts"]);
      expect(staged.manualSteps).toEqual([]);
      expect(staged.changedPaths).toEqual([LOCK_FILE, "README.md", "src/a.ts", "src/new.ts"]);
      expect(staged.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      // The project's tree is untouched until the gate is approved.
      expect(read(proj, "README.md")).toBe("starter\n");
      expect(existsSync(join(proj, "src/new.ts"))).toBe(false);
      expect(read(staged.worktreeProject, "src/a.ts")).toBe("ONE (ours)\ntwo\nthree\nfour\nfive\nsix\nSEVEN (theirs)\n");
      // Build and lint are skipped: the template is not a chant project. The lineage check ran.
      expect(staged.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["build:skipped", "lint:skipped", "workspace check:passed"]);
    } finally {
      staged.dispose();
    }
    expect(existsSync(join(proj, UPGRADE_DIR))).toBe(false);
    expect(git(proj, ["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  test("gates on the patch digest, then applies exactly the approved patch", async () => {
    release("v2.0.0", { "README.md": "starter v2\n" });
    const port = ledger();

    const first = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:00:00.000Z" });
    expect(first.outcome).toBe("gated");
    expect(first.exitCode).toBe(3);
    expect(port.pending).toHaveLength(1);
    expect(port.pending[0]).toMatchObject({ op: "workspace-upgrade", gate: ".", planDigest: first.staged!.digest });
    expect(read(proj, "README.md")).toBe("starter\n");

    // An approval for another patch does not apply this one.
    port.approve(`sha256:${"0".repeat(64)}`, "2026-09-23T10:01:00.000Z");
    const mismatched = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:02:00.000Z" });
    expect(mismatched.outcome).toBe("gated");
    expect(read(proj, "README.md")).toBe("starter\n");

    port.approve(first.staged!.digest, "2026-09-23T10:03:00.000Z");
    const second = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:04:00.000Z" });
    expect(second.outcome).toBe("applied");
    expect(second.staged!.digest).toBe(first.staged!.digest);
    expect(read(proj, "README.md")).toBe("starter v2\n");
    const lineage = readLock(proj)!.scopes["."];
    expect(lineage.ref).toBe("v2.0.0");
    expect(lineage.address?.commit).toBe(git(tpl, ["rev-parse", "v2.0.0^{commit}"]));
    expect(lineage.files["README.md"].sha256).toBe(fileHash("starter v2\n"));

    // Committed, the scope is at v2, and upgrading again has nothing to do.
    commitProject("upgrade");
    const again = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port });
    expect(again.outcome).toBe("up-to-date");
  });

  test("a lock that a .gitignore covers is applied beside the patch, and the digest covers it", async () => {
    put(proj, ".gitignore", ".chant/\n");
    git(proj, ["rm", "-q", "--cached", LOCK_FILE]);
    commitProject("ignore .chant/, as some templates do");
    release("v2.0.0", {});
    const port = ledger();
    const first = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:00:00.000Z" });
    // Only the lock changes, and it is not in the patch.
    expect(first.outcome).toBe("gated");
    expect(first.staged!.changedPaths).toEqual([]);
    port.approve(first.staged!.digest, "2026-09-23T10:01:00.000Z");
    const applied = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:02:00.000Z" });
    expect(applied.outcome).toBe("applied");
    expect(readLock(proj)!.scopes["."].ref).toBe("v2.0.0");
    const again = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port });
    expect(again.outcome).toBe("up-to-date");
  });

  test("a customised file with a conflicting hunk is kept whole and becomes one manual step", async () => {
    put(proj, "src/a.ts", "one\ntwo (ours)\nthree\nfour\nfive\nsix\nseven (ours)\n");
    commitProject("edit");
    release("v2.0.0", { "src/a.ts": "one\ntwo (theirs)\nthree\nfour\nfive\nsix\nseven\n" });
    const port = ledger();

    const first = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:00:00.000Z" });
    expect(first.staged!.manualSteps).toEqual([{ path: "src/a.ts", reason: "changed-locally", upstream: fileHash("one\ntwo (theirs)\nthree\nfour\nfive\nsix\nseven\n") }]);
    expect(first.staged!.merged).toEqual([]);
    // The file is not in the patch; only the lock records the step.
    expect(first.staged!.changedPaths).toEqual([LOCK_FILE]);
    expect(first.staged!.checksOk).toBe(true);

    port.approve(first.staged!.digest, "2026-09-23T10:01:00.000Z");
    const applied = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:02:00.000Z" });
    expect(applied.outcome).toBe("applied");
    expect(read(proj, "src/a.ts")).toBe("one\ntwo (ours)\nthree\nfour\nfive\nsix\nseven (ours)\n");
    // Open manual steps fail check until resolved.
    const report = checkLineage(proj);
    expect(report.ok).toBe(false);
    expect(report.findings).toMatchObject([{ code: "manual-step-open", scope: ".", path: "src/a.ts" }]);
    // And a further upgrade is refused while the step is open.
    commitProject("upgrade with a step");
    await expect(stageUpgrade({ root: proj, to: "v2.0.0", runChant: passing })).rejects.toThrow(/open manual step/);
  });

  test("runs a declarative migration before the merge, records it, and checks its post-condition", async () => {
    put(proj, "src/old.ts", "export const old = 1;\n\n\n\nexport const tail = 2; // ours\n");
    commitProject("edit");
    release("v2.0.0", {
      "src/old.ts": null,
      "src/new.ts": "export const renamed = 1;\n\n\n\nexport const tail = 1;\n",
      ".chant/migrations/rename.json": JSON.stringify({
        id: "rename-old",
        from: { versions: ">=1.0.0 <2.0.0" },
        to: "2.0.0",
        body: { type: "declarative", steps: [{ op: "move", from: "src/old.ts", to: "src/new.ts" }] },
        post: [{ check: "exists", path: "src/new.ts" }, { check: "absent", path: "src/old.ts" }],
      }),
    });

    const staged = await stageUpgrade({ root: proj, to: "v2.0.0", runChant: passing });
    try {
      expect(staged.migrations).toEqual(["rename-old"]);
      expect(staged.merged).toEqual(["src/new.ts"]);
      expect(read(staged.worktreeProject, "src/new.ts")).toBe("export const renamed = 1;\n\n\n\nexport const tail = 2; // ours\n");
      expect(existsSync(join(staged.worktreeProject, "src/old.ts"))).toBe(false);
      // The template's migrations never land in the project.
      expect(existsSync(join(staged.worktreeProject, ".chant/migrations"))).toBe(false);
      const lock = readLock(staged.worktreeProject)!.scopes["."];
      expect(lock.migrations).toEqual(["rename-old"]);
      expect(Object.keys(lock.files).sort()).toEqual(["README.md", "src/a.ts", "src/new.ts"]);
    } finally {
      staged.dispose();
    }
  });

  test("a failed post-condition refuses the upgrade", async () => {
    release("v2.0.0", {
      ".chant/migrations/m.json": JSON.stringify({
        id: "wants-file",
        from: { versions: "1.x" },
        to: "2.0.0",
        body: { type: "declarative", steps: [{ op: "replace", path: "README.md", find: "starter", with: "begin" }] },
        post: [{ check: "contains", path: "README.md", text: "never there" }],
      }),
    });
    await expect(stageUpgrade({ root: proj, to: "v2.0.0", runChant: passing })).rejects.toThrow(/post-condition does not hold/);
    expect(existsSync(join(proj, UPGRADE_DIR))).toBe(false);
  });

  test("a gap in the migration chain is refused", async () => {
    release("v2.0.0", {});
    release("v3.0.0", {
      ".chant/migrations/three.json": JSON.stringify({
        id: "two-to-three",
        from: { versions: ">=2.0.0 <3.0.0" },
        to: "3.0.0",
        body: { type: "declarative", steps: [{ op: "delete", path: "src/old.ts" }] },
      }),
    });
    await expect(stageUpgrade({ root: proj, to: "v3.0.0", runChant: passing })).rejects.toThrow(/gap in the migration chain: two-to-three .* the scope is at 1\.0\.0/);
  });

  test("a code migration runs only with allowCode", async () => {
    release("v2.0.0", {
      ".chant/migrations/code.json": JSON.stringify({ id: "by-code", from: { versions: "^1.0.0" }, to: "2.0.0", body: { type: "code", module: "code.mjs" }, post: [{ check: "exists", path: "MIGRATED" }] }),
      ".chant/migrations/code.mjs": "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport default async ({ dir }) => writeFileSync(join(dir, 'MIGRATED'), 'yes\\n');\n",
    });
    await expect(stageUpgrade({ root: proj, to: "v2.0.0", runChant: passing })).rejects.toThrow(/--allow-code/);
    const staged = await stageUpgrade({ root: proj, to: "v2.0.0", allowCode: true, runChant: passing });
    try {
      expect(staged.migrations).toEqual(["by-code"]);
      expect(staged.changedPaths).toContain("MIGRATED");
    } finally {
      staged.dispose();
    }
  });

  test("failing build or lint in the worktree stops the upgrade before its gate", async () => {
    put(proj, "chant.config.ts", "export default {};\n");
    commitProject("a chant project");
    release("v2.0.0", { "README.md": "v2\n" });
    const port = ledger();
    const calls: string[] = [];
    const lintFails: ChantRunner = async (command, cwd) => {
      calls.push(`${command} in ${cwd.includes(UPGRADE_DIR) ? "worktree" : cwd}`);
      return command === "lint" ? { exitCode: 1, output: "lint error" } : { exitCode: 0, output: "" };
    };
    const result = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: lintFails, ledger: port });
    expect(calls).toEqual(["build in worktree", "lint in worktree"]);
    expect(result.outcome).toBe("checks-failed");
    expect(result.exitCode).toBe(1);
    expect(port.pending).toHaveLength(0);
    expect(read(proj, "README.md")).toBe("starter\n");
  });

  test("governance changes need human approval under the rules at HEAD", async () => {
    release("v2.0.0", { "ops/deploy.op.ts": "export {};\n", ".github/workflows/ci.yml": "on: push\n" });
    const port = ledger();
    const first = await upgradeCommand({ root: proj, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:00:00.000Z" });
    expect(first.outcome).toBe("gated");
    expect(first.staged!.governance).toMatchObject({ paths: [".github/workflows/ci.yml", "ops/deploy.op.ts"], approval: { mode: "log-only", quorum: { count: 1 } } });
    expect(port.pending[0].approval).toEqual({ mode: "log-only", quorum: { count: 1 } });
    expect(isGovernancePath("CODEOWNERS")).toBe(true);
    expect(isGovernancePath("src/main.ts")).toBe(false);
  });

  test("refuses a scope with uncommitted changes, and a scope that does not exist", async () => {
    put(proj, "README.md", "dirty\n");
    await expect(stageUpgrade({ root: proj, to: "v1.0.0" })).rejects.toThrow(/uncommitted changes/);
    await expect(stageUpgrade({ root: proj, scope: "vendor/x" })).rejects.toThrow(/no scope "vendor\/x"/);
  });

  test("a vendor scope merges what it can: unedited files update, edited ones become manual steps", async () => {
    put(proj, "shared/web/index.ts", "export const v = 1;\n");
    put(proj, "shared/web/util.ts", "export const u = 1;\n");
    put(proj, "vendor/web/index.ts", "export const v = 1; // ours\n");
    put(proj, "vendor/web/util.ts", "export const u = 1;\n");
    const lock = readLock(proj)!;
    lock.scopes["vendor/web"] = {
      kind: "vendor",
      name: "web",
      template: "local:shared/web",
      source: { type: "local", path: "shared/web" },
      address: { digest: `sha256:${"a".repeat(64)}` },
      parameters: {},
      migrations: [],
      files: {
        "index.ts": { class: "owned", sha256: fileHash("export const v = 1;\n") },
        "util.ts": { class: "owned", sha256: fileHash("export const u = 1;\n") },
      },
      manualSteps: [],
    };
    writeLock(proj, lock);
    commitProject("vendor");
    put(proj, "shared/web/index.ts", "export const v = 2;\n");
    put(proj, "shared/web/util.ts", "export const u = 2;\n");
    commitProject("source moves");

    const staged = await stageUpgrade({ root: proj, scope: "vendor/web", runChant: passing });
    try {
      expect(staged.written).toEqual(["util.ts"]);
      expect(staged.manualSteps.map((s) => `${s.path}:${s.reason}`)).toEqual(["index.ts:changed-locally"]);
    } finally {
      staged.dispose();
    }
  });
});

describe("proposeWorkspaceUpgrade", () => {
  test("writes a proposal branch and pushes it, never the default branch", async () => {
    const remote = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", "-b", "main", remote]);
    git(proj, ["remote", "add", "origin", remote]);
    git(proj, ["push", "-q", "origin", "main"]);
    git(proj, ["remote", "set-head", "origin", "main"]);
    release("v2.0.0", { "README.md": "starter v2\n" });
    const mainBefore = git(proj, ["rev-parse", "main"]);

    const report = await proposeWorkspaceUpgrade({ cwd: proj, to: "v2.0.0", _runChant: passing });
    expect(report).toMatchObject({ mode: "report", changed: true, proposed: false, checksOk: true, from: "v1.0.0", to: "v2.0.0" });

    const branch = await proposeWorkspaceUpgrade({ cwd: proj, to: "v2.0.0", mode: "branch", _runChant: passing });
    expect(branch).toMatchObject({ proposed: true, branch: "chant/upgrade/root", pushed: true, digest: report.digest });
    expect(git(remote, ["rev-parse", "chant/upgrade/root"])).toBe(branch.commit);
    expect(git(remote, ["show", "chant/upgrade/root:README.md"])).toBe("starter v2");
    expect(git(remote, ["rev-parse", "main"])).toBe(mainBefore);
    expect(git(proj, ["rev-parse", "main"])).toBe(mainBefore);
    expect(read(proj, "README.md")).toBe("starter\n");

    await expect(proposeWorkspaceUpgrade({ cwd: proj, to: "v2.0.0", mode: "branch", branch: "main", _runChant: passing })).rejects.toThrow(/will not write the default branch "main"/);
    expect(git(remote, ["rev-parse", "main"])).toBe(mainBefore);
  });

  test("opens a pull request once and edits it on the next run", async () => {
    const remote = join(root, "remote.git");
    git(root, ["init", "-q", "--bare", "-b", "main", remote]);
    git(proj, ["remote", "add", "origin", remote]);
    git(proj, ["push", "-q", "origin", "main"]);
    git(proj, ["remote", "set-head", "origin", "main"]);
    release("v2.0.0", { "README.md": "starter v2\n" });
    const gh: string[][] = [];
    let open = "";
    const run = async (bin: "git" | "gh", args: string[], cwd: string): Promise<string> => {
      if (bin === "git") return execFileSync("git", args, { cwd, encoding: "utf-8", env: ENV, stdio: ["ignore", "pipe", "pipe"] });
      gh.push(args);
      if (args[1] === "list") return open;
      if (args[1] === "create") {
        open = "https://example.invalid/pr/1";
        return `${open}\n`;
      }
      return "";
    };
    const first = await proposeWorkspaceUpgrade({ cwd: proj, to: "v2.0.0", mode: "pull-request", _run: run, _runChant: passing });
    expect(first.prUrl).toBe("https://example.invalid/pr/1");
    const create = gh.find((a) => a[1] === "create")!;
    expect(create.slice(0, 6)).toEqual(["pr", "create", "--base", "main", "--head", "chant/upgrade/root"]);
    expect(create[create.indexOf("--body") + 1]).toContain(first.digest);
    await proposeWorkspaceUpgrade({ cwd: proj, to: "v2.0.0", mode: "pull-request", _run: run, _runChant: passing });
    expect(gh.filter((a) => a[1] === "create")).toHaveLength(1);
    expect(gh.filter((a) => a[1] === "edit")).toHaveLength(1);
  });
});
