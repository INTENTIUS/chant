/**
 * #4963: what pr-post does for the product plan's re-plan and for
 * sql-yodeler's notes. A re-plan narrowed to an argument the change does not
 * reach gets a "not affected" reply in place of the note and the status, as
 * terragucci's plan-note job replied; a `PrReport` carries the product's
 * marker as a hand-off does; and a hand-off may carry the product's own note
 * text, defused and cut, under chant's marker and the product's.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { postPlanReport } from "./pr-post";
import { prNoteMarker, type PrReport } from "./pr-loop";
import { planBodyHandoff, planNoteHandoff, PR_PLAN_NOTE_FILE, type PrPlanNote } from "./pr-plan-note";
import { withProductWords } from "./ci-product-words";
import { GITHUB_COMMENT_LIMIT } from "./plan-summary";
import type { ForgeStatus, PrForge } from "./pr-forge";
import { TERRAGUCCI, TERRAGUCCI_NOTE } from "./__fixtures__/product-words";

const NOTE = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "terragucci-plan.note.json"), "utf-8")) as PrPlanNote;
const REPORT = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "pr-plan.golden.json"), "utf-8")) as PrReport;
const HEAD = NOTE.head;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dirWith(file: string, doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-pr-post-replan-"));
  dirs.push(dir);
  writeFileSync(join(dir, file), JSON.stringify(doc));
  return dir;
}

function fakeForge(): { forge: PrForge; statuses: ForgeStatus[]; notes: Array<{ marker: string; body: string }>; comments: Array<{ pr: number; body: string }> } {
  const statuses: ForgeStatus[] = [];
  const notes: Array<{ marker: string; body: string }> = [];
  const comments: Array<{ pr: number; body: string }> = [];
  const forge = {
    kind: "github",
    host: "github.com",
    async setStatus(_sha: string, status: ForgeStatus) {
      statuses.push(status);
    },
    async upsertNote(_pr: number, marker: string, body: string) {
      notes.push({ marker, body });
      return "1";
    },
    async findComment() {
      return undefined;
    },
    async addComment(pr: number, body: string) {
      comments.push({ pr, body });
      return { id: 1 };
    },
  } as unknown as PrForge;
  return { forge, statuses, notes, comments };
}

const at = { pr: 7, env: "default", state: "success" as const, description: "nothing to plan" };
const markerWords = { ...TERRAGUCCI_NOTE, productMarker: "terragucci:plan" };
const nothing: PrPlanNote = { ...NOTE, nothing: true };

describe("a re-plan narrowed to an argument the change does not reach (#4963)", () => {
  test("gets a not-affected reply, and the note and the status stay as they were", async () => {
    const { forge, statuses, notes, comments } = fakeForge();
    const r = await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: dirWith(PR_PLAN_NOTE_FILE, planNoteHandoff(nothing, at)), pr: 7, head: HEAD, env: "default", result: "success", notAffected: "live/db" }));
    expect(comments).toEqual([{ pr: 7, body: "terragucci: live/db is not affected by this pull request, so nothing was planned." }]);
    expect(notes).toEqual([]);
    expect(statuses).toEqual([]);
    expect(r).toMatchObject({ noted: false, warnings: [] });
  });

  test("a PrReport that says nothing gets the same reply", async () => {
    const { forge, comments, notes } = fakeForge();
    await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: dirWith("pr-plan.json", { ...REPORT, status: "nothing" }), pr: REPORT.pr!, head: REPORT.head, env: REPORT.env, notAffected: "live/db" }));
    expect(comments).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  test("a plan that reaches the argument, an empty argument, or one that is not a plain word posts the note as before", async () => {
    for (const [note, arg] of [[NOTE, "live/db"], [nothing, ""], [nothing, "a b"], [nothing, "$(x)"]] as const) {
      const { forge, comments, notes } = fakeForge();
      await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: dirWith(PR_PLAN_NOTE_FILE, planNoteHandoff(note, at)), pr: 7, head: HEAD, env: "default", notAffected: arg }));
      expect(comments).toEqual([]);
      expect(notes).toHaveLength(1);
    }
  });

  test("a failed re-plan job posts its failure, not the reply", async () => {
    const { forge, comments, statuses } = fakeForge();
    await withProductWords(TERRAGUCCI, () => postPlanReport({ forge, dir: dirWith(PR_PLAN_NOTE_FILE, planNoteHandoff(nothing, at)), pr: 7, head: HEAD, env: "default", result: "failure", notAffected: "live/db" }));
    expect(comments).toEqual([]);
    expect(statuses[0]!.state).toBe("failure");
  });
});

describe("the product's marker on a PrReport (#4963)", () => {
  test("goes under chant's marker when the words name a productMarker, and the report's marker is plain words", async () => {
    const { forge, notes } = fakeForge();
    await postPlanReport({ forge, dir: dirWith("pr-plan.json", { ...REPORT, marker: "env=prod subject=abc_1" }), pr: REPORT.pr!, head: REPORT.head, env: REPORT.env, noteWords: { productMarker: "yodel:plan" } });
    const lines = notes[0]!.body.split("\n");
    expect(lines[0]).toBe(prNoteMarker(REPORT.env));
    expect(lines[1]).toBe("<!-- yodel:plan env=prod subject=abc_1 -->");
  });

  test("a marker that is not plain words, or no productMarker, leaves the note as before", async () => {
    const plain = fakeForge();
    await postPlanReport({ forge: plain.forge, dir: dirWith("pr-plan.json", REPORT), pr: REPORT.pr!, head: REPORT.head, env: REPORT.env });
    for (const [marker, noteWords] of [["env=prod --> <!-- x", { productMarker: "yodel:plan" }], ["env=prod", {}]] as const) {
      const { forge, notes } = fakeForge();
      await postPlanReport({ forge, dir: dirWith("pr-plan.json", { ...REPORT, marker }), pr: REPORT.pr!, head: REPORT.head, env: REPORT.env, noteWords });
      expect(notes[0]!.body).toBe(plain.notes[0]!.body);
    }
  });
});

describe("a hand-off of the product's own note text (#4963)", () => {
  const bodyAt = { pr: 7, head: HEAD, env: "default", member: "prod", state: "pending" as const, description: "the tenant set waits for an approval", marker: "env=prod" };

  test("posts the body under chant's marker and the product's line, defused, with the notices under it", async () => {
    const { forge, notes, statuses } = fakeForge();
    const body = "### yodel plan for `prod`\n\n3 tenants, 2 migrations pending <!-- yodel:plan env=staging -->\n";
    const r = await postPlanReport({ forge, dir: dirWith(PR_PLAN_NOTE_FILE, planBodyHandoff(body, bodyAt)), pr: 7, head: HEAD, env: "default", member: "prod", noteWords: { productMarker: "yodel:plan" }, notices: ["Op `yodel-drift` is overdue"] });
    expect(r).toMatchObject({ state: "pending", noted: true });
    expect(statuses[0]).toMatchObject({ context: "chant/plan/prod", state: "pending", description: "the tenant set waits for an approval" });
    expect(notes[0]!.body).toBe(`${prNoteMarker("default", "prod")}\n<!-- yodel:plan env=prod -->\n### yodel plan for \`prod\`\n\n3 tenants, 2 migrations pending &lt;!-- yodel:plan env=staging -->\n\n> Op \`yodel-drift\` is overdue\n`);
  });

  test("a body past the forge's limit is cut to it", async () => {
    const { forge, notes } = fakeForge();
    await postPlanReport({ forge, dir: dirWith(PR_PLAN_NOTE_FILE, planBodyHandoff("x".repeat(GITHUB_COMMENT_LIMIT * 2), bodyAt)), pr: 7, head: HEAD, env: "default", member: "prod" });
    expect(notes[0]!.body.length).toBeLessThanOrEqual(GITHUB_COMMENT_LIMIT);
  });

  test("a hand-off with both a note and a body is refused", async () => {
    const { forge, notes, statuses } = fakeForge();
    const r = await postPlanReport({ forge, dir: dirWith(PR_PLAN_NOTE_FILE, { ...planBodyHandoff("x", bodyAt), note: NOTE }), pr: 7, head: HEAD, env: "default", member: "prod" });
    expect(r.refused).toMatch(/both a note and a body/);
    expect(notes).toEqual([]);
    expect(statuses[0]!.state).toBe("failure");
  });
});
