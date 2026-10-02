/**
 * What publish.yml's `untag` job does with a failed release's tag (#3191).
 * Nothing on npm: the tag goes (#1481). Any of the release's packages on npm:
 * the tag stays and the job fails with the list.
 *
 * A real git repo pushes its tag to a bare `origin`, so deletion is observed
 * there. `npm view` is a fake on PATH that answers from `published`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "release-untag.sh");
let root: string;
let dir: string;
let origin: string;
let bin: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
  }).trim();
const put = (rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const pkg = (name: string, version: string, extra = "") => `{ "name": "${name}", "version": "${version}"${extra} }\n`;
const commit = (message: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
};
const originTags = () => git(origin, "tag", "-l").split("\n").filter(Boolean);

// `npm view <name>@<version> version`: prints the version when it is listed
// in `published`, else npm 11's E404. `npm-error` makes it fail otherwise.
const FAKE_NPM = `#!/usr/bin/env bash
[ "$1" = view ] || exit 2
spec="$2"
if [ -f "$FAKE_BIN/npm-error" ]; then
  echo "npm error code ETIMEDOUT" >&2; exit 1
fi
if grep -qxF "$spec" "$FAKE_BIN/published" 2>/dev/null; then
  echo "\${spec##*@}"
else
  echo "npm error code E404" >&2
  echo "npm error 404 No match found for version \${spec##*@}" >&2
  exit 1
fi
`;

function untag(tag: string, opts: { published?: string[]; publishedInRun?: string; npmError?: boolean } = {}) {
  writeFileSync(join(bin, "published"), (opts.published ?? []).map((p) => `${p}\n`).join(""));
  if (opts.npmError) writeFileSync(join(bin, "npm-error"), "");
  const summary = join(root, "summary");
  const r = spawnSync("bash", [script], {
    cwd: dir,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_BIN: bin,
      GITHUB_REF_NAME: tag,
      GITHUB_STEP_SUMMARY: summary,
      PUBLISHED_IN_RUN: opts.publishedInRun ?? "",
    },
  });
  let written = "";
  try {
    written = readFileSync(summary, "utf-8");
  } catch {}
  return { status: r.status, out: r.stdout + r.stderr, summary: written };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "chant-untag-"));
  dir = join(root, "work");
  origin = join(root, "origin.git");
  bin = join(root, "bin");
  mkdirSync(dir);
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), FAKE_NPM);
  chmodSync(join(bin, "npm"), 0o755);
  git(root, "init", "-q", "--bare", origin);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", origin);
  put("packages/core/package.json", pkg("@intentius/chant", "0.1.0"));
  put("lexicons/otel/package.json", pkg("@intentius/chant-lexicon-otel", "0.1.0"));
  put("lexicons/fly/package.json", pkg("@intentius/chant-lexicon-fly", "0.1.0"));
  put("packages/test-utils/package.json", pkg("@intentius/test-utils", "0.1.0", ', "private": true'));
  commit("feat: something");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A lockstep bump commit (`just release`), tagged and pushed. */
function release(tag = "chant-v0.2.0") {
  put("packages/core/package.json", pkg("@intentius/chant", "0.2.0"));
  put("lexicons/otel/package.json", pkg("@intentius/chant-lexicon-otel", "0.2.0"));
  put("lexicons/fly/package.json", pkg("@intentius/chant-lexicon-fly", "0.2.0"));
  put("packages/test-utils/package.json", pkg("@intentius/test-utils", "0.2.0", ', "private": true'));
  commit(tag);
  git(dir, "tag", tag);
  git(dir, "push", "-q", "origin", "main", tag);
}

describe("release-untag.sh (#3191)", () => {
  it("deletes the tag when nothing of the release reached npm (#1481)", () => {
    release();
    expect(originTags()).toEqual(["chant-v0.2.0"]);
    const r = untag("chant-v0.2.0");
    expect(r.status).toBe(0);
    expect(originTags()).toEqual([]);
    expect(r.out).toContain("none of its packages reached npm");
  });

  it("keeps the tag after a partial publish and lists what did and did not publish (chant-v0.81.0)", () => {
    release();
    const r = untag("chant-v0.2.0", { published: ["@intentius/chant@0.2.0", "@intentius/chant-lexicon-fly@0.2.0"] });
    expect(r.status).toBe(1);
    expect(originTags()).toEqual(["chant-v0.2.0"]);
    expect(r.out).toContain("::error::release chant-v0.2.0 is partly on npm (published: 2");
    expect(r.summary).toContain("| `@intentius/chant@0.2.0` | published |");
    expect(r.summary).toContain("| `@intentius/chant-lexicon-otel@0.2.0` | **not published** |");
    // A private package is never part of a release.
    expect(r.summary).not.toContain("test-utils");
  });

  it("counts what the publish job just published even if the registry does not show it yet", () => {
    release();
    const r = untag("chant-v0.2.0", { publishedInRun: "@intentius/chant-lexicon-otel@0.2.0" });
    expect(r.status).toBe(1);
    expect(originTags()).toEqual(["chant-v0.2.0"]);
  });

  it("keeps the tag when the registry cannot be read", () => {
    release();
    const r = untag("chant-v0.2.0", { npmError: true });
    expect(r.status).toBe(1);
    expect(originTags()).toEqual(["chant-v0.2.0"]);
    expect(r.summary).toContain("could not tell");
  });

  it("judges a single-lexicon release only by the package it bumped", () => {
    // fly and chant sit at 0.1.0 on npm from an earlier release; only otel moves.
    put("lexicons/otel/package.json", pkg("@intentius/chant-lexicon-otel", "0.1.1"));
    commit("lexicon-otel-v0.1.1");
    git(dir, "tag", "lexicon-otel-v0.1.1");
    git(dir, "push", "-q", "origin", "main", "lexicon-otel-v0.1.1");
    const r = untag("lexicon-otel-v0.1.1", {
      published: ["@intentius/chant@0.1.0", "@intentius/chant-lexicon-fly@0.1.0", "@intentius/chant-lexicon-otel@0.1.0"],
    });
    expect(r.status).toBe(0);
    expect(originTags()).toEqual([]);
  });
});
