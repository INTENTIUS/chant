/**
 * `just release-lexicon` floors its version with release_lexicon_floor
 * (#4040): `just release` publishes every package at its label without moving
 * package.json, so package.json alone would pick a version npm already has.
 * The floor is the highest of package.json at the commit and on main, the
 * lexicon's own tags, the release/npm/* tags and `npm view`, with a fake `npm`
 * on PATH standing in for the registry.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const lib = join(import.meta.dirname, "release-lib.sh");
let dir: string;

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

/** A fake `npm view <pkg> version`: prints `answer`, or fails with `error`. */
function fakeNpm(answer: { version?: string; error?: string }) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const body = answer.error ? `echo "${answer.error}" >&2; exit 1` : `echo "${answer.version}"`;
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\n[ "$1" = view ] || exit 2\n${body}\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return bin;
}

function floor(bin: string) {
  return spawnSync("bash", ["-c", `source "${lib}"; RELEASE_MAIN=HEAD release_lexicon_floor foo HEAD`], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-lexicon-floor-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@chant.dev");
  git("config", "user.name", "T");
  mkdirSync(join(dir, "lexicons", "foo"), { recursive: true });
  writeFileSync(join(dir, "lexicons", "foo", "package.json"), JSON.stringify({ name: "@acme/lexicon-foo", version: "0.5.0" }));
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("tag", "lexicon-foo-v0.6.0");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("release_lexicon_floor (#4040)", () => {
  it("takes npm's version when it is the highest", () => {
    git("tag", "release/npm/0.7.0");
    const r = floor(fakeNpm({ version: "0.9.1" }));
    expect(r.stdout.trim()).toBe("0.9.1");
  });

  it("takes a release/npm tag over package.json and the lexicon's own tags", () => {
    git("tag", "release/npm/0.8.2");
    const r = floor(fakeNpm({ version: "0.8.0" }));
    expect(r.stdout.trim()).toBe("0.8.2");
  });

  it("a package npm has never seen adds nothing", () => {
    const r = floor(fakeNpm({ error: "npm error code E404" }));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("0.6.0");
  });

  it("refuses when npm can't be asked, rather than guess", () => {
    const r = floor(fakeNpm({ error: "npm error code ECONNREFUSED" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("version floor is unknown");
  });
});
