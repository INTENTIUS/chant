/**
 * Org scope (#3168): a member of kind repo names another repository's
 * workspace by URL and pinned revision, read read-only through that
 * repository's own read contract; an org workspace holds only such members;
 * `chant workspace check --forge-repos` compares them with the forge's list;
 * and the read contract's identity names the repository a document came
 * from. Every remote here is a local bare repository: nothing reaches a forge.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "./checks";
import { parseForgeRepos, repoKey, urlCredential } from "./checks/org";
import { readDeclaration, repoMemberDir } from "./declaration";
import { workspaceGraph } from "./graph-cli";
import { listWorkspace } from "./ls";
import { fetchRepoAt, redactUrl, repoIdentity } from "./repo-ref";
import { workingTree } from "./tree";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix = "chant-3168-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(d);
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" }).trim();
function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A repository with a workspace, pushed to a local bare remote. Returns the bare URL and the commit. */
function remoteWorkspace(name: string): { url: string; rev: string } {
  const work = tmp();
  git(work, "init", "-q", "-b", "main");
  write(work, { "chant.workspace.json": JSON.stringify({ name, schema: 1, members: [{ name: "docs", dir: "docs", kind: "other", because: "prose" }] }), "docs/README.md": "" });
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "init");
  const bare = join(tmp(), `${name}.git`);
  git(work, "clone", "-q", "--bare", work, bare);
  return { url: bare, rev: git(work, "rev-parse", "HEAD") };
}

/** An org workspace in a git repository of its own, with origin set. */
function orgWorkspace(members: unknown[], extra: Record<string, unknown> = {}): string {
  const root = tmp();
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", "https://bot:secret@forge.example/acme/org.git");
  write(root, { "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, scope: "org", members, ...extra }) });
  return root;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const repoMember = (name: string, url: string, rev = SHA) => ({ name, kind: "repo", repo: { url, rev } });

describe("the declaration: repo members and scope", () => {
  test("a repo member has repo and no dir, and reads with a marker dir", () => {
    const root = orgWorkspace([repoMember("chant", "https://github.com/INTENTIUS/chant"), { ...repoMember("ops", "git@github.com:INTENTIUS/ops.git"), repo: { url: "git@github.com:INTENTIUS/ops.git", rev: SHA, workspace: "infra" } }]);
    const d = readDeclaration(workingTree(root));
    expect(d.scope).toBe("org");
    expect(d.members.map((m) => [m.dir, m.repo])).toEqual([
      [repoMemberDir("chant"), { url: "https://github.com/INTENTIUS/chant", rev: SHA, workspace: "." }],
      [repoMemberDir("ops"), { url: "git@github.com:INTENTIUS/ops.git", rev: SHA, workspace: "infra" }],
    ]);
  });

  test("refuses a repo member with a dir, another kind with repo, and a revision that isn't a full commit id", () => {
    const read = (members: unknown[]) => () => readDeclaration(workingTree(orgWorkspace(members)));
    expect(read([{ ...repoMember("a", "x"), dir: "a" }])).toThrow(/a member of kind repo has no dir/);
    expect(read([{ name: "a", dir: "a", kind: "other", because: "x", repo: { url: "x", rev: SHA } }])).toThrow(/only a member of kind repo has repo/);
    expect(read([repoMember("a", "x", "main")])).toThrow(/"main" is not allowed here/);
    expect(read([{ name: "a", kind: "repo" }])).toThrow(/needs "repo"/);
  });
});

describe("repoKey and credentials", () => {
  test("https, ssh and scp-style URLs of one repository compare equal", () => {
    const keys = ["https://github.com/INTENTIUS/Chant.git", "https://github.com/intentius/chant/", "git@github.com:INTENTIUS/chant.git", "ssh://git@github.com/INTENTIUS/chant"].map((u) => repoKey(u));
    expect(new Set(keys)).toEqual(new Set(["github.com/intentius/chant"]));
    expect(repoKey("./x.git", "/base")).toBe("/base/x");
    expect(repoKey("file:///srv/x.git")).toBe("/srv/x");
  });

  test("a password, or a user on https, is a credential; ssh's git user is not", () => {
    expect(urlCredential("https://bot:tok@forge.example/a/b")).toBe(true);
    expect(urlCredential("https://tok@forge.example/a/b")).toBe(true);
    expect(urlCredential("ssh://git@forge.example/a/b")).toBe(false);
    expect(urlCredential("git@forge.example:a/b")).toBe(false);
    expect(redactUrl("https://bot:tok@forge.example/a/b")).toBe("https://forge.example/a/b");
  });
});

describe("parseForgeRepos", () => {
  test("reads an object with repos, a bare array, strings and objects", () => {
    expect(parseForgeRepos(JSON.stringify({ forge: "github", org: "acme", repos: ["https://f/a/x", { url: "https://f/a/y", archived: true }] }), "f.json").repos).toEqual([
      { url: "https://f/a/x", archived: false },
      { url: "https://f/a/y", archived: true },
    ]);
    expect(parseForgeRepos(JSON.stringify(["https://f/a/x"]), "f.json").repos).toHaveLength(1);
    expect(() => parseForgeRepos("{}", "f.json")).toThrow(/repos array/);
    expect(() => parseForgeRepos("[1]", "f.json")).toThrow(/repos\[0\]/);
    expect(() => parseForgeRepos("nope", "f.json")).toThrow(/not JSON/);
  });
});

describe("chant workspace check on an org workspace", () => {
  const ids = async (root: string, forge?: unknown) =>
    (await runDeclarationChecks(root, (f) => f, forge ? { forgeRepos: parseForgeRepos(JSON.stringify(forge), "forge.json") } : {})).diagnostics
      .filter((d) => /^WSP0(0[1-9]|1[0-6])$/.test(d.ruleId))
      .map((d) => `${d.ruleId}:${d.entity ?? ""}`);

  test("repo members need no directory: no WSP004, and nothing else fires", async () => {
    expect(await ids(orgWorkspace([repoMember("a", "https://forge.example/acme/a")]))).toEqual([]);
  });

  test("WSP013: an org workspace holds only repo members", async () => {
    const root = orgWorkspace([repoMember("a", "https://forge.example/acme/a"), { name: "docs", dir: "docs", kind: "other", because: "x" }]);
    mkdirSync(join(root, "docs"));
    expect(await ids(root)).toContain("WSP013:docs");
  });

  test("WSP014 names a repository the forge has and the declaration lacks; WSP015 one the forge dropped; archived ones need not be declared", async () => {
    const root = orgWorkspace([repoMember("a", "git@forge.example:acme/a.git"), repoMember("gone", "https://forge.example/acme/gone")]);
    const forge = { repos: ["https://forge.example/acme/a", "https://forge.example/acme/new", { url: "https://forge.example/acme/old", archived: true }] };
    const report = await runDeclarationChecks(root, (f) => f, { forgeRepos: parseForgeRepos(JSON.stringify(forge), "forge.json") });
    const found = report.diagnostics.filter((d) => d.ruleId === "WSP014" || d.ruleId === "WSP015").map((d) => `${d.ruleId}: ${d.message}`);
    expect(found).toEqual([
      expect.stringMatching(/^WSP014: the forge lists https:\/\/forge.example\/acme\/new \(forge.json\), and no repo member names it/),
      expect.stringMatching(/^WSP015: member gone names https:\/\/forge.example\/acme\/gone, which the forge no longer lists/),
    ]);
    expect(report.ok).toBe(false);
    // Without the list, neither runs: check never asks the forge.
    expect(await ids(root)).toEqual([]);
  });

  test("WSP016: a repo url never carries a credential", async () => {
    expect(await ids(orgWorkspace([repoMember("a", "https://bot:tok@forge.example/acme/a")]))).toEqual(["WSP016:a"]);
  });
});

describe("the read contract's identity names the repository", () => {
  test("ls prints workspace.repo, redacted, and each repo member's reference", () => {
    const root = orgWorkspace([repoMember("a", "https://forge.example/acme/a")]);
    const doc = listWorkspace({ cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.workspace.repo).toBe("https://forge.example/acme/org.git");
    expect(doc.members[0]).toMatchObject({ name: "a", kind: "repo", readable: true, reason: null, repo: { url: "https://forge.example/acme/a", rev: SHA, workspace: "." } });
  });

  test("is null without an origin, or outside git", () => {
    const plain = tmp();
    git(plain, "init", "-q");
    expect(repoIdentity(plain)).toBeNull();
    expect(repoIdentity(tmp())).toBeNull();
  });
});

describe("fetching a repo member's revision into the cache", () => {
  test("fetches the pinned commit from a local bare remote into the user cache, once, and reports a commit it lacks", () => {
    const remote = remoteWorkspace("payments");
    const cache = tmp("chant-3168-cache-");
    const env = { ...process.env, CHANT_CACHE_DIR: cache };
    const first = fetchRepoAt({ url: remote.url, rev: remote.rev, workspace: "." }, "/", env);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.dir.startsWith(join(cache, "repos"))).toBe(true);
    expect(JSON.parse(readFileSync(join(first.dir, "chant.workspace.json"), "utf-8")).name).toBe("payments");
    expect(git(first.dir, "rev-parse", "HEAD")).toBe(remote.rev);
    expect(fetchRepoAt({ url: remote.url, rev: remote.rev, workspace: "." }, "/", env)).toEqual(first);
    const missing = fetchRepoAt({ url: remote.url, rev: SHA, workspace: "." }, "/", env);
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining(SHA) });
  });
});

describe("chant workspace graph reads a repo member through its own read contract", () => {
  test("runs the other repository's workspace graph at the pinned revision and folds it in, writing nothing in the workspace", async () => {
    const remote = remoteWorkspace("payments");
    const root = orgWorkspace([repoMember("payments", remote.url, remote.rev)]);
    // A stand-in for the other repository's chant: it prints a graph document of the contract, with its argv and identity.
    const bin = join(tmp(), "fake-chant.mjs");
    writeFileSync(
      bin,
      `import { execFileSync } from "node:child_process";
const argv = process.argv.slice(2);
const at = argv[argv.indexOf("--at") + 1];
const repo = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf-8" }).trim();
const member = { name: "docs", dir: "docs", kind: "other", status: "composed", reason: null, chant: "9.9.9", irVersion: 1, live: false };
console.log(JSON.stringify({ $schema: "https://intentius.io/chant/schemas/workspace/graph/v1/graph.schema.json", contract: 1, chant: "9.9.9", at, version: 1,
  workspace: { name: "payments", root: ".", repo }, members: [member],
  nodes: [{ id: "docs/Page", kind: "Page", lexicon: "x", attrs: {}, member: "docs" }], edges: [], groups: { byMember: { docs: ["docs/Page"] } },
  exports: [], imports: [], links: [], collectors: [], records: [] }));
`,
    );
    const cache = tmp("chant-3168-cache-");
    const before = process.env.CHANT_CACHE_DIR;
    process.env.CHANT_CACHE_DIR = cache;
    try {
      const { doc } = await workspaceGraph({ cwd: root, reader: { command: [process.execPath, bin], identity: bin, source: "path" } as never });
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.workspace).toMatchObject({ name: "acme", repo: "https://forge.example/acme/org.git" });
      const m = doc.members.find((x) => x.name === "payments")!;
      expect(m).toMatchObject({ kind: "repo", status: "composed", repo: { url: remote.url, rev: remote.rev, workspace: ".", read: remote.url } });
      expect(m.nested?.name).toBe("payments");
      expect(m.nested?.members.map((x) => x.name)).toEqual(["docs"]);
      expect(doc.nodes.map((n) => n.id)).toEqual(["payments/docs/Page"]);
      expect(existsSync(join(root, "@repo"))).toBe(false);
      expect(git(root, "status", "--porcelain")).toBe("?? chant.workspace.json");
    } finally {
      if (before === undefined) delete process.env.CHANT_CACHE_DIR;
      else process.env.CHANT_CACHE_DIR = before;
    }
  });

  test("a revision the remote lacks fails the member with command-failed", async () => {
    const remote = remoteWorkspace("payments");
    const root = orgWorkspace([repoMember("payments", remote.url, SHA)]);
    const before = process.env.CHANT_CACHE_DIR;
    process.env.CHANT_CACHE_DIR = tmp("chant-3168-cache-");
    try {
      const { doc, failed } = await workspaceGraph({ cwd: root, reader: { command: ["false"], identity: "false", source: "path" } as never });
      if ("error" in doc) throw new Error(doc.error.message);
      expect(failed).toBe(true);
      expect(doc.members[0]).toMatchObject({ status: "failed", reason: { code: "command-failed", message: expect.stringContaining(SHA) } });
    } finally {
      if (before === undefined) delete process.env.CHANT_CACHE_DIR;
      else process.env.CHANT_CACHE_DIR = before;
    }
  });
});
