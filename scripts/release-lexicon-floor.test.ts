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

/** A fake chant whose `release list --json` prints `labels` as the member's ledger. */
function fakeChant(labels: string[]) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const json = JSON.stringify({ releases: labels.map((label) => ({ label })) });
  writeFileSync(join(bin, "fake-chant"), `#!/usr/bin/env bash\n[ "$1 $2" = "release list" ] || exit 2\necho '${json}'\n`);
  chmodSync(join(bin, "fake-chant"), 0o755);
  return join(bin, "fake-chant");
}

function sh(bin: string, body: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `source "${lib}"; RELEASE_MAIN=HEAD ${body}`], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

describe("member tags are not lockstep labels (#5135)", () => {
  it("release_legacy_versions reads release/npm/<v> and chant-v<v>, not release/npm/<member>/<v>", () => {
    git("tag", "release/npm/0.7.0");
    git("tag", "chant-v0.7.1");
    git("tag", "release/npm/core/0.125.0");
    git("tag", "release/npm/lexicon-foo/0.126.0");
    git("tag", "release-train/npm/1");
    const r = sh(fakeNpm({ version: "0.1.0" }), "release_legacy_versions");
    expect(r.stdout.trim().split("\n").sort()).toEqual(["0.7.0", "0.7.1"]);
  });

  it("another member's tag leaves the lexicon floor where it was", () => {
    git("tag", "release/npm/0.7.0");
    const bin = fakeNpm({ error: "npm error code E404" });
    const before = floor(bin).stdout.trim();
    git("tag", "release/npm/core/0.125.0");
    git("tag", "release/npm/k8s-client/0.130.0");
    expect(floor(bin).stdout.trim()).toBe(before);
    expect(before).toBe("0.7.0");
  });
});

describe("release_member_floor (#5135)", () => {
  beforeEach(() => {
    writeFileSync(
      join(dir, "chant.workspace.json"),
      JSON.stringify({ members: [{ name: "lexicon-foo", dir: "lexicons/foo" }, { name: "core", dir: "packages/core" }] }),
    );
    mkdirSync(join(dir, "release", "lexicon-foo"), { recursive: true });
    writeFileSync(join(dir, "release", "lexicon-foo", "chant.config.ts"), "export default {};\n");
    git("add", ".");
    git("commit", "-q", "-m", "members");
  });

  it("takes the member's own tags over the lockstep labels, and ignores other members' tags", () => {
    git("tag", "release/npm/0.7.0");
    git("tag", "release/npm/lexicon-foo/0.8.3");
    git("tag", "release/npm/core/0.125.0");
    const r = sh(fakeNpm({ error: "npm error code E404" }), "release_member_floor lexicon-foo HEAD", { RELEASE_CHANT: fakeChant([]) });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("0.8.3");
  });

  it("counts a label spent in the member's ledger", () => {
    git("tag", "release/npm/lexicon-foo/0.8.3");
    const r = sh(fakeNpm({ error: "npm error code E404" }), "release_member_floor lexicon-foo HEAD", { RELEASE_CHANT: fakeChant(["0.8.4", "not-a-version"]) });
    expect(r.stdout.trim()).toBe("0.8.4");
  });

  it("is never below a version npm lists, under any dist-tag", () => {
    git("tag", "release/npm/lexicon-foo/0.8.3");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash\n[ "$1 $3 $4" = "view versions --json" ] || exit 2\necho '[\n  "0.8.0",\n  "0.9.2",\n  "0.8.9"\n]'\n`);
    chmodSync(join(bin, "npm"), 0o755);
    const r = sh(bin, 'f=$(release_member_floor lexicon-foo HEAD) && echo "$f" && release_next "$f" patch', { RELEASE_CHANT: fakeChant([]) });
    expect(r.stdout.trim().split("\n")).toEqual(["0.9.2", "0.9.3"]);
  });

  it("refuses a member the declaration does not name", () => {
    const r = sh(fakeNpm({ version: "0.1.0" }), "release_member_floor lexicon-bar HEAD");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no member lexicon-bar in chant.workspace.json");
  });
});
