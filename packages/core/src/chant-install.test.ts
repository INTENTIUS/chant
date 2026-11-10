/**
 * #4800 — the chant a product is installed with: this package itself, a
 * walk up `node_modules` for terragucci's layout, the argv and PATH a child
 * runs with, and plywood's resolve fallback for a repository with no chant.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  bareResolveFallback,
  bundledChant,
  CHANT_RUN_FLOOR,
  CHANT_SPECIFIER,
  chantArgv,
  chantCommand,
  chantEnv,
  chantResolveFallback,
  fallbackImportArgs,
  fallbackParent,
  hasNodeModulesAbove,
  installedChant,
  isBareSpecifier,
  lastJsonLine,
  runChant,
} from "./chant-install";

const scratch = mkdtempSync(join(tmpdir(), "chant-install-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A package directory with a manifest and, when `bin` is given, the bin file. */
function pkg(dir: string, manifest: Record<string, unknown>, bin?: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  if (bin) {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, bin), "#!/usr/bin/env node\n");
  }
  return dir;
}

describe("bundledChant", () => {
  test("is the package this module belongs to, with its bin and version", () => {
    const own = bundledChant();
    expect(own).toBeDefined();
    expect(own!.root).toBe(join(import.meta.dirname, ".."));
    expect(own!.bin).toBe(join(own!.root, "bin", "chant"));
    expect(own!.binDir).toBe(join(own!.root, "bin"));
    expect(own!.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("installedChant", () => {
  const product = join(scratch, "product");
  const root = pkg(join(product, "node_modules", "@intentius", "chant"), { name: "@intentius/chant", version: "1.2.3", bin: { chant: "./bin/chant" } }, "bin/chant");
  const deep = join(product, "node_modules", "@x", "tool", "dist");
  mkdirSync(deep, { recursive: true });

  test("walks up from each start to node_modules/@intentius/chant and reads bin.chant", () => {
    expect(installedChant([deep])).toEqual({ root, bin: join(root, "bin", "chant"), binDir: join(root, "bin"), version: "1.2.3" });
  });

  test("takes the first start that has one, and skips a manifest that is not chant's or names no bin there", () => {
    const repo = join(scratch, "repo");
    pkg(join(repo, "node_modules", "@intentius", "chant"), { name: "@intentius/chant", bin: { chant: "./bin/missing" } });
    const other = join(scratch, "other");
    pkg(join(other, "node_modules", "@intentius", "chant"), { name: "not-chant", bin: "./bin/chant" }, "bin/chant");
    expect(installedChant([repo, other, deep])?.root).toBe(root);
    expect(installedChant([repo, other])).toBeUndefined();
  });

  test("a string bin is the chant bin too", () => {
    const at = join(scratch, "string-bin");
    pkg(join(at, "node_modules", "@intentius", "chant"), { name: "@intentius/chant", bin: "./bin/chant" }, "bin/chant");
    expect(installedChant([at])?.bin).toBe(join(at, "node_modules", "@intentius", "chant", "bin", "chant"));
  });
});

describe("running it", () => {
  test("chantCommand: the named chant, else this package's bin", () => {
    expect(chantCommand({ chant: "/opt/chant" })).toBe("/opt/chant");
    expect(chantCommand()).toBe(bundledChant()!.bin);
  });

  test("chantArgv runs the bin with this node and the product's node arguments", () => {
    const own = bundledChant()!;
    expect(chantArgv(["build", "--json"], { nodeArgs: ["--import", "data:x"] })).toEqual([process.execPath, "--import", "data:x", own.bin, "build", "--json"]);
  });

  test("chantEnv puts the bin directory first on PATH", () => {
    const env = chantEnv({ PATH: "/usr/bin", HOME: "/h" });
    expect(env.PATH).toBe([bundledChant()!.binDir, "/usr/bin"].join(delimiter));
    expect(env.HOME).toBe("/h");
  });
});

describe("chantResolveFallback", () => {
  const from = "file:///opt/product/dist/bin.js";
  const missing = Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" });

  test("covers chant and its lexicons, with any subpath", () => {
    for (const s of ["@intentius/chant", "@intentius/chant/op", "@intentius/chant-lexicon-pulumi", "@intentius/chant-lexicon-sql/config"]) expect(CHANT_SPECIFIER.test(s), s).toBe(true);
    for (const s of ["@intentius/chantx", "@intentius/plywood", "chant"]) expect(CHANT_SPECIFIER.test(s), s).toBe(false);
  });

  test("retries a chant import the importer could not find from the product's install", () => {
    const seen: Array<unknown> = [];
    const hook = chantResolveFallback(from);
    const next = (specifier: string, context?: Record<string, unknown>) => {
      seen.push(context?.parentURL);
      if (context?.parentURL !== from) throw missing;
      return { url: `file:///opt/product/node_modules/${specifier}/index.js` };
    };
    expect(hook("@intentius/chant/op", { parentURL: "file:///repo/ops/up.op.ts" }, next).url).toBe("file:///opt/product/node_modules/@intentius/chant/op/index.js");
    expect(seen).toEqual(["file:///repo/ops/up.op.ts", from]);
  });

  test("leaves any other specifier, any other failure, and the product's own imports as Node reports them", () => {
    const hook = chantResolveFallback(from);
    const fail = (e: Error) => () => {
      throw e;
    };
    expect(() => hook("left-pad", { parentURL: "file:///repo/a.ts" }, fail(missing))).toThrow("not found");
    expect(() => hook("@intentius/chant", { parentURL: "file:///repo/a.ts" }, fail(new Error("syntax")))).toThrow("syntax");
    expect(() => hook("@intentius/chant", { parentURL: from }, fail(missing))).toThrow("not found");
  });
});

/** #4889: a file with no node_modules above it, outside every checkout and install. */
describe("the resolve fallback for any bare specifier (#4889)", () => {
  const worktree = join(import.meta.dirname, "..", "..", "..");
  const parent = pathToFileURL(join(worktree, "chant-resolve-fallback.js")).href;
  const missing = Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" });
  const bare = join(scratch, "worktree");
  mkdirSync(join(bare, "src"), { recursive: true });
  const importer = pathToFileURL(join(bare, "src", "chant.config.ts")).href;

  test("a bare specifier is a package name, nothing else", () => {
    for (const s of ["semver", "@intentius/sql-yodeler", "@intentius/chant/op"]) expect(isBareSpecifier(s), s).toBe(true);
    for (const s of ["./a.js", "../a.js", "/abs/a.js", "file:///a.js", "node:fs", "data:text/javascript,", "#internal"]) expect(isBareSpecifier(s), s).toBe(false);
  });

  test("the scratch worktree has no node_modules above it, and this file does", () => {
    expect(hasNodeModulesAbove(importer)).toBe(false);
    expect(hasNodeModulesAbove(pathToFileURL(import.meta.filename).href)).toBe(true);
    expect(hasNodeModulesAbove("node:fs")).toBe(true);
  });

  test("fallbackParent is a file beside the node_modules holding chant, or chant's own file in a checkout", () => {
    expect(fallbackParent("file:///opt/yodel/node_modules/@intentius/chant/dist/chant-install.js")).toBe("file:///opt/yodel/chant-resolve-fallback.js");
    expect(fallbackParent("file:///src/chant/packages/core/src/chant-install.ts")).toBe("file:///src/chant/packages/core/src/chant-install.ts");
  });

  test("retries a bare import of a file with no install from the product's, and leaves the rest as Node reports them", () => {
    const hook = bareResolveFallback(parent);
    const seen: unknown[] = [];
    const next = (specifier: string, context?: Record<string, unknown>) => {
      seen.push(context?.parentURL);
      if (context?.parentURL !== parent) throw missing;
      return { url: `file:///product/node_modules/${specifier}/index.js` };
    };
    expect(hook("@intentius/sql-yodeler", { parentURL: importer }, next).url).toBe("file:///product/node_modules/@intentius/sql-yodeler/index.js");
    expect(seen).toEqual([importer, parent]);
    const fail = (e: Error) => () => {
      throw e;
    };
    expect(() => hook("./local.js", { parentURL: importer }, fail(missing))).toThrow("not found");
    expect(() => hook("left-pad", { parentURL: pathToFileURL(import.meta.filename).href }, fail(missing))).toThrow("not found");
    expect(() => hook("left-pad", { parentURL: importer }, fail(new Error("syntax")))).toThrow("syntax");
  });

  test("fallbackImportArgs lets a child import a package from the product's install", () => {
    const file = join(bare, "src", "uses-semver.mjs");
    writeFileSync(file, 'import semver from "semver";\nconsole.log(semver.valid("1.2.3"));\n');
    const without = spawnSync(process.execPath, [file], { encoding: "utf8" });
    expect(without.status).not.toBe(0);
    expect(without.stderr).toMatch(/Cannot find package 'semver'/);
    const withIt = spawnSync(process.execPath, [...fallbackImportArgs(parent), file], { encoding: "utf8" });
    expect(withIt.stderr).toBe("");
    expect(withIt.stdout.trim()).toBe("1.2.3");
  });
});

describe("runChant (#4889)", () => {
  test("lastJsonLine is the last line that is a JSON object, or a pretty-printed document", () => {
    expect(lastJsonLine('fold: 1 file folded\n{"a":1}\n{not json\n')).toEqual({ a: 1 });
    expect(lastJsonLine('{"a":1}\nlog\n{"b":2}\n')).toEqual({ b: 2 });
    expect(lastJsonLine('{\n  "a": 2\n}\n')).toEqual({ a: 2 });
    expect(lastJsonLine("no json here")).toBeUndefined();
  });

  test("runs the install's bin with this node, the fallback's --import and chant's bin first on PATH, and reads its --json document", async () => {
    const root = pkg(join(scratch, "run", "node_modules", "@intentius", "chant"), { name: "@intentius/chant", version: "9.9.9", bin: { chant: "./bin/chant" } }, "bin/chant");
    writeFileSync(
      join(root, "bin", "chant"),
      'console.error("chant: working");\nconsole.log("a log line");\nconsole.log(JSON.stringify({ args: process.argv.slice(2), imports: process.execArgv.filter((a) => a.startsWith("data:")).length, path: process.env.PATH.split(require("path").delimiter)[0], color: process.env.NO_COLOR ?? null }));\nprocess.exit(3);\n',
    );
    const install = installedChant([join(scratch, "run")])!;
    const chunks: string[] = [];
    const ran = await runChant(["build", "--json"], { install, cwd: scratch, resolveFallback: true, noColor: true, onStderr: (t) => chunks.push(t) });
    expect(ran.code).toBe(3);
    expect(ran.stdout).toMatch(/^a log line\n/);
    expect(ran.json).toEqual({ args: ["build", "--json"], imports: 1, path: install.binDir, color: "1" });
    expect(chunks.join("")).toBe("chant: working\n");
  });

  test("a named chant runs as it is, and a child that cannot start rejects", async () => {
    const ran = await runChant(["-e", "console.log(JSON.stringify({ ok: true }))"], { chant: process.execPath });
    expect(ran).toMatchObject({ code: 0, json: { ok: true } });
    await expect(runChant([], { chant: join(scratch, "no-such-chant") })).rejects.toThrow(/ENOENT/);
  });

  test("CHANT_RUN_FLOOR is the release that shipped it", () => {
    expect(CHANT_RUN_FLOOR).toBe("0.124.88");
  });
});
