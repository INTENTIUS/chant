/**
 * #4800 — the note size limit products call: `noteLimit` by forge and
 * `fitNote`, the cut SQL Yodeler's `COMMENT_LIMIT` and terragucci's
 * `MAX_NOTE` each made.
 */

import { describe, expect, test } from "vitest";
import { fitNote, GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT, NOTE_CUT_LINE, noteLimit } from "./plan-summary";

describe("noteLimit", () => {
  test("GitLab's on GitLab, GitHub's on GitHub, Forgejo and an unknown forge", () => {
    expect(noteLimit("gitlab")).toBe(GITLAB_NOTE_LIMIT);
    expect(noteLimit("github")).toBe(GITHUB_COMMENT_LIMIT);
    expect(noteLimit("forgejo")).toBe(GITHUB_COMMENT_LIMIT);
    expect(noteLimit()).toBe(GITHUB_COMMENT_LIMIT);
  });
});

describe("fitNote", () => {
  test("a body that fits is returned as it is", () => {
    expect(fitNote("x".repeat(100), { limit: 100 })).toBe("x".repeat(100));
  });

  test("a longer one is cut, with the closing line, to exactly the limit", () => {
    const out = fitNote("x".repeat(GITHUB_COMMENT_LIMIT + 10));
    expect(out.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
    const cut = GITHUB_COMMENT_LIMIT - NOTE_CUT_LINE.replace("{cut}", String(GITHUB_COMMENT_LIMIT)).length;
    expect(out).toBe("x".repeat(cut) + NOTE_CUT_LINE.replace("{cut}", String(cut)));
  });

  test("the product's own closing line, with the characters kept", () => {
    expect(fitNote("abcdefghijklmnopqrstuvwxyz", { limit: 20, tail: "\n(cut at {cut})" })).toBe("abcdefgh\n(cut at 8)");
  });

  test("never splits a surrogate pair", () => {
    const out = fitNote("ab" + "😀".repeat(20), { limit: 12, tail: "|" });
    expect(out).toBe("ab" + "😀".repeat(4) + "|");
    expect(out.length).toBeLessThanOrEqual(12);
  });

  test("a closing line longer than the limit still keeps to it", () => {
    expect(fitNote("x".repeat(50), { limit: 5, tail: "a closing line that is long" }).length).toBe(5);
  });
});
