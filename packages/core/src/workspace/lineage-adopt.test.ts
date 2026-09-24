/**
 * chant #2551 — adopt-lineage, the hash index, and bridge migrations, over
 * real git repositories.
 *
 * The fixture is D9's scenario 6, a fork-born workspace: an upstream template
 * with tagged releases, a fork of it that renamed a file and tagged releases
 * of its own, and a workspace copied by hand from the fork at a tag, with no
 * lock, then edited. The workspace adopts a lineage against the fork, and an
 * upgrade with `--source` moves it onto the upstream template through the
 * upstream's bridge migration.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateLedgerPort } from "../op/gate";
import type { GateResolutionRecord, PendingGateRecord } from "../lifecycle/gate-ledger";
import { WORKSPACE_UPGRADE_GATE_OP } from "../op/gate-name";
import { adoptLineage } from "./lineage-adopt";
import { lineageView } from "./lineage-cli";
import { computeHashIndex, readHashIndex, renderHashIndex, TemplateTags, type HashIndex } from "./lineage-hash-index";
import { LOCK_FILE, fileHash, readLock } from "./lineage-lock";
import { stageUpgrade, type ChantRunner } from "./lineage-upgrade";
import { upgradeCommand } from "./lineage-upgrade-cli";
import { workspaceVersions } from "./lineage-versions";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let root: string;
let up: string;
let fork: string;
let ws: string;

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
function release(repo: string, tag: string, files: Record<string, string | null>): void {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) rmSync(join(repo, rel));
    else put(repo, rel, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", tag]);
  git(repo, ["tag", tag]);
}
function commit(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}
/** Copy a repository's files at a tag into a directory, the way a fork-born workspace was made: by hand, with no lock. */
function copyAt(repo: string, tag: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", tag], { cwd: repo });
  execFileSync("tar", ["-x", "-C", dest], { input: tar });
}

function ledger(): GateLedgerPort & { pending: PendingGateRecord[]; approve(digest: string, at: string): void } {
  const pending: PendingGateRecord[] = [];
  const resolutions: GateResolutionRecord[] = [];
  return {
    pending,
    approve(digest, at) {
      resolutions.push({ version: 1, op: WORKSPACE_UPGRADE_GATE_OP, gate: ".", resolvedBy: "alice", timestamp: at, planDigest: digest });
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

const APP_V1 = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-adopt-test-")));
  up = join(root, "up");
  fork = join(root, "fork");
  ws = join(root, "ws");

  // The upstream template.
  mkdirSync(up);
  git(up, ["init", "-q", "-b", "main"]);
  release(up, "v1.0.0", { "README.md": "starter\n", "src/app.ts": APP_V1, "config.json": '{ "name": "starter" }\n' });

  // The fork: cloned at v1.0.0, then its own layout and its own tags.
  git(root, ["clone", "-q", "--branch", "v1.0.0", up, "fork"]);
  git(fork, ["checkout", "-q", "-b", "main"]);
  git(fork, ["tag", "-d", "v1.0.0"]);
  git(fork, ["mv", "config.json", "settings.json"]);
  release(fork, "v1.0.0", { "README.md": "starter (fork)\n" });
  release(fork, "v1.1.0", { "src/app.ts": "one (fork)\ntwo\nthree\nfour\nfive\nsix\nseven\n", "src/extra.ts": "export const extra = 1;\n", "docs.md": "# docs\n" });
  release(fork, "v1.2.0", { "README.md": "starter (fork, 1.2)\n" });

  // The fork-born workspace: copied from the fork at v1.1.0, no lock, edited over two commits.
  copyAt(fork, "v1.1.0", ws);
  git(ws, ["init", "-q", "-b", "main"]);
  commit(ws, "copied from the fork");
  put(ws, "src/app.ts", "one (fork)\ntwo\nthree\nfour (ours)\nfive\nsix\nseven\n");
  rmSync(join(ws, "docs.md"));
  put(ws, "src/own.ts", "export const own = 1;\n");
  commit(ws, "our changes");

  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("chant workspace adopt-lineage", () => {
  test("finds the tag the scope was made from and records the lineage as adopted", () => {
    const p = adoptLineage({ root: ws, from: fork });
    expect(p.written).toBe(true);
    expect(p.chosen).toMatchObject({ tag: "v1.1.0", files: 5, identical: 3, edited: 1, missing: 1 });
    expect(p.compared).toBe(3);
    expect(p.identical.sort()).toEqual(["README.md", "settings.json", "src/extra.ts"]);
    expect(p.edited).toEqual(["src/app.ts"]);
    expect(p.missing).toEqual(["docs.md"]);
    // v1.0.0 and v1.2.0 each match two files; v1.0.0 accounts for its files better, so it ranks next.
    expect(p.alternatives.map((a) => [a.tag, a.identical])).toEqual([
      ["v1.0.0", 2],
      ["v1.2.0", 2],
    ]);

    const lineage = readLock(ws)!.scopes["."];
    expect(lineage).toMatchObject({
      kind: "template",
      template: fork,
      source: { type: "git", repo: fork, url: "../fork" },
      ref: "v1.1.0",
      parameters: {},
      migrations: [],
      manualSteps: [],
    });
    expect(lineage.address?.commit).toBe(git(fork, ["rev-parse", "v1.1.0^{commit}"]));
    expect(lineage.address?.tree).toBe(git(fork, ["rev-parse", "v1.1.0^{tree}"]));
    // Every template file, at the template's hash: the merge base. The workspace's own file is not the template's.
    expect(Object.keys(lineage.files).sort()).toEqual(["README.md", "docs.md", "settings.json", "src/app.ts", "src/extra.ts"]);
    expect(lineage.files["src/app.ts"].sha256).toBe(fileHash(git(fork, ["show", "v1.1.0:src/app.ts"]) + "\n"));

    // The exact commit range: the scope's whole history up to HEAD.
    const history = git(ws, ["rev-list", "HEAD"]).split("\n");
    expect(lineage.adoption).toEqual({
      provenance: "adopted",
      commits: { first: history[history.length - 1], last: history[0], count: 2 },
      match: { files: 5, identical: 3, edited: 1, missing: 1 },
      index: "computed",
      attestation: null,
    });

    const view = lineageView(ws)!.scopes[0];
    expect(view.provenance).toBe("adopted");
    expect(view.edited).toEqual(["src/app.ts"]);
    expect(view.missing).toEqual(["docs.md"]);
  });

  test("a tag in --from adopts at exactly that version; --dry-run writes nothing", () => {
    const p = adoptLineage({ root: ws, from: `${fork}@v1.0.0`, dryRun: true });
    expect(p.written).toBe(false);
    expect(p.compared).toBe(1);
    expect(p.chosen).toMatchObject({ tag: "v1.0.0", identical: 2 });
    expect(existsSync(join(ws, LOCK_FILE))).toBe(false);
  });

  test("versions that match equally are named, and the oldest is adopted", () => {
    // v1.1.1 re-tags the same files as v1.1.0 (on a branch, so the fork's main moves on untouched).
    git(fork, ["tag", "v1.1.1", "v1.1.0"]);
    // A template that ignores .chant/ carries that into the copy.
    put(ws, ".gitignore", ".chant/\n");
    commit(ws, "ignore .chant/");
    const p = adoptLineage({ root: ws, from: fork });
    expect(p.chosen.tag).toBe("v1.1.0");
    expect(p.ties).toEqual(["v1.1.1"]);
    expect(p.alternatives.map((a) => a.tag)).toEqual(["v1.0.0", "v1.2.0"]);
    expect(p.lockIgnored).toBe(true);
  });

  test("--tags narrows the candidates", () => {
    const p = adoptLineage({ root: ws, from: fork, tags: "v1.2.*", dryRun: true });
    expect(p.compared).toBe(1);
    expect(p.chosen.tag).toBe("v1.2.0");
  });

  test("refuses a scope with a lineage, uncommitted changes, or nothing in common", () => {
    put(ws, "src/own.ts", "changed\n");
    expect(() => adoptLineage({ root: ws, from: fork })).toThrow(/uncommitted changes .*src\/own\.ts/);
    commit(ws, "more");

    const other = join(root, "other");
    mkdirSync(other);
    git(other, ["init", "-q", "-b", "main"]);
    release(other, "v1.0.0", { "unrelated.txt": "x\n" });
    expect(() => adoptLineage({ root: ws, from: other })).toThrow(/no tagged version .* shares a file/);

    adoptLineage({ root: ws, from: fork });
    expect(() => adoptLineage({ root: ws, from: fork })).toThrow(/already has a lineage for scope "\."/);
  });

  test("a cached index is reused, and the adopted tag is re-checked against the template", () => {
    const tags = new TemplateTags(fork, undefined, fork);
    let index: HashIndex;
    try {
      index = computeHashIndex(tags, fork).index;
    } finally {
      tags.dispose();
    }
    expect(index.tags.map((t) => t.tag)).toEqual(["v1.0.0", "v1.1.0", "v1.2.0"]);
    const file = join(root, "index.json");
    writeFileSync(file, renderHashIndex(index));
    const cache = readHashIndex(file);

    // A cache for another template is refused.
    expect(() => adoptLineage({ root: ws, from: up, cache, dryRun: true })).toThrow(/is for .* not/);

    const fromCache = adoptLineage({ root: ws, from: fork, cache, dryRun: true });
    expect(fromCache.index).toBe("cache");
    expect(fromCache.chosen.tag).toBe("v1.1.0");

    // A forged entry makes v1.0.0 look like a perfect match. The re-check catches it, and every tag is computed instead.
    const forged: HashIndex = structuredClone(cache);
    forged.tags[0].files = {
      "README.md": fileHash(read(ws, "README.md")),
      "settings.json": fileHash(read(ws, "settings.json")),
      "src/app.ts": fileHash(read(ws, "src/app.ts")),
      "src/extra.ts": fileHash(read(ws, "src/extra.ts")),
    };
    const rechecked = adoptLineage({ root: ws, from: fork, cache: forged });
    expect(rechecked.index).toBe("computed");
    expect(rechecked.chosen.tag).toBe("v1.1.0");
    expect(readLock(ws)!.scopes["."].adoption?.index).toBe("computed");
  });

  test("a moved tag is recomputed rather than read from the cache", () => {
    const tags = new TemplateTags(fork, undefined, fork);
    let cache: HashIndex;
    try {
      cache = computeHashIndex(tags, fork).index;
    } finally {
      tags.dispose();
    }
    // Retag v1.2.0 onto a new commit.
    git(fork, ["tag", "-d", "v1.2.0"]);
    release(fork, "v1.2.0", { "README.md": "starter (fork, 1.2 retagged)\n" });
    const again = new TemplateTags(fork, undefined, fork);
    try {
      const { index, cached } = computeHashIndex(again, fork, { cache });
      expect([...cached].sort()).toEqual(["v1.0.0", "v1.1.0"]);
      expect(index.tags[2].commit).toBe(git(fork, ["rev-parse", "v1.2.0^{commit}"]));
      expect(index.tags[2].files["README.md"]).toBe(fileHash("starter (fork, 1.2 retagged)\n"));
    } finally {
      again.dispose();
    }
  });
});

describe("bringing a fork-born workspace forward", () => {
  test("an adopted scope upgrades within its own template", async () => {
    adoptLineage({ root: ws, from: fork });
    commit(ws, "adopt");
    const staged = await stageUpgrade({ root: ws, to: "v1.2.0", runChant: passing });
    try {
      expect(staged.written).toEqual(["README.md"]);
      expect(staged.manualSteps).toEqual([]);
    } finally {
      staged.dispose();
    }
  });

  test("adopted against the fork, then moved onto the upstream template by its bridge migration", async () => {
    // Upstream v2.0.0 renames src/app.ts, and ships a bridge for projects of the fork.
    release(up, "v2.0.0", {
      "README.md": "starter v2\n",
      "src/app.ts": null,
      "src/main.ts": "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN (v2)\n",
      "config.json": '{ "name": "starter", "v": 2 }\n',
      ".chant/migrations/rename.json": JSON.stringify({
        id: "rename-app",
        from: { versions: ">=1.0.0 <2.0.0" },
        to: "2.0.0",
        body: { type: "declarative", steps: [{ op: "move", from: "src/app.ts", to: "src/main.ts" }] },
      }),
      ".chant/migrations/from-fork.json": JSON.stringify({
        id: "from-fork",
        description: "the fork's layout onto upstream 2.0.0",
        from: { template: fork, versions: ">=1.0.0 <2.0.0" },
        to: "2.0.0",
        body: {
          type: "declarative",
          steps: [
            { op: "move", from: "src/app.ts", to: "src/main.ts" },
            { op: "move", from: "settings.json", to: "config.json" },
          ],
        },
        post: [
          { check: "exists", path: "config.json" },
          { check: "absent", path: "settings.json" },
        ],
      }),
    });

    adoptLineage({ root: ws, from: fork });
    commit(ws, "adopt the fork's lineage");

    const port = ledger();
    const first = await upgradeCommand({ root: ws, source: up, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:00:00.000Z" });
    expect(first.outcome).toBe("gated");
    expect(first.staged).toMatchObject({ template: fork, switchedTo: up, from: "v1.1.0", to: "v2.0.0", migrations: ["from-fork"] });
    expect(read(ws, "settings.json")).toBe('{ "name": "starter" }\n');

    port.approve(first.staged!.digest, "2026-09-23T10:01:00.000Z");
    const applied = await upgradeCommand({ root: ws, source: up, to: "v2.0.0", runChant: passing, ledger: port, now: "2026-09-23T10:02:00.000Z" });
    expect(applied.outcome).toBe("applied");
    expect(applied.staged!.merged).toEqual(["src/main.ts"]);

    // The workspace is on upstream v2.0.0, with its own edit kept and upstream's merged in.
    expect(read(ws, "src/main.ts")).toBe("one\ntwo\nthree\nfour (ours)\nfive\nsix\nSEVEN (v2)\n");
    expect(read(ws, "config.json")).toBe('{ "name": "starter", "v": 2 }\n');
    expect(read(ws, "README.md")).toBe("starter v2\n");
    expect(read(ws, "src/own.ts")).toBe("export const own = 1;\n");
    for (const gone of ["settings.json", "src/app.ts", "src/extra.ts", "docs.md"]) expect(existsSync(join(ws, gone)), gone).toBe(false);

    const lineage = readLock(ws)!.scopes["."];
    expect(lineage).toMatchObject({ template: up, source: { type: "git", repo: up, url: "../up" }, ref: "v2.0.0", migrations: ["from-fork"], manualSteps: [] });
    expect(lineage.address?.commit).toBe(git(up, ["rev-parse", "v2.0.0^{commit}"]));
    expect(Object.keys(lineage.files).sort()).toEqual(["README.md", "config.json", "src/main.ts"]);
    // The adoption stays: it describes the history before the lock.
    expect(lineage.adoption?.provenance).toBe("adopted");

    // The next upstream release is an ordinary upgrade.
    commit(ws, "on upstream v2");
    release(up, "v2.1.0", { "README.md": "starter v2.1\n" });
    const staged = await stageUpgrade({ root: ws, to: "v2.1.0", runChant: passing });
    try {
      expect(staged.written).toEqual(["README.md"]);
      expect(staged.migrations).toEqual([]);
    } finally {
      staged.dispose();
    }
  });

  test("moving to a template with migrations but no bridge is refused", async () => {
    release(up, "v2.0.0", {
      "README.md": "starter v2\n",
      ".chant/migrations/rename.json": JSON.stringify({
        id: "rename-app",
        from: { versions: ">=1.0.0 <2.0.0" },
        to: "2.0.0",
        body: { type: "declarative", steps: [{ op: "move", from: "src/app.ts", to: "src/main.ts" }] },
      }),
    });
    adoptLineage({ root: ws, from: fork });
    commit(ws, "adopt");
    await expect(stageUpgrade({ root: ws, source: up, to: "v2.0.0", runChant: passing })).rejects.toThrow(/needs a bridge migration/);
    await expect(stageUpgrade({ root: ws, source: up, runChant: passing })).rejects.toThrow(/needs --to/);
  });
});

describe("chant workspace versions", () => {
  test("reports each workspace's template and plugin versions, by family", () => {
    adoptLineage({ root: ws, from: fork });
    // A second member of the fork's family, adopted at an older tag, with other plugin versions.
    const ws2 = join(root, "ws2");
    copyAt(fork, "v1.0.0", ws2);
    git(ws2, ["init", "-q", "-b", "main"]);
    commit(ws2, "copied");
    adoptLineage({ root: ws2, from: fork });
    for (const [dir, version] of [
      [ws, "0.80.0"],
      [ws2, "0.79.0"],
    ] as const) {
      put(dir, "package.json", JSON.stringify({ dependencies: { "@intentius/chant": `^${version}`, "left-pad": "1" } }));
      put(dir, "node_modules/@intentius/chant/package.json", JSON.stringify({ name: "@intentius/chant", version }));
    }

    const report = workspaceVersions(root);
    expect(report.workspaces.map((w) => w.path)).toEqual(["ws", "ws2"]);
    expect(report.workspaces[0].scopes).toEqual([
      {
        scope: ".",
        kind: "template",
        template: fork,
        ref: "v1.1.0",
        version: "1.1.0",
        commit: git(fork, ["rev-parse", "v1.1.0^{commit}"]),
        migrations: 0,
        provenance: "adopted",
      },
    ]);
    expect(report.workspaces[0].plugins).toEqual([{ name: "@intentius/chant", declared: "^0.80.0", installed: "0.80.0" }]);
    expect(report.families).toEqual([
      {
        template: fork,
        newest: "1.1.0",
        members: [
          { path: "ws", scope: ".", ref: "v1.1.0", version: "1.1.0", behind: false },
          { path: "ws2", scope: ".", ref: "v1.0.0", version: "1.0.0", behind: true },
        ],
      },
    ]);
    expect(report.pluginSpread).toEqual([{ template: fork, name: "@intentius/chant", versions: { "0.80.0": ["ws"], "0.79.0": ["ws2"] } }]);

    // Narrowed to a template no workspace uses, the report is empty.
    expect(workspaceVersions(root, "github.com/nobody/nothing").workspaces).toEqual([]);
  });
});
