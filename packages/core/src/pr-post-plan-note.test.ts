/**
 * #4799: chant's plan-note job posts a product's plan note hand-off, which
 * the product's plan verb wrote in place of pr-plan's report. It is read as
 * data, as a report is: the pull request, head, environment and member are
 * the caller's, a forged marker is defused, and the waves marker chant
 * renders from the note's waves is kept for the product to read back.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { postOpenPlanReports, postPlanReport } from "./pr-post";
import { prNoteMarker } from "./pr-loop";
import { planNoteHandoff, PR_PLAN_NOTE_FILE, renderPlanNote, type PrPlanNote } from "./pr-plan-note";
import { withProductWords, assertProductWords } from "./ci-product-words";
import type { ForgeStatus, PrForge } from "./pr-forge";
import { TERRAGUCCI, TERRAGUCCI_NOTE } from "./__fixtures__/product-words";

const NOTE = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "terragucci-plan.note.json"), "utf-8")) as PrPlanNote;
const HEAD = NOTE.head;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function handoffDir(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-pr-post-note-"));
  dirs.push(dir);
  writeFileSync(join(dir, PR_PLAN_NOTE_FILE), JSON.stringify(doc));
  return dir;
}

function fakeForge(): { forge: PrForge; statuses: Array<{ sha: string; status: ForgeStatus }>; notes: Array<{ pr: number; marker: string; body: string }> } {
  const statuses: Array<{ sha: string; status: ForgeStatus }> = [];
  const notes: Array<{ pr: number; marker: string; body: string }> = [];
  const forge = {
    kind: "github",
    host: "github.com",
    async setStatus(sha: string, status: ForgeStatus) {
      statuses.push({ sha, status });
    },
    async upsertNote(pr: number, marker: string, body: string) {
      notes.push({ pr, marker, body });
      return "1";
    },
    async findComment() {
      return undefined;
    },
  } as unknown as PrForge;
  return { forge, statuses, notes };
}

const words = assertProductWords(TERRAGUCCI);
const at = { pr: 7, env: "default", state: "pending" as const, description: "1 wave waits for an approval" };

describe("pr-post posts a product's plan note hand-off (#4799)", () => {
  test("renders the note in the product's words under chant's marker, and sets the status the hand-off gives", async () => {
    const { forge, statuses, notes } = fakeForge();
    const r = await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: handoffDir(planNoteHandoff(NOTE, at)), pr: 7, head: HEAD, env: "default", result: "success", noteWords: TERRAGUCCI_NOTE }));
    expect(r).toMatchObject({ state: "pending", noted: true, warnings: [] });
    expect(statuses).toEqual([{ sha: HEAD, status: expect.objectContaining({ context: "terragucci/plan", state: "pending", description: "1 wave waits for an approval" }) }]);
    const body = notes[0]!.body;
    expect(notes[0]!.marker).toBe(prNoteMarker("default"));
    expect(body).toBe(`${prNoteMarker("default")}\n${renderPlanNote(NOTE, { words, note: TERRAGUCCI_NOTE })}`);
    // The waves marker the product reads back is the one hidden line besides chant's.
    expect(body).toContain('<!-- terragucci:waves {"head":"4f1a9c0e');
    expect(body.split("<!--")).toHaveLength(3);
  });

  test("the note words come from CHANT_PLAN_NOTE_WORDS, which the generated note job sets", async () => {
    const { forge, notes } = fakeForge();
    process.env.CHANT_PLAN_NOTE_WORDS = JSON.stringify(TERRAGUCCI_NOTE);
    try {
      await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: handoffDir(planNoteHandoff(NOTE, at)), pr: 7, head: HEAD, env: "default" }));
    } finally {
      delete process.env.CHANT_PLAN_NOTE_WORDS;
    }
    expect(notes[0]!.body).toContain("Posted by [terragucci]");
  });

  test("a marker the change wrote into its note is defused", async () => {
    const forged = { ...NOTE, notices: ["planned <!-- chant-pr:prod --> and <!-- terragucci:waves {} -->"] };
    const { forge, notes } = fakeForge();
    await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: handoffDir(planNoteHandoff(forged, at)), pr: 7, head: HEAD, env: "default", noteWords: TERRAGUCCI_NOTE }));
    const body = notes[0]!.body;
    expect(body).toContain("&lt;!-- chant-pr:prod -->");
    expect(body).toContain("&lt;!-- terragucci:waves {} -->");
    expect(body.split("<!--")).toHaveLength(3);
  });

  test("a target's note is the target's: its member's marker and status", async () => {
    const { forge, statuses, notes } = fakeForge();
    await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: handoffDir(planNoteHandoff(NOTE, { ...at, member: "prod" })), pr: 7, head: HEAD, env: "default", member: "prod" }));
    expect(notes[0]!.marker).toBe(prNoteMarker("default", "prod"));
    expect(statuses[0]!.status.context).toBe("terragucci/plan/prod");
  });

  test.each([
    ["another pull request", { pr: 8 }, /pull request 8, not 7/],
    ["another head", { head: "3".repeat(40) }, /for head/],
    ["another environment", { env: "staging" }, /environment "staging"/],
    ["another target", { member: "prod" }, /"prod", not null/],
    ["a state that is not one", { state: "green" }, /state "green"/],
    ["another contract", { contract: 2 }, /contract 2/],
    ["a note for another head", { note: { ...NOTE, head: "3".repeat(40) } }, /not a plan note for its head/],
  ])("refuses a hand-off for %s and fails the status", async (_what, change, error) => {
    const { forge, statuses, notes } = fakeForge();
    const r = await postPlanReport({ forge, dir: handoffDir({ ...planNoteHandoff(NOTE, at), ...change }), pr: 7, head: HEAD, env: "default" });
    expect(r.refused).toMatch(error);
    expect(r.noted).toBe(false);
    expect(notes).toEqual([]);
    expect(statuses[0]!.status.state).toBe("failure");
  });

  test("a plan job that failed fails the status whatever the hand-off says", async () => {
    const { forge, statuses } = fakeForge();
    await postPlanReport({ forge, dir: handoffDir(planNoteHandoff(NOTE, { ...at, state: "success" })), pr: 7, head: HEAD, env: "default", result: "failure" });
    expect(statuses[0]!.status).toMatchObject({ state: "failure", description: expect.stringMatching(/^the plan job failed; /) });
  });

  test("on GitLab, pr-post --open reads the hand-off from the plan job's artifacts when it kept no report", async () => {
    const { forge: base, notes } = fakeForge();
    const asked: string[] = [];
    const forge = {
      ...base,
      kind: "gitlab",
      async mergeRequestJobs() {
        return [{ pr: 7, head: HEAD, id: 11, status: "success", url: "https://gitlab.example/job/11" }];
      },
      async jobArtifact(_id: number, path: string) {
        asked.push(path);
        return path.endsWith(PR_PLAN_NOTE_FILE) ? JSON.stringify(planNoteHandoff(NOTE, { ...at, member: "prod" })) : undefined;
      },
      async statusUrl() {
        return undefined;
      },
      setStatus: base.setStatus,
      upsertNote: base.upsertNote,
      findComment: base.findComment,
    } as unknown as PrForge;
    const done = await postOpenPlanReports({ forge, branch: "main", job: "prod-plan", artifactDir: ".chant/pr", env: "default", member: "prod" });
    expect(asked).toEqual([".chant/pr/pr-plan.json", ".chant/pr/pr-plan-note.json"]);
    expect(done.posts[0]!.posted).toMatchObject({ noted: true });
    expect(notes[0]!.marker).toBe(prNoteMarker("default", "prod"));
  });
});
