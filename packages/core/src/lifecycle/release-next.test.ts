/**
 * #5159: the next label from the conventional commits and the intent files
 * since a member's previous release. Every repo is a temp repo.
 */
import { afterAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { consumedIntents, intentNotes, parseIntent, pendingIntents, ReleaseIntentError, type ReleaseIntent } from "./release-intents";
import { nextLabel, nextRelease, ReleaseNextError } from "./release-next";
import { appendCut, makeRelease, persistRelease, type ReleaseCut } from "./release-store";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("intent files", () => {
  test("front matter names members and levels; the rest is the summary", () => {
    const parsed = parseIntent(".chant/release/a.md", '---\ncore: minor\n"lexicon-aws": Patch\n# a comment\n*: patch\n---\n\nThe core reads its config once.\n');
    expect([...parsed.members]).toEqual([
      ["core", "minor"],
      ["lexicon-aws", "patch"],
      ["*", "patch"],
    ]);
    expect(parsed.summary).toBe("The core reads its config once.");
  });

  test("a file without front matter, with a level that is not one, or naming no member is refused", () => {
    for (const text of ["core: minor\n", "---\ncore: minor\n", "---\ncore: huge\n---\n", "---\n---\nx\n", "---\ncore minor\n---\n", "---\ncore: minor\ncore: patch\n---\n"]) {
      expect(() => parseIntent("x.md", text)).toThrow(ReleaseIntentError);
    }
  });

  test("pending: the intents that name the member, by name or *, that no cut consumed", () => {
    const i = (path: string, members: Record<string, "major" | "minor" | "patch">): ReleaseIntent => ({ path, added: "a".repeat(40), members: new Map(Object.entries(members)), summary: path });
    const files = [i("a.md", { core: "minor" }), i("b.md", { other: "major" }), i("c.md", { "*": "patch", core: "major" })];
    const cut = { intents: [{ path: "a.md", added: "a".repeat(40), bump: "minor" }] } as ReleaseCut;
    expect(pendingIntents(files, ["core"], new Set()).map((p) => [p.path, p.bump])).toEqual([
      ["a.md", "minor"],
      ["c.md", "major"],
    ]);
    expect(pendingIntents(files, ["core"], consumedIntents([cut])).map((p) => p.path)).toEqual(["c.md"]);
    expect(pendingIntents(files, [], new Set()).map((p) => p.path)).toEqual(["c.md"]);
  });

  test("notes list the summaries, the highest level first, continuation lines indented", () => {
    expect(
      intentNotes([
        { bump: "patch", summary: "A fix." },
        { bump: "major", summary: "Config keys renamed.\n\nSee the guide." },
        { bump: "minor", summary: "" },
      ]),
    ).toBe("### Highlights\n\n- Config keys renamed.\n\n  See the guide.\n- A fix.");
    expect(intentNotes([])).toBe("");
  });
});

describe("nextLabel", () => {
  const labels: string[] = [];
  test("bumps the stable label, keeping a leading v", () => {
    expect(nextLabel({ stable: "1.4.2", bump: "patch", since: [], labels })).toBe("1.4.3");
    expect(nextLabel({ stable: "v1.4.2", bump: "minor", since: [], labels })).toBe("v1.5.0");
    expect(nextLabel({ stable: "0.9.1", bump: "major", since: [], labels })).toBe("1.0.0");
  });

  test("a prerelease cut since with a higher version carries its version", () => {
    expect(nextLabel({ stable: "1.4.2", bump: "patch", since: ["2.0.0-rc.1"], labels })).toBe("2.0.0");
    expect(nextLabel({ stable: "1.4.2", bump: null, since: ["1.5.0-beta.0"], labels })).toBe("1.5.0");
    expect(nextLabel({ stable: "1.4.2", bump: "major", since: ["1.5.0-beta.0"], labels })).toBe("2.0.0");
  });

  test("pre counts one past the ledger's highest for that version and id", () => {
    expect(nextLabel({ stable: "1.4.2", bump: "minor", since: [], labels: [], pre: "rc" })).toBe("1.5.0-rc.0");
    expect(nextLabel({ stable: "1.4.2", bump: "minor", since: ["1.5.0-rc.1"], labels: ["1.5.0-rc.0", "1.5.0-rc.1", "1.5.0-beta.4", "1.6.0-rc.7"], pre: "rc" })).toBe("1.5.0-rc.2");
  });
});

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(dir: string, message: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

let n = 0;
async function cut(dir: string, sha: string, label: string, intents?: ReleaseCut["intents"]): Promise<void> {
  const r = makeRelease({ member: null, commit: sha, artifactDigests: [], targets: [{ env: "dev", params: [], templates: [] }] });
  await persistRelease(r, [], { cwd: dir });
  await appendCut({ releaseDigest: r.releaseDigest, label, actor: "ci", timestamp: `2026-11-0${++n}T00:00:00.000Z`, runOrigin: null, signature: null, ...(intents ? { intents } : {}) }, { cwd: dir });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-next-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@chant.dev");
  git(dir, "config", "user.name", "T");
  return dir;
}

describe("nextRelease", () => {
  test("the bump is the highest of the commits since the previous release and the pending intent files, which a cut consumes", async () => {
    const dir = repo();
    const first = commit(dir, "feat: start", { "src/a.ts": "1" });
    await cut(dir, first, "v1.0.0");
    commit(dir, "fix: close the socket", { "src/a.ts": "2" });
    const head = commit(dir, "docs: say how", { "README.md": "x" });

    const fix = await nextRelease({ cwd: dir });
    expect(fix).toMatchObject({ label: "v1.0.1", at: head, bump: "patch", alreadyCut: false, from: { label: "v1.0.0", commit: first }, intents: [] });
    expect(fix.commits.map((c) => [c.subject, c.bump])).toEqual([
      ["docs: say how", "patch"],
      ["fix: close the socket", "patch"],
    ]);

    const withIntent = commit(dir, "chore: plan the release", { ".chant/release/stream.md": "---\n'*': minor\n---\nResponses stream.\n" });
    const minor = await nextRelease({ cwd: dir });
    expect(minor.label).toBe("v1.1.0");
    expect(minor.intents).toEqual([{ path: ".chant/release/stream.md", added: withIntent, bump: "minor", summary: "Responses stream." }]);

    // The cut of v1.1.0 consumed it, and the file stays in the tree: the next release does not read it again.
    await cut(dir, withIntent, "v1.1.0", [{ path: ".chant/release/stream.md", added: withIntent, bump: "minor" }]);
    commit(dir, "fix: one more", { "src/a.ts": "3" });
    const after = await nextRelease({ cwd: dir });
    expect(after).toMatchObject({ label: "v1.1.1", bump: "patch", intents: [] });
  });

  test("a breaking change makes a major, --pre counts prereleases, and a prerelease's version is carried to the release", async () => {
    const dir = repo();
    const first = commit(dir, "feat: start", { "src/a.ts": "1" });
    await cut(dir, first, "v1.1.1");
    const breaking = commit(dir, "feat!: rename the config key", { "src/a.ts": "4" });
    expect((await nextRelease({ cwd: dir })).label).toBe("v2.0.0");
    expect((await nextRelease({ cwd: dir, pre: "rc" })).label).toBe("v2.0.0-rc.0");
    await cut(dir, breaking, "v2.0.0-rc.0");
    commit(dir, "fix: after the rc", { "src/a.ts": "5" });
    expect((await nextRelease({ cwd: dir })).label).toBe("v2.0.0");
    expect((await nextRelease({ cwd: dir, pre: "rc" })).label).toBe("v2.0.0-rc.1");
    // A commit already released answers its label.
    expect(await nextRelease({ cwd: dir, at: breaking })).toMatchObject({ label: "v2.0.0-rc.0", alreadyCut: true });
  });

  test("refuses with no previous release, nothing changed, a bad intent file or a bad prerelease id", async () => {
    const dir = repo();
    const first = commit(dir, "feat: start", { "src/a.ts": "1" });
    const code = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ReleaseNextError ? e.code : e));
    expect(await code(nextRelease({ cwd: dir }))).toBe("release-next-no-previous");
    await cut(dir, first, "1.0.0");
    const second = commit(dir, "chore: touch", { "src/a.ts": "2" });
    await cut(dir, second, "1.0.1");
    expect(await nextRelease({ cwd: dir })).toMatchObject({ label: "1.0.1", alreadyCut: true });
    expect(await code(nextRelease({ cwd: dir, pre: "1x" }))).toBe("release-next-pre-invalid");
    commit(dir, "chore: a bad intent", { ".chant/release/bad.md": "core: minor\n" });
    expect(await code(nextRelease({ cwd: dir }))).toBe("release-intent-invalid");
  });

  test("a member counts the commits in its own directory only", async () => {
    const dir = repo();
    commit(dir, "chore: start", { "api/a.ts": "1", "web/b.ts": "1" });
    const api = join(dir, "api");
    const first = git(dir, "rev-parse", "HEAD");
    await cut(api, first, "1.0.0");
    commit(dir, "feat: a web feature", { "web/b.ts": "2" });
    expect(await nextRelease({ cwd: api }).then(() => null, (e: ReleaseNextError) => e.code)).toBe("release-next-unchanged");
    commit(dir, "fix: an api fix", { "api/a.ts": "2" });
    const r = await nextRelease({ cwd: api });
    expect(r.label).toBe("1.0.1");
    expect(r.commits.map((c) => c.subject)).toEqual(["fix: an api fix"]);
  });
});
