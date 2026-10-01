/**
 * chant #2551 — read-only nested workspaces: the nested read's document is
 * checked against the read contract, folded into the outer graph with
 * `outer/inner/id` ids, and the outer upgrade never writes inside a nested
 * workspace. The real read against the reference workspace is in
 * read-contract.test.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { composeWorkspaceGraph, type ComposedMember, type WorkspaceGraph } from "./compose-graph";
import { emptyLock, fileEntries, writeLock } from "./lineage-lock";
import { stageUpgrade } from "./lineage-upgrade";
import { foldNested, nestedArgv, readNestedDocument } from "./nested-graph";
import { nestedWorkspaces, pathsInsideNested } from "./nesting";

const SCHEMA = "https://intentius.io/chant/schemas/workspace/graph/v1/graph.schema.json";

function member(name: string, over: Partial<ComposedMember> = {}): ComposedMember {
  return { name, dir: name, kind: "chant", status: "composed", reason: null, chant: "1.0.0", irVersion: 1, live: false, ...over };
}

function innerGraph(): WorkspaceGraph & { contract: number } {
  return {
    contract: 1,
    version: 1,
    workspace: { name: "inner", root: "." },
    members: [member("api", { dir: "services/api" }), member("docs", { kind: "other", status: "skipped", reason: { code: "kind-not-run", message: "other" } })],
    nodes: [
      { id: "api/Queue", kind: "Queue", lexicon: "aws", attrs: { dlq: { $ref: "api/Dlq" } }, member: "api", sourceLoc: { file: "src/q.ts", line: 3 } },
      { id: "api/Dlq", kind: "Queue", lexicon: "aws", attrs: {}, member: "api", compositeInstance: "api/Pair" },
    ],
    edges: [{ from: "api/Queue", to: "api/Dlq", member: "api" } as WorkspaceGraph["edges"][number]],
    groups: { byMember: { api: ["api/Dlq", "api/Queue"], docs: [] }, byLexicon: { aws: ["api/Dlq", "api/Queue"] }, byStack: { "api/main": ["api/Queue"] } },
    exports: [{ name: "queueArn", node: "api/Queue", attr: "Arn", member: "api" } as WorkspaceGraph["exports"][number]],
    imports: [],
    links: [],
    collectors: [],
    records: [],
  };
}

describe("readNestedDocument", () => {
  test("accepts a graph document of the contract this chant reads", () => {
    const r = readNestedDocument(JSON.stringify({ $schema: SCHEMA, chant: "1.2.3", ...innerGraph() }), 0, "", SCHEMA, 1);
    expect(r).toMatchObject({ ok: true, chant: "1.2.3" });
  });

  test("refuses no JSON, another document, a newer contract and an error document, each with a reason code", () => {
    expect(readNestedDocument("boom", 1, "line\nlast line", SCHEMA, 1)).toMatchObject({ ok: false, code: "command-failed", message: expect.stringContaining("last line") });
    expect(readNestedDocument("{}", 0, "", SCHEMA, 1)).toMatchObject({ ok: false, code: "output-unreadable" });
    expect(readNestedDocument(JSON.stringify({ $schema: SCHEMA, contract: 2, chant: "9.0.0" }), 0, "", SCHEMA, 1)).toMatchObject({
      ok: false,
      code: "ir-version-unsupported",
      chant: "9.0.0",
    });
    expect(readNestedDocument(JSON.stringify({ $schema: SCHEMA, contract: 1, error: { code: "declaration-missing", message: "none" } }), 1, "", SCHEMA, 1)).toMatchObject({
      ok: false,
      code: "command-failed",
      message: expect.stringContaining("declaration-missing"),
    });
  });

  test("passes the read flags on, and never a write", () => {
    expect(nestedArgv("/w/inner", { env: "dev", live: true, overlay: true, traffic: "10 rps", noCache: true, output: "x.json" }, "abc")).toEqual([
      "workspace", "graph", "/w/inner", "--at", "abc", "--env", "dev", "--live", "--overlay", "--traffic", "10 rps", "--no-cache",
    ]);
  });
});

describe("foldNested", () => {
  test("prefixes every id with the outer member, keeps the nested member on each node, and fills the member entry", () => {
    const outer = composeWorkspaceGraph({ name: "outer", root: "." }, [
      { member: member("platform", { kind: "workspace", status: "skipped", reason: { code: "kind-not-run", message: "nested" }, chant: null, irVersion: null }) },
    ]);
    const entry = outer.members[0];
    foldNested(outer, entry, innerGraph());
    expect(outer.nodes.map((n) => [n.id, n.member, n.nested])).toEqual([
      ["platform/api/Dlq", "platform", "api"],
      ["platform/api/Queue", "platform", "api"],
    ]);
    const queue = outer.nodes.find((n) => n.id === "platform/api/Queue")!;
    expect(queue.attrs).toEqual({ dlq: { $ref: "platform/api/Dlq" } });
    // sourceLoc is relative to the outer member's directory, the nested root.
    expect(queue.sourceLoc).toEqual({ file: "services/api/src/q.ts", line: 3 });
    expect(outer.nodes.find((n) => n.id === "platform/api/Dlq")!.compositeInstance).toBe("platform/api/Pair");
    expect(outer.edges).toEqual([{ from: "platform/api/Queue", to: "platform/api/Dlq", member: "platform" }]);
    expect(outer.exports).toEqual([{ name: "queueArn", node: "platform/api/Queue", attr: "Arn", member: "platform" }]);
    expect(outer.groups.byMember.platform).toEqual(["platform/api/Dlq", "platform/api/Queue"]);
    expect(outer.groups.byLexicon).toEqual({ aws: ["platform/api/Dlq", "platform/api/Queue"] });
    expect(outer.groups.byStack).toEqual({ "platform/api/main": ["platform/api/Queue"] });
    expect(entry).toMatchObject({ status: "composed", reason: null, nested: { name: "inner", contract: 1, links: [] } });
    expect(entry.nested!.members.map((m) => m.name)).toEqual(["api", "docs"]);
  });
});

describe("the outer workspace never writes inside a nested one", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  const put = (base: string, rel: string, text: string) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  };

  test("finds nested members, and the paths inside them", () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-nesting-")));
    put(root, "chant.workspace.json", JSON.stringify({ name: "outer", schema: 1, members: [{ name: "kit", dir: "vendor/kit", kind: "workspace" }, { name: "docs", dir: "docs", kind: "other", because: "prose" }] }));
    put(root, "vendor/kit/chant.workspace.json", JSON.stringify({ name: "kit", schema: 1, members: [] }));
    mkdirSync(join(root, "docs"));
    expect(nestedWorkspaces(root)).toEqual([{ name: "kit", dir: "vendor/kit" }]);
    expect(pathsInsideNested(root, "", ["docs/a.md", "vendor/kit/x.ts", "vendor/kitten.ts"])).toEqual([{ member: "kit", path: "vendor/kit/x.ts" }]);
    expect(pathsInsideNested(root, "infra", ["infra/vendor/kit/x.ts", "vendor/kit/x.ts"])).toEqual([{ member: "kit", path: "infra/vendor/kit/x.ts" }]);
    expect(nestedWorkspaces(join(root, "docs"))).toEqual([]);
  });

  test("an upgrade whose patch reaches into a nested workspace is refused", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-nesting-")));
    const tpl = join(root, "tpl");
    const ws = join(root, "ws");
    mkdirSync(tpl);
    git(tpl, ["init", "-q", "-b", "main"]);
    put(tpl, "README.md", "one\n");
    put(tpl, "kit/settings.json", "{}\n");
    git(tpl, ["add", "-A"]);
    git(tpl, ["commit", "-q", "-m", "v1"]);
    git(tpl, ["tag", "v1.0.0"]);
    put(tpl, "kit/settings.json", '{ "v": 2 }\n');
    git(tpl, ["commit", "-q", "-am", "v2"]);
    git(tpl, ["tag", "v2.0.0"]);

    mkdirSync(ws);
    git(ws, ["init", "-q", "-b", "main"]);
    put(ws, "README.md", "one\n");
    put(ws, "kit/settings.json", "{}\n");
    put(ws, "kit/chant.workspace.json", JSON.stringify({ name: "kit", schema: 1, members: [] }));
    put(ws, "chant.workspace.json", JSON.stringify({ name: "outer", schema: 1, members: [{ name: "kit", dir: "kit", kind: "workspace" }] }));
    const lock = emptyLock();
    const files = new Map([
      ["README.md", Buffer.from("one\n")],
      ["kit/settings.json", Buffer.from("{}\n")],
    ]);
    lock.scopes["."] = {
      kind: "template",
      template: tpl,
      source: { type: "git", repo: tpl, url: "../tpl" },
      ref: "v1.0.0",
      address: { digest: `sha256:${"0".repeat(64)}`, commit: git(tpl, ["rev-parse", "v1.0.0"]) },
      parameters: {},
      migrations: [],
      files: fileEntries(files),
      manualSteps: [],
    };
    writeLock(ws, lock);
    git(ws, ["add", "-A"]);
    git(ws, ["commit", "-q", "-m", "made"]);
    await expect(stageUpgrade({ root: ws, to: "v2.0.0", runChant: async () => ({ exitCode: 0, output: "" }) })).rejects.toThrow(
      /inside the nested workspace kit \(kit\/settings\.json\).*never writes inside it/,
    );
    // The refusal leaves no staging worktree behind.
    expect(git(ws, ["worktree", "list"]).split("\n")).toHaveLength(1);

    // Naming the nested member from the outer root is refused too: it upgrades itself.
    writeLock(join(ws, "kit"), lock);
    git(ws, ["add", "-A"]);
    git(ws, ["commit", "-q", "-m", "the nested workspace's own lock"]);
    await expect(stageUpgrade({ root: ws, scope: "kit", to: "v2.0.0", runChant: async () => ({ exitCode: 0, output: "" }) })).rejects.toThrow(
      /member "kit" is a nested workspace, which upgrades itself: run chant workspace upgrade in kit/,
    );
  });
});
