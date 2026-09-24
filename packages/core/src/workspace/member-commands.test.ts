/**
 * Planning the per-member commands (#2537): which projects run, under which
 * chant, and what a root `build` or `lint` does. No chant is spawned here;
 * `member-commands.e2e.test.ts` runs the real CLI.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ParsedArgs } from "../cli/registry";
import { WorkspaceReadError } from "./declaration";
import { buildOutputPath, memberArgv, parseMemberRunOutput, planMembers, resolveToolchain, type Toolchain } from "./member-commands";
import { captureRun, PROTOCOL_PREFIX } from "./member-run";
import { decideRootCommand } from "./root-refusal";

const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-members-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    if (path.endsWith(".bin/chant")) chmodSync(join(root, path), 0o755);
  }
  return root;
}

const CONFIG = 'export default { lexicons: ["k8s"] };\n';
const declaration = (members: unknown[]) => JSON.stringify({ name: "acme", schema: 1, members });
const reader: Toolchain = { command: ["/opt/reader/chant"], identity: "/opt/reader/chant", source: "reader" };

const acme = () =>
  tree({
    "chant.workspace.json": declaration([
      { name: "platform", dir: ".", kind: "chant" },
      { name: "api", dir: "services/api", kind: "chant" },
      { name: "web", dir: "services/web", kind: "chant" },
      { name: "legacy", dir: "legacy", kind: "chant" },
      { name: "docs", dir: "docs", kind: "other", because: "markdown" },
      { name: "gone", dir: "gone", kind: "chant" },
      { name: "examples", kind: "examples", glob: "examples/*" },
    ]),
    "chant.config.ts": CONFIG,
    "services/api/chant.config.ts": CONFIG,
    "services/web/chant.config.ts": CONFIG,
    "services/node_modules/.bin/chant": "#!/bin/sh\n",
    "legacy/chant.config.ts": CONFIG,
    "legacy/node_modules/.bin/chant": "#!/bin/sh\n",
    "docs/README.md": "# docs\n",
    "examples/demo/chant.config.ts": CONFIG,
    "examples/notes/README.md": "not a project\n",
  });

describe("planMembers", () => {
  const root = acme();

  test("runs chant members and example matches for build, one group per toolchain", () => {
    const plan = planMembers("build", root, { reader });
    expect(plan.groups.map((g) => [g.toolchain.source, g.units.map((u) => u.id)])).toEqual([
      ["reader", ["platform", "examples:examples/demo"]],
      ["member", ["api", "web"]],
      ["member", ["legacy"]],
    ]);
    expect(plan.groups[1].toolchain.identity).toBe(join(root, "services/node_modules/.bin/chant"));
    expect(plan.skipped.map((s) => [s.name, s.reason.code])).toEqual([["docs", "kind-not-run"]]);
    expect(plan.unreadable.map((s) => [s.name, s.reason.code])).toEqual([["gone", "dir-missing"]]);
  });

  test("leaves the other members and the group matches out of member `.`", () => {
    const platform = planMembers("lint", root, { reader }).groups[0].units[0];
    expect(platform.dir).toBe(".");
    expect(platform.exclude).toEqual(["docs", "examples/demo", "gone", "legacy", "services/api", "services/web"]);
  });

  test("leaves example groups out of audit and graph", () => {
    for (const verb of ["audit", "graph"] as const) {
      const plan = planMembers(verb, root, { reader });
      expect(plan.groups.flatMap((g) => g.units.map((u) => u.id)).sort(), verb).toEqual(["api", "legacy", "platform", "web"]);
      expect(plan.skipped.map((s) => s.name), verb).toEqual(["docs", "examples"]);
    }
  });

  test("--member narrows the run, and an unknown name is an error", () => {
    const plan = planMembers("build", root, { reader, only: ["api", "examples"] });
    expect(plan.groups.flatMap((g) => g.units.map((u) => u.id))).toEqual(["api", "examples:examples/demo"]);
    expect(() => planMembers("build", root, { reader, only: ["nope"] })).toThrow(WorkspaceReadError);
  });
});

describe("resolveToolchain", () => {
  const root = acme();

  test("walks up from the member to the root, and falls back to the reader", () => {
    expect(resolveToolchain(join(root, "services/api"), root, reader).source).toBe("member");
    expect(resolveToolchain(join(root, "docs"), root, reader)).toEqual(reader);
  });

  test("uses the root's chant for a member with none, and starts the reader's own chant the reader's way", () => {
    const withRootBin = tree({ "node_modules/.bin/chant": "#!/bin/sh\n", "a/chant.config.ts": CONFIG });
    const tc = resolveToolchain(join(withRootBin, "a"), withRootBin, reader);
    expect(tc).toMatchObject({ source: "root", command: [join(withRootBin, "node_modules/.bin/chant")] });
    const same = resolveToolchain(join(withRootBin, "a"), withRootBin, { ...reader, identity: tc.identity });
    expect(same).toEqual({ ...reader, identity: tc.identity, source: "root" });
  });
});

describe("the chant repo's own declaration (#2557)", () => {
  test("declares no chant members, so build runs the example groups under one toolchain", () => {
    const plan = planMembers("build", REPO);
    expect(plan.workspace.name).toBe("chant");
    expect(plan.unreadable).toEqual([]);
    expect(plan.groups).toHaveLength(1);
    const units = plan.groups[0].units;
    expect(units.every((u) => u.group)).toBe(true);
    expect(units.map((u) => u.id)).toContain("fixtures:test/leftness");
    expect(plan.skipped.every((s) => s.reason.code === "kind-not-run")).toBe(true);
    expect(plan.skipped.map((s) => s.name)).toContain("core");
  });

  test("graph and audit run nothing there: every member is kind other", () => {
    for (const verb of ["graph", "audit"] as const) {
      const plan = planMembers(verb, REPO);
      expect(plan.groups, verb).toEqual([]);
    }
  });

  test("--member fixtures picks the two test fixtures", () => {
    const plan = planMembers("lint", REPO, { only: ["fixtures"] });
    expect(plan.groups.flatMap((g) => g.units.map((u) => u.dir))).toEqual(["test/forgejo-preview-e2e", "test/leftness"]);
  });
});

describe("member command lines", () => {
  const args = (over: Partial<ParsedArgs>): ParsedArgs => ({ command: "workspace", path: "build", format: "", ...over }) as ParsedArgs;
  const unit = { id: "api", member: "api", kind: "chant", group: false, dir: "services/api", abs: "/w/services/api", exclude: [] };
  const match = { ...unit, id: "examples:examples/demo", member: "examples", group: true, dir: "examples/demo" };

  test("build keeps the member's default format and writes -o per member", () => {
    expect(memberArgv("build", unit, args({}))).toEqual(["build", "."]);
    expect(memberArgv("build", unit, args({ output: "/out", env: "prod", param: ["a=b"] }))).toEqual([
      "build", ".", "--env", "prod", "--param", "a=b", "--output", "/out/api.json",
    ]);
    expect(buildOutputPath("/out", match, "yaml")).toBe("/out/examples/examples/demo.yaml");
  });

  test("lint asks each member for the format the workspace prints, audit always for JSON, graph for the IR", () => {
    expect(memberArgv("lint", unit, args({ format: "sarif" }))).toEqual(["lint", ".", "--format", "sarif"]);
    expect(memberArgv("lint", unit, args({}))).toEqual(["lint", ".", "--format", "stylish"]);
    expect(memberArgv("audit", unit, args({ failOn: "error" }))).toEqual(["audit", ".", "--format", "json", "--fail-on", "error"]);
    expect(memberArgv("graph", unit, args({ format: "mermaid" }))).toEqual(["graph", ".", "--format", "ir"]);
  });
});

describe("the member-run protocol", () => {
  test("an answer with no header is an old chant", () => {
    expect(parseMemberRunOutput("Error: Unknown workspace subcommand: member-run\n")).toBeUndefined();
  });

  test("results after the header are read, and anything else is stray output", () => {
    const text = [
      `${PROTOCOL_PREFIX}${JSON.stringify({ type: "header", protocol: 1, chant: "9.9.9" })}`,
      "a stray line",
      `${PROTOCOL_PREFIX}${JSON.stringify({ type: "result", id: "api", exitCode: 0, stdout: "x", stderr: "" })}`,
    ].join("\n");
    const parsed = parseMemberRunOutput(text)!;
    expect(parsed.chant).toBe("9.9.9");
    expect(parsed.results.get("api")).toMatchObject({ exitCode: 0, stdout: "x" });
    expect(parsed.stray).toBe("a stray line");
  });

  // The CLI prints through console, which writes through these streams. vitest
  // replaces console in a test, so the test writes to the streams directly.
  test("captureRun keeps a command's output and turns process.exit into its exit code", async () => {
    const r = await captureRun(async () => {
      process.stdout.write("to stdout\n");
      process.stderr.write("to stderr\n");
      process.exit(3);
    });
    expect(r).toEqual({ exitCode: 3, stdout: "to stdout\n", stderr: "to stderr\n" });
  });
});

describe("decideRootCommand", () => {
  const root = acme();
  const decide = (target: string, rootOnly = false) => decideRootCommand({ verb: "build", target, workspaceDir: root, rootOnly });

  test("refuses at the root with WSP000, pointing to the workspace command", () => {
    const d = decide(root);
    expect(d.action).toBe("refuse");
    expect(d.action === "refuse" && d.message).toMatch(/^WSP000: .*chant workspace build.*--root-only.*rootOnly: true/);
  });

  test("with root-only, runs the root project without the members", () => {
    expect(decide(root, true)).toEqual({
      action: "root-only",
      excluded: ["docs", "examples/demo", "gone", "legacy", "services/api", "services/web"],
    });
  });

  test("leaves a target inside a member or a group match alone", () => {
    expect(decide(join(root, "docs"))).toEqual({ action: "not-root" });
    expect(decide(join(root, "examples/demo/src"))).toEqual({ action: "not-root" });
  });

  test("still refuses when the declaration can't be read", () => {
    const broken = tree({ "chant.workspace.json": "{ nope", "chant.config.ts": CONFIG });
    const d = decideRootCommand({ verb: "lint", target: broken, workspaceDir: broken, rootOnly: true });
    expect(d.action === "refuse" && d.message).toMatch(/^WSP000: .*declaration-unparseable/);
  });
});
