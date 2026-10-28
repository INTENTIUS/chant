/**
 * A release's copy of a Pulumi program (#4542 item 3): `pulumi install` (or
 * `plunge install`) runs in the copy when its runtime needs one, a Node copy
 * with no lockfile is refused by name, and a directory that is not a copy is
 * never touched. The runner is a fake, so nothing installs.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { isReleaseCopy, prepareReleaseCopy, PulumiReleaseCopyRefusedError, releaseCopyNeeds, resetPreparedReleaseCopies } from "./release-copy";
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
