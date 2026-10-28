/**
 * A release's copy of a Pulumi program (#4542 item 3): `pulumi install` (or
 * `plunge install`) runs in the copy when its runtime needs one, a Node copy
 * with no lockfile is refused by name, and a directory that is not a copy is
 * left alone by `prepareReleaseCopy`. `prepareProgram` prepares an in-place
 * checkout by the same rule (plywood#22). The runner is a fake, so nothing
 * installs.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  isReleaseCopy,
  prepareProgram,
  prepareReleaseCopy,
  programNeeds,
  PulumiProgramNotReadyError,
  PulumiReleaseCopyRefusedError,
  releaseCopyNeeds,
  resetPreparedReleaseCopies,
} from "./release-copy";
import { runReleaseInstall, type PulumiRunner } from "./run";

function copy(pulumiYaml: string, files: Record<string, string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "release-copy-")), ".chant", "release-templates", "abc123", "infra");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Pulumi.yaml"), pulumiYaml);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function runner(): { run: PulumiRunner; calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  return { run: async (args, opts) => (calls.push({ args, cwd: opts.cwd }), { stdout: "" }), calls };
}

beforeEach(() => resetPreparedReleaseCopies());

describe("a release copy", () => {
  test("is recognised by its path", () => {
    expect(isReleaseCopy(copy("name: shop\nruntime: nodejs\n"))).toBe(true);
    expect(isReleaseCopy(mkdtempSync(join(tmpdir(), "plain-")))).toBe(false);
  });

  test("a Node copy with a lockfile and no node_modules gets one install, once", async () => {
    const dir = copy("name: shop\nruntime: nodejs\n", { "package.json": "{}", "package-lock.json": "{}" });
    const { run, calls } = runner();
    expect(await prepareReleaseCopy({ dir, member: "shop/prod", engine: "pulumi", run })).toEqual({ action: "installed", command: "pulumi install" });
    await prepareReleaseCopy({ dir, member: "shop/prod", engine: "pulumi", run });
    expect(calls).toEqual([{ args: ["install"], cwd: dir }]);
  });

  test("a Node copy with no lockfile is refused by name, and nothing runs", async () => {
    const dir = copy("name: shop\nruntime: nodejs\n", { "package.json": "{}" });
    const { run, calls } = runner();
    await expect(prepareReleaseCopy({ dir, member: "shop/prod", engine: "plunge", run })).rejects.toThrow(PulumiReleaseCopyRefusedError);
    await expect(prepareReleaseCopy({ dir, member: "shop/prod", engine: "plunge", run })).rejects.toThrow(/recorded no lockfile/);
    expect(calls).toEqual([]);
  });

  test("Python installs for a missing virtualenv or a poetry or uv toolchain; Go and YAML never do", () => {
    expect(releaseCopyNeeds(copy("name: a\nruntime:\n  name: python\n  options:\n    virtualenv: venv\n"), "a").install).toBe(true);
    expect(releaseCopyNeeds(copy("name: a\nruntime:\n  name: python\n  options:\n    toolchain: uv\n"), "a").install).toBe(true);
    expect(releaseCopyNeeds(copy("name: a\nruntime: python\n"), "a").install).toBe(false);
    expect(releaseCopyNeeds(copy("name: a\nruntime: go\n"), "a").install).toBe(false);
    expect(releaseCopyNeeds(copy("name: a\nruntime: yaml\n"), "a").install).toBe(false);
  });

  test("a directory outside a release copy is never touched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plain-"));
    writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: nodejs\n");
    const { run, calls } = runner();
    expect(await prepareReleaseCopy({ dir, member: "shop/prod", engine: "pulumi", run })).toEqual({ action: "not-a-copy" });
    expect(calls).toEqual([]);
  });

  test("the install argv is exactly install", async () => {
    const { run, calls } = runner();
    for (const args of [["install", "--reinstall"], ["install", "--no-plugins"], ["up"], []]) {
      await expect(runReleaseInstall(run, args, "/tmp")).rejects.toThrow(/only as pulumi install or plunge install/);
    }
    expect(calls).toEqual([]);
  });
});

/** An in-place checkout: a directory outside any release copy, with its files. */
function checkout(pulumiYaml: string, files: Record<string, string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), "checkout-")), "shop");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Pulumi.yaml"), pulumiYaml);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("an in-place checkout (plywood#22)", () => {
  const node = "name: shop\nruntime: nodejs\n";
  const locked = { "package.json": "{}", "package-lock.json": "{}" };

  test("a Node checkout with a lockfile and no node_modules gets one install, whichever engine asks", async () => {
    const dir = checkout(node, locked);
    const plunge = runner();
    const pulumi = runner();
    const [a, b] = await Promise.all([
      prepareProgram({ dir, member: "shop/dev", engine: "plunge", run: plunge.run }),
      prepareProgram({ dir, member: "shop/staging", engine: "pulumi", run: pulumi.run }),
    ]);
    expect(a).toEqual({ place: "checkout", action: "installed", command: "plunge install" });
    expect(b).toEqual(a);
    expect(plunge.calls).toEqual([{ args: ["install"], cwd: dir }]);
    expect(pulumi.calls).toEqual([]);
  });

  test("node_modules here or above, or Yarn's Plug'n'Play loader, counts as installed", () => {
    const here = checkout(node, locked);
    mkdirSync(join(here, "node_modules"));
    expect(programNeeds(here, "shop/dev", "checkout").install).toBe(false);

    const hoisted = checkout(node, { "package.json": "{}" });
    mkdirSync(join(hoisted, "..", "node_modules"));
    expect(programNeeds(hoisted, "shop/dev", "checkout")).toMatchObject({ install: false, reason: expect.stringContaining("node_modules") });

    const pnp = checkout(node, { "package.json": "{}", "yarn.lock": "", ".pnp.cjs": "" });
    expect(programNeeds(pnp, "shop/dev", "checkout").install).toBe(false);
  });

  test("a Node checkout with no lockfile is refused by name, and nothing runs", async () => {
    const dir = checkout(node, { "package.json": "{}" });
    const { run, calls } = runner();
    await expect(prepareProgram({ dir, member: "shop/dev", engine: "pulumi", run })).rejects.toThrow(PulumiProgramNotReadyError);
    await expect(prepareProgram({ dir, member: "shop/dev", engine: "pulumi", run })).rejects.toThrow(/no lockfile .* beside its package.json/);
    expect(calls).toEqual([]);
  });

  test("a failed install names the command, and the next call tries again", async () => {
    const dir = checkout(node, locked);
    let fail = true;
    const calls: string[][] = [];
    const run: PulumiRunner = async (args) => {
      calls.push(args);
      if (fail) throw Object.assign(new Error("exit 1"), { code: 1, stderr: "npm error ERESOLVE" });
      return { stdout: "" };
    };
    await expect(prepareProgram({ dir, member: "shop/dev", engine: "pulumi", run })).rejects.toThrow(/pulumi install failed: npm error ERESOLVE/);
    fail = false;
    expect(await prepareProgram({ dir, member: "shop/dev", engine: "pulumi", run })).toMatchObject({ action: "installed" });
    expect(calls).toEqual([["install"], ["install"]]);
  });

  test("Python, Go and YAML follow the copy's rules", () => {
    expect(programNeeds(checkout("name: a\nruntime:\n  name: python\n  options:\n    virtualenv: venv\n"), "a", "checkout").install).toBe(true);
    expect(programNeeds(checkout("name: a\nruntime: python\n"), "a", "checkout").install).toBe(false);
    expect(programNeeds(checkout("name: a\nruntime: go\n"), "a", "checkout").install).toBe(false);
    expect(programNeeds(checkout("name: a\nruntime: yaml\n"), "a", "checkout").install).toBe(false);
  });

  test("a release copy keeps the copy's rule: node_modules above the copy does not count", () => {
    const dir = copy("name: shop\nruntime: nodejs\n", { "package.json": "{}", "package-lock.json": "{}" });
    mkdirSync(join(dir, "..", "node_modules"));
    expect(releaseCopyNeeds(dir, "shop/prod").install).toBe(true);
  });
});
