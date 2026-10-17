/**
 * #4031: signed ci tags. With `ci.green.signedSince` declared, a green or
 * revoked tag on a commit made since counts only when its annotation
 * carries a statement signed by a runner key `.chant/trust.json` lists for
 * a principal holding the `runner` role. The tick signs what it makes;
 * `ci tick`, `ci list`, `ci last-green` and the release cut ignore and
 * report a hand-pushed tag. A tag on an older commit counts unsigned.
 */

import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciList, ciTick, formatList, formatTick, greenAnnotation, lastGreen, revokedAnnotation, evaluateCommit, type LastGreenDocument } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import type { CiGreen } from "./declaration";
import { sshFromEd25519 } from "./trust/dsse";
import { verifyCiTagStatement } from "./trust/ci-tag-statement";
import lastGreenSchema from "./ci-last-green.schema.json";
import listSchema from "./ci-list.schema.json";

afterAll(cleanScratch);

const NOW = new Date("2026-10-06T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
/** Commits made 10 hours ago or later need a signed tag. */
const SIGNED_SINCE = hoursAgo(10);

const GREEN = { branch: "main", phases: { lint: ["lint"], test: ["test"] }, require: ["lint", "test"], signedSince: SIGNED_SINCE };
const run = (id: number, name: string, conclusion: string): CheckRun => ({ id, name, status: "completed", conclusion, completedAt: null, url: null });
const PASSING = [run(1, "lint", "success"), run(2, "test", "success")];
const FAILING = [run(1, "lint", "success"), run(9, "test", "failure")];

function fakeForge(runs: Map<string, CheckRun[]>): CiForge {
  return { kind: "github", checkRuns: async (sha) => runs.get(sha) ?? [] };
}

/** A throwaway runner key: its PEM and its ssh public key line. */
function runnerKey(): { pem: string; ssh: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), ssh: sshFromEd25519(Buffer.from(jwk.x, "base64url")) };
}

function gitAt(cwd: string, date: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

function commitAt(root: string, hours: number, file: string): string {
  writeFiles(root, { [file]: `${file} ${hours}\n` });
  gitAt(root, hoursAgo(hours), "add", "-A");
  gitAt(root, hoursAgo(hours), "commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

const BOT = runnerKey();

/**
 * A checkout on main with a bare origin, declaring `ci.green` with
 * `signedSince` and listing BOT as the runner `ci-bot`, which holds the
 * runner role unless `roles` says otherwise.
 */
function workspace(opts: { roles?: Record<string, string[]>; green?: unknown } = {}): { root: string; origin: string } {
  const origin = scratchDir("chant-ci-signed-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-ci-signed-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, {
    "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green: opts.green ?? GREEN } }),
    ".chant/trust.json": JSON.stringify({ schema: 1, runners: [{ principal: "ci-bot", class: "runner", key: BOT.ssh }], roles: opts.roles ?? { runner: ["ci-bot"] } }),
    "app/a.txt": "a\n",
  });
  git(root, "remote", "add", "origin", origin);
  return { root, origin };
}

/** Push a tag made by hand, the way someone with push rights could go around CI. */
function handTag(root: string, tag: string, sha: string, message: string, hours = 0): void {
  gitAt(root, hoursAgo(hours), "tag", "-a", "-m", message, tag, sha);
  git(root, "push", "-q", "origin", `refs/tags/${tag}`);
}

const greenOf = (sha: string) => greenAnnotation(GREEN_DECL, sha, evaluateCommit(GREEN_DECL, PASSING), NOW);
const GREEN_DECL: CiGreen = {
  branch: "main",
  window: "24h",
  phases: [
    { name: "lint", runs: ["lint"], skipped: "fail", pointer: "" },
    { name: "test", runs: ["test"], skipped: "fail", pointer: "" },
  ],
  require: ["lint", "test"],
  signedSince: SIGNED_SINCE,
  pointer: "/ci/green",
};

describe("signed ci tags (#4031)", () => {
  const readLast = contract(lastGreenSchema);
  const readList = contract(listSchema);

  test("a hand-pushed green tag is ignored and reported by ci tick, ci list and ci last-green", async () => {
    const { root } = workspace();
    const a = commitAt(root, 5, "app/a.txt");
    const b = commitAt(root, 3, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    // b never passed, and someone pushes a green tag for it by hand, with the record a tick would write.
    handTag(root, `ci/green/${b}`, b, greenOf(b));
    const runs = new Map([
      [a, PASSING],
      [b, FAILING],
    ]);

    const tick = await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW, runnerKey: BOT.pem });
    expect(tick.made).toEqual([`ci/green/${a}`]);
    expect(tick.signer).toBe("ci-bot");
    const atB = tick.commits.find((c) => c.sha === b)!;
    expect(atB.before).toBe("none");
    expect(atB.ignored).toEqual([{ tag: `ci/green/${b}`, status: "unsigned", reason: expect.stringContaining("carries no statement signed by a runner key") }]);
    expect(formatTick(tick)).toContain(`ignored ci/green/${b} (unsigned)`);

    // The tick's own tag carries a statement that verifies for ci-bot.
    const note = git(root, "tag", "-l", "--format=%(contents)", `ci/green/${a}`);
    const record = JSON.parse(note.slice(note.indexOf("{")));
    expect(record.statement.signatures).toHaveLength(1);
    expect(verifyCiTagStatement(record, { sha: a, kind: "green", branch: "main" }, [{ principal: "ci-bot", class: "runner", key: BOT.ssh }], { runner: ["ci-bot"] })).toMatchObject({ status: "signed", signer: "ci-bot" });

    const last = lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>;
    readLast.expectValid(last);
    expect(last.commit?.sha).toBe(a);
    expect(last.ignored.map((t) => [t.tag, t.status])).toEqual([[`ci/green/${b}`, "unsigned"]]);

    const list = await ciList({ cwd: root, now: NOW });
    readList.expectValid(list);
    const listed = (list as Extract<typeof list, { commits: unknown }>).commits;
    expect(listed.map((c) => [c.sha, c.state, c.green?.signer ?? null, c.ignored.map((t) => t.status)])).toEqual([
      [b, "undecided", null, ["unsigned"]],
      [a, "green", "ci-bot", []],
    ]);
    expect(formatList(list as Extract<typeof list, { commits: unknown }>)).toContain(`ignored ci/green/${b} (unsigned)`);
  });

  test("a tag on a commit older than ci.green.signedSince is accepted unsigned", async () => {
    const { root } = workspace();
    const old = commitAt(root, 20, "app/old.txt");
    const fresh = commitAt(root, 2, "app/fresh.txt");
    git(root, "push", "-q", "origin", "main");
    // A tag made the way every tag was made before #4031: no statement.
    handTag(root, `ci/green/${old}`, old, greenOf(old), 19);

    const last = lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>;
    expect(last.commit?.sha).toBe(old);
    expect(last.ignored).toEqual([]);
    const list = (await ciList({ cwd: root, now: NOW })) as Extract<Awaited<ReturnType<typeof ciList>>, { commits: unknown }>;
    expect(list.commits.map((c) => [c.sha, c.state, c.green?.signer ?? null])).toEqual([
      [fresh, "undecided", null],
      [old, "green", null],
    ]);
    // A backdated tag on a newer commit gains nothing: the commit's time decides, not the tag's.
    handTag(root, `ci/green/${fresh}`, fresh, greenOf(fresh), 30);
    expect((lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>).commit?.sha).toBe(old);
  });

  test("a hand-pushed revoked tag without a valid statement is ignored and reported, and the tick's own revocation is signed", async () => {
    const { root } = workspace();
    const a = commitAt(root, 4, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const runs = new Map([[a, PASSING]]);
    await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW, runnerKey: BOT.pem });

    // Someone revokes the green commit by hand.
    handTag(root, `ci/revoked/${a}`, a, revokedAnnotation(GREEN_DECL, a, { phase: "test", run: { name: "test", id: 9, status: "completed", conclusion: "failure", url: null, verdict: "fail" } }, NOW));
    const last = lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>;
    expect(last.commit?.sha).toBe(a);
    expect(last.ignored.map((t) => [t.tag, t.status])).toEqual([[`ci/revoked/${a}`, "unsigned"]]);
    const list = (await ciList({ cwd: root, now: NOW })) as Extract<Awaited<ReturnType<typeof ciList>>, { commits: unknown }>;
    expect(list.commits[0]).toMatchObject({ sha: a, state: "green", revoked: null, ignored: [{ tag: `ci/revoked/${a}`, status: "unsigned" }] });

    // When a really goes red, the tick can't revoke it while the hand-made tag holds the name, and says so.
    runs.set(a, FAILING);
    const blocked = await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW, runnerKey: BOT.pem });
    expect(blocked.made).toEqual([]);
    expect(blocked.commits[0]).toMatchObject({ sha: a, before: "green", blocked: `ci/revoked/${a}` });
    expect(formatTick(blocked)).toContain(`did not make ci/revoked/${a}: an ignored tag holds the name`);

    // Once a person deletes it, the tick revokes a with a signed tag, which counts.
    git(root, "push", "-q", "origin", `:refs/tags/ci/revoked/${a}`);
    const revoked = await ciTick({ cwd: root, forge: fakeForge(runs), now: NOW, runnerKey: BOT.pem });
    expect(revoked.made).toEqual([`ci/revoked/${a}`]);
    const why = git(root, "tag", "-l", "--format=%(contents)", `ci/revoked/${a}`);
    expect(JSON.parse(why.slice(why.indexOf("{"))).statement).toBeDefined();
    expect((lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>).commit).toBeNull();
  });

  test("a statement by another key, by a runner without the role, or for another commit does not count", async () => {
    const { root } = workspace({ roles: { runner: ["ci-bot"] } });
    const a = commitAt(root, 5, "app/a.txt");
    const b = commitAt(root, 4, "app/b.txt");
    const c = commitAt(root, 3, "app/c.txt");
    git(root, "push", "-q", "origin", "main");
    const mallory = runnerKey();
    const signer = (key: { pem: string; ssh: string }, principal: string) => ({ principal, key: createPrivateKey(key.pem), publicKey: key.ssh });
    // a: signed by a key trust.json does not list.
    handTag(root, `ci/green/${a}`, a, greenAnnotation(GREEN_DECL, a, evaluateCommit(GREEN_DECL, PASSING), NOW, signer(mallory, "ci-bot")));
    // b: ci-bot's real signature over c's record, copied onto b's tag.
    const forC = greenAnnotation(GREEN_DECL, c, evaluateCommit(GREEN_DECL, PASSING), NOW, signer(BOT, "ci-bot"));
    handTag(root, `ci/green/${b}`, b, forC);
    const list = (await ciList({ cwd: root, now: NOW })) as Extract<Awaited<ReturnType<typeof ciList>>, { commits: unknown }>;
    expect(list.commits.map((x) => [x.sha, x.state, x.ignored.map((t) => t.status)])).toEqual([
      [c, "undecided", []],
      [b, "undecided", ["mismatch"]],
      [a, "undecided", ["untrusted"]],
    ]);

    // A runner the trust file lists but grants no runner role is not trusted either.
    const unroled = workspace({ roles: {} });
    const d = commitAt(unroled.root, 2, "app/d.txt");
    git(unroled.root, "push", "-q", "origin", "main");
    handTag(unroled.root, `ci/green/${d}`, d, greenAnnotation(GREEN_DECL, d, evaluateCommit(GREEN_DECL, PASSING), NOW, signer(BOT, "ci-bot")));
    const last = lastGreen({ cwd: unroled.root }) as Extract<LastGreenDocument, { branch: string }>;
    expect(last.commit).toBeNull();
    expect(last.ignored[0]).toMatchObject({ status: "untrusted", reason: expect.stringContaining("holds no runner role") });
    // And the tick refuses to sign with it, before it tags anything.
    await expect(ciTick({ cwd: unroled.root, forge: fakeForge(new Map([[d, PASSING]])), now: NOW, runnerKey: BOT.pem })).rejects.toThrow(/holds no runner role/);
  });

  test("the tick needs a runner key once signedSince is set, and refuses one trust.json does not list", async () => {
    const { root } = workspace();
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    const forge = fakeForge(new Map([[a, PASSING]]));
    await expect(ciTick({ cwd: root, forge, now: NOW })).rejects.toThrow(/needs a statement signed by a runner key, and none was given/);
    await expect(ciTick({ cwd: root, forge, now: NOW, runnerKey: runnerKey().pem })).rejects.toThrow(/lists no runner with this key/);
    expect(git(root, "tag", "-l")).toBe("");
    // A dry run decides without a key.
    expect((await ciTick({ cwd: root, forge, now: NOW, dryRun: true })).made).toEqual([`ci/green/${a}`]);
  });

  test("without signedSince every tag counts, as before", async () => {
    const { root } = workspace({ green: { branch: "main", phases: GREEN.phases, require: GREEN.require } });
    const a = commitAt(root, 2, "app/a.txt");
    git(root, "push", "-q", "origin", "main");
    git(root, "tag", `ci/green/${a}`, a);
    const last = lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>;
    expect(last.commit?.sha).toBe(a);
    expect(last.ignored).toEqual([]);
  });

  test("last-green --from walks from another revision", async () => {
    const { root } = workspace();
    const a = commitAt(root, 4, "app/a.txt");
    const b = commitAt(root, 3, "app/b.txt");
    git(root, "push", "-q", "origin", "main");
    await ciTick({ cwd: root, forge: fakeForge(new Map([[a, PASSING], [b, PASSING]])), now: NOW, runnerKey: BOT.pem });
    expect((lastGreen({ cwd: root }) as Extract<LastGreenDocument, { branch: string }>).commit?.sha).toBe(b);
    const from = lastGreen({ cwd: root, from: a }) as Extract<LastGreenDocument, { branch: string }>;
    expect(from).toMatchObject({ ref: a, commit: { sha: a } });
    expect(lastGreen({ cwd: root, from: "nope" })).toMatchObject({ error: { code: "revision-unknown" } });
  });
});
