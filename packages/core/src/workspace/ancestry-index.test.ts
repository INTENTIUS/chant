/**
 * #4032: the signer-position lookup and the decision windows of the intent
 * walk read the commit graph once, in process, where they used to start a
 * git process per question. Each answer must stay what git gives.
 *
 * The repository has merges of branches that forked at different points, a
 * branch merged twice, and a branch never merged, so a commit's way into the
 * first-parent line is not its date order.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { descendants } from "./intent";
import { SignerPositions, type SignerVersion } from "./trust/rotation";
import { TestRepo } from "./trust/test-repo";

let r: TestRepo;
let all: string[];
let unmerged: string;

function version(n: number, commit: string): SignerVersion {
  return { version: n, commit, digest: `d${n}`, threshold: 1, signers: [], excluded: [], signedBy: [] };
}

beforeAll(() => {
  r = new TestRepo("4032-ancestry");
  r.commit("m1");
  r.git(["branch", "a"]);
  r.commit("m2");
  r.git(["checkout", "-q", "a"]);
  r.commit("a1");
  r.git(["branch", "b"]);
  r.commit("a2");
  r.git(["checkout", "-q", "b"]);
  r.commit("b1");
  r.commit("b2");
  r.git(["checkout", "-q", "main"]);
  r.git(["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge a", "a"]);
  r.commit("m3");
  r.git(["checkout", "-q", "a"]);
  r.commit("a3");
  r.git(["checkout", "-q", "main"]);
  r.git(["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge b", "b"]);
  r.git(["merge", "-q", "--no-ff", "--no-gpg-sign", "-m", "merge a again", "a"]);
  r.commit("m4");
  r.git(["checkout", "-q", "-b", "side", "HEAD~2"]);
  unmerged = r.commit("never merged");
  r.git(["checkout", "-q", "main"]);
  all = r.git(["rev-list", "--all"]).split("\n").filter(Boolean);
});

afterAll(() => r.cleanup());

describe("SignerPositions (#4032)", () => {
  test("a full commit id is placed where git merge-base places it, for every commit", () => {
    const base = r.head();
    const line = r.git(["rev-list", "--first-parent", base]).split("\n").filter(Boolean);
    // Versions made at the oldest, a middle and the newest first-parent commits.
    const history = { versions: [version(1, line.at(-1)!), version(2, line[Math.floor(line.length / 2)]), version(3, line[0])] };
    const fast = new SignerPositions(r.dir, base, history);
    const slow = new SignerPositions(r.dir, base, history);
    expect(all).toContain(unmerged);
    for (const c of all) {
      // An abbreviated id takes the old path, one git merge-base per step of a binary search.
      expect(fast.versionFor(c)?.version ?? null, c).toBe(slow.versionFor(c.slice(0, 12))?.version ?? null);
    }
    expect(fast.versionFor(unmerged)?.version).toBe(3);
  });

  test("an id the repository doesn't have is judged by the latest version, as before", () => {
    const base = r.head();
    const p = new SignerPositions(r.dir, base, { versions: [version(1, base)] });
    expect(p.versionFor("0".repeat(40))?.version).toBe(1);
  });
});

describe("descendants (#4032)", () => {
  test("matches git rev-list --ancestry-path for every pair of commits", () => {
    for (const rev of [r.head(), unmerged]) {
      for (const c of all) {
        const expected = new Set([c, ...r.git(["rev-list", "--ancestry-path", `${c}..${rev}`]).split("\n").filter(Boolean)]);
        expect(descendants(r.dir, c, rev), `${c}..${rev}`).toEqual(expected);
      }
    }
  });

  test("an abbreviated id, or one the repository doesn't have, still answers", () => {
    const short = all.at(-1)!.slice(0, 12);
    const listed = r.git(["rev-list", "--ancestry-path", `${short}..${r.head()}`]).split("\n").filter(Boolean);
    expect(listed.length).toBeGreaterThan(0);
    expect(descendants(r.dir, short, r.head())).toEqual(new Set([short, ...listed]));
    expect(descendants(r.dir, "0".repeat(40), r.head())).toEqual(new Set(["0".repeat(40)]));
  });
});
