/**
 * `just release` as a release train (#5137): scripts/release-train.sh against
 * a throwaway repository with a bare origin, two release members (core and
 * lexicon-aws), a fake chant whose ledger lives in a state directory, a fake
 * `npm` that has never seen the packages, and seams for the preflight, the
 * floors check and the ledger push.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let work: string;
let origin: string;
let state: string;
let sha: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf-8" }).trim();

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function bin(name: string, body: string) {
  write(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
}

const MEMBERS = [
  { name: "core", dir: "packages/core", pkg: "@intentius/chant" },
  { name: "lexicon-aws", dir: "lexicons/aws", pkg: "@intentius/chant-lexicon-aws" },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-release-train-"));
  origin = join(dir, "origin.git");
  work = join(dir, "work");
  state = join(dir, "state");
  mkdirSync(state);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, work);
  for (const f of ["release-train.sh", "release-lib.sh"]) {
    mkdirSync(join(work, "scripts"), { recursive: true });
    copyFileSync(join(import.meta.dirname, f), join(work, "scripts", f));
  }
  write(join(work, "chant.workspace.json"), JSON.stringify({ name: "t", members: MEMBERS.map((m) => ({ name: m.name, dir: m.dir, kind: "other" })) }));
  write(join(work, "release", "chant.workspace.json"), JSON.stringify({ name: "npm", members: MEMBERS.map((m) => ({ name: m.name, dir: m.name, kind: "chant" })) }));
  for (const m of MEMBERS) {
    write(join(work, m.dir, "package.json"), JSON.stringify({ name: m.pkg, version: "0.124.34" }));
    write(join(work, "release", m.name, "chant.config.ts"), "export default {};\n");
  }
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  sha = git(work, "rev-parse", "HEAD");
  git(work, "tag", "release/npm/0.124.50", sha);
  git(work, "push", "-q", "origin", "refs/tags/release/npm/0.124.50");

  // The fake chant: the member is the directory it runs in, `release` for the root.
  bin(
    "fake-chant",
    `m=$(basename "$PWD")
echo "chant[$m] $*" >> "${state}/log"
case "$*" in
  "workspace train list npm --json") cat "${state}/trains" 2>/dev/null || echo '{"env":"npm","trains":[]}' ;;
  "workspace train npm --json") echo '{"id":"train-x","written":true}' ;;
  "release list --json")
    if [ -f "${state}/list-$m" ]; then jq -s '{releases: .}' "${state}/list-$m"; else echo '{"releases":[]}'; fi ;;
  "release changed "*) cat "${state}/changed" ;;
  "release cut "*)
    if [ "\${6:-}" = --yes ]; then
      git -c user.name=t -c user.email=t@t -c tag.gpgsign=false tag -a -m cut "release/npm/$m/$3" "$5"
      echo "{\\"label\\":\\"$3\\",\\"commit\\":\\"$5\\"}" >> "${state}/list-$m"
    fi ;;
  *) exit 2 ;;
esac`,
  );
  bin("npm", `echo "npm ERR! code E404" >&2; exit 1`);
  bin("fake-preflight", `git rev-parse origin/main`);
  bin("fake-floors", `echo "floors $*" >> "${state}/log"`);
  bin("fake-push-ledger", `echo "push-ledger" >> "${state}/log"`);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function release(...args: string[]) {
  return spawnSync("bash", ["scripts/release-train.sh", ...args], {
    cwd: work,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      RELEASE_CHANT: join(dir, "bin", "fake-chant"),
      RELEASE_PREFLIGHT: join(dir, "bin", "fake-preflight"),
      RELEASE_FLOORS: join(dir, "bin", "fake-floors"),
      RELEASE_PUSH_LEDGER: join(dir, "bin", "fake-push-ledger"),
    },
  });
}

const log = () => (existsSync(join(state, "log")) ? readFileSync(join(state, "log"), "utf-8") : "");
const originTags = () => git(origin, "tag", "-l").split("\n").filter(Boolean).sort();

function changed(members: { member: string; next: string | null; code?: string; by?: string }[]) {
  writeFileSync(
    join(state, "changed"),
    JSON.stringify({
      at: sha,
      members: members.map((m, i) => ({ member: m.member, layer: i, reason: { code: m.code ?? "paths-changed", member: m.by ?? null }, last: m.next ? { label: "0.124.51", commit: "c", source: "ledger" } : null, bump: "patch", next: m.next, paths: [] })),
    }),
  );
}

const someTrain = () => writeFileSync(join(state, "trains"), JSON.stringify({ env: "npm", trains: [{ id: "train-0", trainDigest: "sha256:0", members: [] }] }));

describe("just release cuts a release train (#5137)", () => {
  it("the first train cuts every member at one label past every lockstep version, records the train and pushes its tags", () => {
    changed([{ member: "core", next: null }, { member: "lexicon-aws", next: null }]);
    const r = release();
    expect(r.status, r.stderr).toBe(0);
    const l = log();
    expect(l).toContain(`chant[core] release cut 0.124.51 --at ${sha} --yes`);
    expect(l).toContain(`chant[lexicon-aws] release cut 0.124.51 --at ${sha} --yes`);
    expect(l).toContain(`floors --npm --rev ${sha} --release 0.124.51`);
    expect(l).toContain("chant[release] workspace train npm --json");
    expect(l.indexOf("workspace train npm --json")).toBeLessThan(l.indexOf("push-ledger"));
    expect(originTags()).toEqual(["release-train/npm/train-x", "release/npm/0.124.50", "release/npm/core/0.124.51", "release/npm/lexicon-aws/0.124.51"]);
    expect(git(origin, "rev-parse", "release-train/npm/train-x^{commit}")).toBe(sha);
    expect(r.stdout).toContain("Released train train-x (2 member(s)): publish.yml runs on release-train/npm/train-x");
  });

  it("the first train takes one bump for every member and refuses a member's own", () => {
    changed([{ member: "core", next: null }, { member: "lexicon-aws", next: null }]);
    const minor = release("minor", "--dry-run");
    expect(minor.status, minor.stderr).toBe(0);
    expect(log()).toContain(`chant[core] release cut 0.125.0 --at ${sha}\n`);
    const own = release("lexicon-aws=minor");
    expect(own.status).toBe(2);
    expect(own.stderr).toContain("the first train cuts every member at one label");
  });

  it("a later train cuts only what release changed lists, with each member's bump", () => {
    someTrain();
    changed([{ member: "lexicon-aws", next: "0.125.0" }]);
    const r = release("lexicon-aws=minor");
    expect(r.status, r.stderr).toBe(0);
    const l = log();
    expect(l).toContain(`release changed --at ${sha} --bump-member core=patch --bump-member lexicon-aws=minor --json`);
    expect(l).toContain(`chant[lexicon-aws] release cut 0.125.0 --at ${sha} --yes`);
    expect(l).not.toContain("chant[core] release cut");
    expect(l).not.toContain("floors ");
    expect(originTags()).toEqual(["release-train/npm/train-x", "release/npm/0.124.50", "release/npm/lexicon-aws/0.125.0"]);
  });

  it("floors a member's label past every version its package has", () => {
    someTrain();
    git(work, "tag", "release/npm/lexicon-aws/0.124.60", sha);
    git(work, "push", "-q", "origin", "refs/tags/release/npm/lexicon-aws/0.124.60");
    changed([{ member: "lexicon-aws", next: "0.124.52" }]);
    const r = release();
    expect(r.status, r.stderr).toBe(0);
    expect(log()).toContain("chant[lexicon-aws] release cut 0.124.61");
  });

  it("--dry-run cuts without --yes and records, tags and pushes nothing", () => {
    someTrain();
    changed([{ member: "core", next: "0.124.52" }, { member: "lexicon-aws", next: "0.124.52", code: "range-broken-by", by: "core" }]);
    const r = release("--dry-run");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("(range-broken-by core)");
    expect(log()).toContain(`chant[core] release cut 0.124.52 --at ${sha}\n`);
    expect(log()).not.toContain("workspace train npm --json");
    expect(log()).not.toContain("push-ledger");
    expect(originTags()).toEqual(["release/npm/0.124.50"]);
    expect(r.stdout).toContain("Dry run: nothing cut, recorded, tagged or pushed.");
  });

  it("says so and stops when no member changed", () => {
    someTrain();
    changed([]);
    const r = release();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Nothing to release at");
    expect(log()).not.toContain("release cut");
  });

  it("stops at a commit a release-train tag already names", () => {
    git(work, "tag", "release-train/npm/train-0", sha);
    git(work, "push", "-q", "origin", "refs/tags/release-train/npm/train-0");
    const r = release();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("is already released as release-train/npm/train-0");
    expect(log()).not.toContain("release changed");
  });

  it("a run that stopped after a cut does not cut it again, and still tags it in the train", () => {
    someTrain();
    writeFileSync(join(state, "list-core"), `${JSON.stringify({ label: "0.124.52", commit: sha })}\n`);
    git(work, "tag", "-a", "-m", "cut", "release/npm/core/0.124.52", sha);
    changed([{ member: "lexicon-aws", next: "0.124.52" }]);
    const r = release();
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toContain("chant[core] release cut");
    expect(originTags()).toContain("release/npm/core/0.124.52");
    expect(originTags()).toContain("release/npm/lexicon-aws/0.124.52");
  });

  it("refuses a bump for a name that is not a release member", () => {
    const r = release("lexicon-nope=minor");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("lexicon-nope is not a release member");
  });
});
