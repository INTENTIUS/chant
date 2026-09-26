/**
 * Which chant reads the declaration (#2536; #2524 D15, ws-021): the root's
 * chant, named by a `@intentius/chant` pin; without a pin, the reader's own
 * chant, if it meets `minReader`.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, declaration, REPO, repo } from "./__fixtures__/contract-repo";
import { readerVersion } from "./declaration";
import { workspaceGraph } from "./graph-cli";
import { runChecks } from "./lineage-check";
import { listWorkspace } from "./ls";
import { workspaceStatus } from "./status";
import { handToRootChant, HANDED_TO_ROOT_ENV, locateWorkspace, rootChantBin } from "./which-chant";

afterAll(cleanScratch);

const MAIN = join(REPO, "packages", "core", "src", "cli", "main.ts");
const LOADER = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;

/** An installed @intentius/chant at `version` whose bin reports how it was called, and exits 7. */
const installedChant = (version: string) => ({
  "node_modules/@intentius/chant/package.json": JSON.stringify({ name: "@intentius/chant", version, bin: { chant: "bin/chant" } }),
  "node_modules/@intentius/chant/bin/chant": { text: `#!/bin/sh\necho "root chant ${version}: $* ($${HANDED_TO_ROOT_ENV})"\nexit 7\n`, mode: 0o755 },
});

const pins = (version: string) => ({ pins: [{ package: "@intentius/chant", version }] });

/** The error code each read-contract command gives for the workspace at `cwd`, or "ok". */
async function codes(cwd: string): Promise<string[]> {
  const ls = listWorkspace({ cwd });
  const graph = (await workspaceGraph({ cwd })).doc;
  const status = await workspaceStatus({ cwd, env: "dev", readLedger: async () => ({ records: [], malformed: 0 }) });
  const check = await runChecks(cwd);
  const checkCode = "error" in check ? check.error.code : (check.declaration?.diagnostics.find((d) => d.ruleId === "WSP001")?.code ?? "ok");
  return [...[ls, graph, status].map((d) => ("error" in d ? d.error.code : "ok")), checkCode];
}

function chant(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", LOADER, MAIN, ...args], {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, TSX_DISABLE_CACHE: "1", NO_COLOR: "1", [HANDED_TO_ROOT_ENV]: "" },
  });
}

describe("a root that pins no chant", () => {
  test("the reader's own chant reads the declaration when it meets minReader", async () => {
    const root = repo({ "chant.workspace.json": declaration([], { minReader: readerVersion() }) });
    expect(await codes(root)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  test("and refuses with reader-too-old when it doesn't", async () => {
    const root = repo({ "chant.workspace.json": declaration([], { minReader: "999.0.0" }) });
    expect(await codes(root)).toEqual(["reader-too-old", "reader-too-old", "reader-too-old", "reader-too-old"]);
  });
});

describe("a root that pins a chant", () => {
  test("the pinned version reads it when it is this chant", async () => {
    const root = repo({ "chant.workspace.json": declaration([], pins(readerVersion())) });
    expect(await codes(root)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  test("any other chant refuses with root-chant-required, before minReader and the schema", async () => {
    const root = repo({ "chant.workspace.json": declaration([], { ...pins("0.0.1"), minReader: "999.0.0", "x-new": true, newField: 1 }) });
    expect(await codes(root)).toEqual(["root-chant-required", "root-chant-required", "root-chant-required", "root-chant-required"]);
    const ls = listWorkspace({ cwd: root });
    if (!("error" in ls)) throw new Error("expected a failure");
    expect(ls.error.message).toMatch(/pins @intentius\/chant 0\.0\.1, and this is chant .*install @intentius\/chant@0\.0\.1 at the workspace root/);
    expect(ls.error.location).toMatchObject({ file: "chant.workspace.json" });
  });

  test("the root's chant is the one installed there at the pinned version", () => {
    const root = repo({ "chant.workspace.json": declaration([], pins("0.0.1")), ...installedChant("0.0.1") });
    expect(rootChantBin(root, "0.0.1")).toBe(join(root, "node_modules", "@intentius", "chant", "bin", "chant"));
    expect(rootChantBin(root, "0.0.2")).toBeUndefined();
    expect(rootChantBin(repo({}), "0.0.1")).toBeUndefined();
  });

  test("handToRootChant runs the command under the root's chant, once at most", async () => {
    const root = repo({ "chant.workspace.json": declaration([], pins("0.0.1")), ...installedChant("0.0.1") });
    const saved = process.env[HANDED_TO_ROOT_ENV];
    delete process.env[HANDED_TO_ROOT_ENV];
    try {
      expect(await handToRootChant(root, undefined, ["workspace", "ls"])).toBe(7);
      // Not installed at the pinned version, or this chant is the pinned one: nothing to hand to.
      const other = repo({ "chant.workspace.json": declaration([], pins("0.0.2")), ...installedChant("0.0.1") });
      expect(await handToRootChant(other, undefined, ["workspace", "ls"])).toBeUndefined();
      const same = repo({ "chant.workspace.json": declaration([], pins(readerVersion())), ...installedChant("0.0.1") });
      expect(await handToRootChant(same, undefined, ["workspace", "ls"])).toBeUndefined();
      process.env[HANDED_TO_ROOT_ENV] = "0.0.1";
      expect(await handToRootChant(root, undefined, ["workspace", "ls"])).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[HANDED_TO_ROOT_ENV];
      else process.env[HANDED_TO_ROOT_ENV] = saved;
    }
  });

  test(
    "chant workspace ls, graph, check and status hand themselves to it, with --at reading the pin at the revision",
    () => {
      const root = repo({ "chant.workspace.json": declaration([], pins("0.0.1")), ...installedChant("0.0.1"), ".gitignore": "node_modules\n" }, true);
      for (const args of [["workspace", "ls", "--json"], ["workspace", "graph"], ["workspace", "check", "--json"], ["workspace", "status", "dev"], ["workspace", "ls", "--at", "HEAD"]]) {
        const r = chant(root, ...args);
        expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(7);
        expect(r.stdout.trim()).toBe(`root chant 0.0.1: ${args.join(" ")} (0.0.1)`);
      }
      expect(locateWorkspace(root, "HEAD").at).toMatch(/^[0-9a-f]{40}$/);
    },
    240_000,
  );
});
