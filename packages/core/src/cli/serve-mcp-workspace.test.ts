import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * #2700 — `chant serve mcp` at a workspace root whose lexicons all live in
 * members starts, with core's tools and the chant members' lexicons, instead
 * of refusing with "No lexicon detected". A project with no workspace and no
 * lexicon still refuses.
 *
 * #2701 — `chant --version` and `-V` print the installed version.
 */

const repoRoot = resolve(import.meta.dirname, "../../../..");
const mainTs = join(repoRoot, "packages/core/src/cli/main.ts");
const tsxLoader = pathToFileURL(join(repoRoot, "node_modules/tsx/dist/loader.mjs")).href;
const TIMEOUT = 90_000;

function chant(cwd: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", tsxLoader, mainTs, ...args], {
    cwd,
    input,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

interface InitializeResult {
  serverInfo: { name: string; version: string };
  instructions?: string;
}

/** Send initialize and tools/list over stdio; stdin closing ends the server. */
function initializeAndList(cwd: string): { status: number | null; stderr: string; init: InitializeResult; tools: string[] } {
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map((m) => JSON.stringify(m)).join("\n") + "\n";
  const run = chant(cwd, ["serve", "mcp"], input);
  const responses = run.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const byId = (id: number) => responses.find((r) => r.id === id);
  return {
    status: run.status,
    stderr: run.stderr,
    init: byId(1)?.result,
    tools: (byId(2)?.result?.tools ?? []).map((t: { name: string }) => t.name),
  };
}

const CORE_TOOLS = ["composites", "search", "build", "lint", "explain", "op-list", "op-run", "op-status", "op-approve", "op-report"];

describe("chant serve mcp at a workspace root with no lexicon of its own (#2700)", () => {
  let scratch: string;

  beforeAll(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "chant-serve-mcp-ws-")));
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("the reference workspace root answers initialize and lists core tools with the delivery member's lexicon", () => {
    const { status, stderr, init, tools } = initializeAndList(join(repoRoot, "reference-workspace"));
    expect(status, stderr).toBe(0);
    expect(init.serverInfo.name).toBe("chant");
    for (const name of CORE_TOOLS) expect(tools).toContain(name);
    expect(tools).toContain("docker:diff");
    expect(init.instructions).toContain("Member delivery (delivery/) declares docker.");
  }, TIMEOUT);

  test("a lexiconless root, lexicons only in a member, serves core and the lexicons that load", () => {
    const root = join(scratch, "lexiconless-shaped");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "delivery"), { recursive: true });
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({
      name: "t",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "other", because: "an app" },
        { name: "delivery", dir: "delivery", kind: "chant" },
      ],
      pins: [],
    }));
    // `acme` names a lexicon package that isn't installed here: it is named
    // as not loaded and the rest is served.
    writeFileSync(join(root, "delivery", "chant.config.ts"), 'export default { lexicons: ["docker", "acme"] };\n');
    writeFileSync(join(root, "app", "server.js"), "// not chant\n");

    const { status, stderr, init, tools } = initializeAndList(root);
    expect(status, stderr).toBe(0);
    for (const name of CORE_TOOLS) expect(tools).toContain(name);
    expect(tools).toContain("docker:diff");
    expect(init.instructions).toContain('workspace "t"');
    expect(init.instructions).toContain("Lexicon acme did not load");
    expect(init.instructions).toContain("Lexicon tools and resources served: docker.");
  }, TIMEOUT);

  test("a workspace root whose members' lexicons all fail to load serves core alone and says so", () => {
    const root = join(scratch, "core-only");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "delivery"), { recursive: true });
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({
      name: "core-only",
      schema: 1,
      members: [{ name: "delivery", dir: "delivery", kind: "chant" }],
      pins: [],
    }));
    writeFileSync(join(root, "delivery", "chant.config.ts"), 'export default { lexicons: ["no-such-lexicon"] };\n');

    const { status, stderr, init, tools } = initializeAndList(root);
    expect(status, stderr).toBe(0);
    for (const name of CORE_TOOLS) expect(tools).toContain(name);
    expect(tools.filter((t) => t.includes(":"))).toEqual([]);
    expect(init.instructions).toContain("only chant's core tools and resources are served");
  }, TIMEOUT);

  test("a project with no workspace and no lexicon still refuses", () => {
    const root = join(scratch, "plain");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "index.ts"), "export const x = 1;\n");
    const run = chant(root, ["serve", "mcp"], "");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("No lexicon detected");
    expect(run.stdout).toBe("");
  }, TIMEOUT);
});

describe("chant --version (#2701)", () => {
  const version = (JSON.parse(readFileSync(join(repoRoot, "packages/core/package.json"), "utf-8")) as { version: string }).version;

  test.each([["--version"], ["-V"]])("%s prints the package version and exits 0", (flag) => {
    const run = chant(repoRoot, [flag]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe(version);
  }, TIMEOUT);
});
