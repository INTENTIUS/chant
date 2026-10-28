/**
 * The job summary and stale marking (#4628), with fake forges: the note job
 * adds the note to GITHUB_STEP_SUMMARY without its hidden lines, the note
 * carries the target branch's commit it was posted against, and after a
 * push `markStaleNotes` marks each open pull request's note posted against
 * another commit stale, names the comment that previews again and sets the
 * plan status back to pending, on GitHub, GitLab and Forgejo. Written for
 * the ci-products post-merge pass.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { markStaleNotes, planNoteSummary, postPlanReport, prNoteStaleMarker, prNoteTipMarker } from "./pr-post";
import { prNoteMarker, type PrReport } from "./pr-loop";
import { assertProductWords } from "./ci-product-words";
import { PLYWOOD } from "./__fixtures__/product-words";
import type { ForgeKind, ForgeStatus, OpenPullRequest, PrForge } from "./pr-forge";

const REPORT = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "pr-plan.golden.json"), "utf-8")) as PrReport;
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "chant-pr-stale-"));
  dirs.push(d);
  return d;
};

/** A forge that keeps notes by marker, lists open pull requests and records statuses. */
function fakeForge(kind: ForgeKind, open: OpenPullRequest[] = []) {
  const notes = new Map<string, string>();
  const statuses: Array<{ sha: string; status: ForgeStatus }> = [];
  const key = (pr: number, marker: string) => `${pr}\u0000${marker}`;
  const forge = {
    kind,
    host: kind === "gitlab" ? "gitlab.com" : kind === "forgejo" ? "codeberg.org" : "github.com",
    async setStatus(sha: string, status: ForgeStatus) {
      statuses.push({ sha, status });
    },
    async upsertNote(pr: number, marker: string, body: string) {
      notes.set(key(pr, marker), body);
      return "1";
    },
    async findComment(pr: number, marker: string) {
      const body = notes.get(key(pr, marker));
      return body === undefined ? undefined : { id: 1, body };
    },
    async openPullRequests(base: string) {
      return open.filter((p) => p.base === base);
    },
  } as unknown as PrForge;
  return { forge, notes, statuses, key };
}

const pr = (number: number, headSha = "c".repeat(40)): OpenPullRequest => ({ number, head: `feature-${number}`, headSha, base: "main", fork: false });

describe("the job summary (#4628)", () => {
  test("the note job adds the note, without its hidden lines, to the summary file", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "pr-plan.json"), JSON.stringify(REPORT));
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "earlier\n");
    const { forge } = fakeForge("github");
    const r = await postPlanReport({ forge, dir, pr: REPORT.pr!, head: REPORT.head, env: REPORT.env, baseTip: OLD, summaryFile: summary });
    expect(r.warnings).toEqual([]);
    const text = readFileSync(summary, "utf-8");
    expect(text.startsWith("earlier\n")).toBe(true);
    expect(text).toContain("### chant plan for `prod`");
    expect(text).not.toContain("<!-- chant-pr");
  });

  test("planNoteSummary drops the marker, tip and stale lines", () => {
    expect(planNoteSummary([prNoteMarker("prod"), "### heading", prNoteTipMarker(OLD), prNoteStaleMarker(NEW)].join("\n"))).toBe("### heading");
  });
});

describe("the tip line (#4628)", () => {
  test("the note carries the target branch's commit it was posted against, after the defusing", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "pr-plan.json"), JSON.stringify({ ...REPORT, message: `x ${prNoteTipMarker(NEW)}` }));
    const { forge, notes, key } = fakeForge("github");
    await postPlanReport({ forge, dir, pr: REPORT.pr!, head: REPORT.head, env: REPORT.env, baseTip: OLD });
    const body = notes.get(key(REPORT.pr!, prNoteMarker(REPORT.env)))!;
    expect(body).toContain(prNoteTipMarker(OLD));
    // The report's own copy is defused, so a change cannot name another tip.
    expect(body).not.toContain(prNoteTipMarker(NEW));
  });

  test("no tip, no line", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "pr-plan.json"), JSON.stringify(REPORT));
    const { forge, notes, key } = fakeForge("github");
    await postPlanReport({ forge, dir, pr: REPORT.pr!, head: REPORT.head, env: REPORT.env });
    expect(notes.get(key(REPORT.pr!, prNoteMarker(REPORT.env)))).not.toContain("chant-pr-tip");
  });
});

describe("markStaleNotes (#4628)", () => {
  const marker = prNoteMarker("prod");
  const noteAt = (tip: string) => [marker, "### plywood preview for `prod`", "", "body", prNoteTipMarker(tip), ""].join("\n");

  for (const kind of ["github", "gitlab", "forgejo"] as const) {
    test(`${kind}: a note posted against another commit is marked stale and its status goes back to pending`, async () => {
      const { forge, notes, statuses, key } = fakeForge(kind, [pr(7, "d".repeat(40))]);
      notes.set(key(7, marker), noteAt(OLD));
      const words = assertProductWords(PLYWOOD);
      const done = await markStaleNotes({ forge, branch: "main", tip: NEW, env: "prod", previewComment: true, words });
      expect(done).toEqual({ marks: [{ pr: 7, marked: true }], warnings: [] });
      const body = notes.get(key(7, marker))!;
      const lines = body.split("\n");
      expect(lines[0]).toBe(marker);
      expect(lines[1]).toBe(`> Stale: main moved to \`${NEW.slice(0, 12)}\` since this preview was posted against \`${OLD.slice(0, 12)}\`, so it may no longer show what the merge does; comment \`/plywood preview\` to preview again.`);
      expect(lines[2]).toBe(prNoteStaleMarker(NEW));
      expect(body).toContain("body");
      expect(statuses).toEqual([{ sha: "d".repeat(40), status: expect.objectContaining({ context: "plywood/preview", state: "pending" }) }]);
    });
  }

  test("without the preview comment the line asks for a push", async () => {
    const { forge, notes, key } = fakeForge("github", [pr(7)]);
    notes.set(key(7, marker), noteAt(OLD));
    await markStaleNotes({ forge, branch: "main", tip: NEW, env: "prod" });
    expect(notes.get(key(7, marker))).toContain("push a commit to plan again");
  });

  test("a current note, one already marked, one with no tip line and a pull request with no note are left alone", async () => {
    const { forge, notes, statuses, key } = fakeForge("github", [pr(1), pr(2), pr(3), pr(4)]);
    notes.set(key(1, marker), noteAt(NEW));
    notes.set(key(2, marker), [marker, "> Stale: x", prNoteStaleMarker(NEW), "", "body", prNoteTipMarker(OLD)].join("\n"));
    notes.set(key(3, marker), [marker, "an old note"].join("\n"));
    const done = await markStaleNotes({ forge, branch: "main", tip: NEW, env: "prod" });
    expect(done.marks).toEqual([
      { pr: 1, skipped: "the note is current" },
      { pr: 2, skipped: "already marked" },
      { pr: 3, skipped: "the note names no target branch commit" },
      { pr: 4, skipped: "no note" },
    ]);
    expect(statuses).toEqual([]);
  });

  test("marking again after another push replaces the stale line", async () => {
    const third = "e".repeat(40);
    const { forge, notes, key } = fakeForge("github", [pr(7)]);
    notes.set(key(7, marker), noteAt(OLD));
    await markStaleNotes({ forge, branch: "main", tip: NEW, env: "prod" });
    await markStaleNotes({ forge, branch: "main", tip: third, env: "prod" });
    const body = notes.get(key(7, marker))!;
    expect(body.split("\n").filter((l) => l.startsWith("> Stale: "))).toHaveLength(1);
    expect(body).toContain(prNoteStaleMarker(third));
    expect(body).not.toContain(prNoteStaleMarker(NEW));
  });

  test("a forge that cannot list open pull requests is refused", async () => {
    const { forge } = fakeForge("github");
    delete (forge as { openPullRequests?: unknown }).openPullRequests;
    await expect(markStaleNotes({ forge, branch: "main", tip: NEW, env: "prod" })).rejects.toThrow(/lists the open pull requests/);
  });
});
