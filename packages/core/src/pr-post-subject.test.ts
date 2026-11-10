/**
 * #4972: the note job compares the plan's subject with the previous note's.
 * A plan verb hands its subject (an id and named parts) in the plan note
 * hand-off; `pr-post` keeps it in a hidden line of the note, and on the
 * next post reads the previous note of the same environment and member,
 * and when the id differs adds a line in the note words saying what
 * changed. The plan job reads no note, so this works on GitHub, Forgejo and
 * GitLab (`pr-post --open`, from a pipeline of the target branch).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { postOpenPlanReports, postPlanReport, prNoteSubjectMarker, subjectInNote } from "./pr-post";
import { prNoteMarker } from "./pr-loop";
import { planBodyHandoff, planNoteHandoff, PLAN_SUBJECT_LIMIT, PR_PLAN_NOTE_FILE, sinceLastLine, subjectChanges, type PrPlanNote, type PrPlanNoteWords, type PrPlanSubject } from "./pr-plan-note";
import type { ForgeStatus, PrForge } from "./pr-forge";

const NOTE = JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", "pr-loop", "terragucci-plan.note.json"), "utf-8")) as PrPlanNote;
const HEAD = NOTE.head;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dirWith(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-pr-post-subject-"));
  dirs.push(dir);
  writeFileSync(join(dir, PR_PLAN_NOTE_FILE), JSON.stringify(doc));
  return dir;
}

/** A forge that keeps each note by its marker, so a second post reads the first. */
function keepingForge(kind: "github" | "forgejo" | "gitlab" = "github") {
  const notes = new Map<string, string>();
  const asked: string[] = [];
  const statuses: ForgeStatus[] = [];
  const forge = {
    kind,
    host: kind === "gitlab" ? "gitlab.com" : kind === "forgejo" ? "codeberg.org" : "github.com",
    async setStatus(_sha: string, status: ForgeStatus) {
      statuses.push(status);
    },
    async upsertNote(_pr: number, marker: string, body: string) {
      notes.set(marker, body);
      return "1";
    },
    async findComment(_pr: number, marker: string) {
      asked.push(marker);
      const body = notes.get(marker);
      return body === undefined ? undefined : { id: 1, body };
    },
  } as unknown as PrForge;
  return { forge, notes, asked, statuses };
}

/** sql-yodeler's words for what moved (its diffSubjects and describeMove), as note words. */
const YODEL_WORDS: PrPlanNoteWords = {
  productMarker: "yodel:plan",
  subjectParts: {
    environment: { changed: "environment: the environment changed: {items}" },
    applied: { added: "history changed: applied since: {items}", gone: "history changed: no longer recorded applied: {items}", changed: "history changed: recorded checksum changed (yodel repair): {items}" },
    pending: { added: "pending migrations changed: new pending migrations: {items}", gone: "pending migrations changed: no longer pending (gone from the directory): {items}", changed: "pending migrations changed: files changed: {items}" },
    live: { changed: "live schema changed: an object in the environment's live schema is not as it was" },
  },
};

const FIRST: PrPlanSubject = { id: "sha256:aaa111", parts: { environment: "prod", "applied/001_init": "c1", "pending/002_users": "c2", live: "f1" } };
const SECOND: PrPlanSubject = { id: "sha256:bbb222", parts: { environment: "prod", "applied/001_init": "c1", "pending/002_users": "c2x", "pending/003_orders": "c3", live: "f2" } };
const at = (subject?: PrPlanSubject) => ({ pr: 7, env: "default", member: "prod", state: "pending" as const, description: "waits for approval", marker: "env=prod", ...(subject ? { subject } : {}) });
// chant's own words adopt no older marker, so the only note read is the comparison's and the upsert's.
const post = (forge: PrForge, doc: unknown, extra: Partial<Parameters<typeof postPlanReport>[0]> = {}) =>
  postPlanReport({ forge, dir: dirWith(doc), pr: 7, head: HEAD, env: "default", member: "prod", noteWords: YODEL_WORDS, ...extra });

describe("the note keeps the plan's subject (#4972)", () => {
  test("in a hidden chant line the next post reads back, with no line said on the first post", async () => {
    const { forge, notes, asked } = keepingForge();
    const r = await post(forge, planNoteHandoff(NOTE, at(FIRST)));
    expect(r).toMatchObject({ noted: true, warnings: [] });
    const body = notes.get(prNoteMarker("default", "prod"))!;
    expect(body).toContain(`\n${prNoteSubjectMarker(FIRST)}\n`);
    expect(subjectInNote(body)).toEqual(FIRST);
    expect(body).not.toContain("Since the previous version");
    expect(asked).toEqual([prNoteMarker("default", "prod")]);
  });

  test("a hand-off without a subject reads no previous note and keeps no line", async () => {
    const { forge, notes, asked } = keepingForge();
    await post(forge, planNoteHandoff(NOTE, at()));
    expect(asked).toEqual([]);
    expect(notes.get(prNoteMarker("default", "prod"))).not.toContain("chant-pr-subject");
  });
});

describe("pr-post says what changed since the previous note (#4972)", () => {
  for (const kind of ["github", "forgejo"] as const) {
    test(`${kind}: a plan whose id moved gets the line in the product's words, part by part`, async () => {
      const { forge, notes } = keepingForge(kind);
      await post(forge, planNoteHandoff(NOTE, at(FIRST)));
      await post(forge, planNoteHandoff(NOTE, at(SECOND)));
      const body = notes.get(prNoteMarker("default", "prod"))!;
      expect(body).toContain(
        "Since the previous version of this note (`sha256:aaa111`): pending migrations changed: new pending migrations: 003_orders; pending migrations changed: files changed: 002_users; live schema changed: an object in the environment's live schema is not as it was.",
      );
      expect(subjectInNote(body)).toEqual(SECOND);
    });
  }

  test("the same id says nothing", async () => {
    const { forge, notes } = keepingForge();
    await post(forge, planNoteHandoff(NOTE, at(FIRST)));
    await post(forge, planNoteHandoff(NOTE, at(FIRST)));
    expect(notes.get(prNoteMarker("default", "prod"))).not.toContain("Since the previous version");
  });

  test("a body hand-off gets the line as a notice under its body", async () => {
    const { forge, notes } = keepingForge();
    await post(forge, planBodyHandoff("### yodel plan for `prod`\n", { ...at(FIRST), head: HEAD }));
    await post(forge, planBodyHandoff("### yodel plan for `prod`\n", { ...at({ id: "sha256:ccc", parts: { ...FIRST.parts, "applied/002_users": "c2" } }), head: HEAD }));
    const body = notes.get(prNoteMarker("default", "prod"))!;
    expect(body).toMatch(/^<!-- chant-pr:[^\n]*-->\n<!-- yodel:plan env=prod -->\n### yodel plan for `prod`\n\n> Since the previous version of this note \(`sha256:aaa111`\): history changed: applied since: 002_users\.\n<!-- chant-pr-subject:[A-Za-z0-9_-]+ -->\n$/);
  });

  test("only the same environment and member's note is compared", async () => {
    const { forge, notes } = keepingForge();
    await post(forge, planNoteHandoff(NOTE, at(FIRST)));
    await post(forge, planNoteHandoff(NOTE, { ...at(SECOND), member: "staging" }), { member: "staging" });
    expect(notes.get(prNoteMarker("default", "staging"))).not.toContain("Since the previous version");
  });

  test("a subject with no parts says only that the plan changed, in the words' sinceLastOnly", async () => {
    const { forge, notes } = keepingForge();
    await post(forge, planNoteHandoff(NOTE, at({ id: "d1" })));
    await post(forge, planNoteHandoff(NOTE, at({ id: "d2" })), { noteWords: { ...YODEL_WORDS, sinceLastOnly: "Moved since `{previous}`." } });
    expect(notes.get(prNoteMarker("default", "prod"))).toContain("Moved since `d1`.");
  });

  test("a subject too long for its line is kept by its id alone, and the next line says only that it changed", async () => {
    const { forge, notes } = keepingForge();
    const parts = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`applied/m${i}`, "x".repeat(64)]));
    await post(forge, planNoteHandoff(NOTE, at({ id: "big1", parts })));
    const kept = subjectInNote(notes.get(prNoteMarker("default", "prod"))!);
    expect(kept).toEqual({ id: "big1" });
    expect(prNoteSubjectMarker({ id: "big1", parts })!.length).toBeLessThanOrEqual(PLAN_SUBJECT_LIMIT);
    await post(forge, planNoteHandoff(NOTE, at({ id: "big2", parts })));
    expect(notes.get(prNoteMarker("default", "prod"))).toContain("The plan changed since the previous version of this note (`big1`).");
  });

  test("a forge that refuses the read is a warning, and the note is posted", async () => {
    const { forge, notes } = keepingForge();
    (forge as { findComment: unknown }).findComment = async () => {
      throw new Error("403");
    };
    const r = await post(forge, planNoteHandoff(NOTE, at(FIRST)));
    expect(r.noted).toBe(true);
    expect(r.warnings).toEqual([expect.stringMatching(/could not read the previous note on #7.*403/)]);
    expect(notes.size).toBe(1);
  });
});

describe("the subject is the change's, so it is checked (#4972)", () => {
  test("a subject that is not plain words is refused, and no note is posted", async () => {
    for (const subject of [{ id: "a --> <!-- x" }, { id: "@someone" }, { id: "ok", parts: { "pending/a": "x y" } }, { id: "ok", parts: { "a/b/c": "x" } }, { parts: {} }, "sha"]) {
      const { forge, notes, statuses } = keepingForge();
      const r = await post(forge, { ...planNoteHandoff(NOTE, at()), subject });
      expect(r.refused).toMatch(/the plan note's subject/);
      expect(notes.size).toBe(0);
      expect(statuses[0]!.state).toBe("failure");
    }
  });

  test("a subject line forged in the product's body is defused and never read back", async () => {
    const { forge, notes } = keepingForge();
    const forged = prNoteSubjectMarker({ id: "forged" })!;
    await post(forge, planBodyHandoff(`text\n${forged}\n`, { ...at(), head: HEAD }));
    const body = notes.get(prNoteMarker("default", "prod"))!;
    expect(body).toContain(`&lt;!--${forged.slice(4)}`);
    expect(subjectInNote(body)).toBeUndefined();
  });
});

describe("GitLab: pr-post --open compares in the target branch's pipeline (#4972)", () => {
  test("each merge request's note says what changed since its previous one, with no plan-job token", async () => {
    const { forge: base, notes } = keepingForge("gitlab");
    let artifact = JSON.stringify(planNoteHandoff(NOTE, at(FIRST)));
    let posted: string | undefined;
    const forge = {
      ...base,
      kind: "gitlab",
      host: "gitlab.com",
      async mergeRequestJobs() {
        return [{ pr: 7, head: HEAD, id: 101, status: "success", url: "https://gitlab.com/j/101" }];
      },
      async jobArtifact(_id: number, path: string) {
        return path.endsWith(PR_PLAN_NOTE_FILE) ? artifact : undefined;
      },
      async statusUrl() {
        return posted;
      },
    } as unknown as PrForge;
    // The note words come from the pipeline's CHANT_PLAN_NOTE_WORDS, as the generated GitLab note job sets it.
    const open = () => {
      process.env.CHANT_PLAN_NOTE_WORDS = JSON.stringify(YODEL_WORDS);
      return postOpenPlanReports({ forge, branch: "main", job: "prod-plan", artifactDir: ".chant/pr", env: "default", member: "prod" }).finally(() => {
        delete process.env.CHANT_PLAN_NOTE_WORDS;
      });
    };
    await open();
    artifact = JSON.stringify(planNoteHandoff(NOTE, at(SECOND)));
    posted = undefined;
    const { warnings } = await open();
    expect(warnings).toEqual([]);
    expect(notes.get(prNoteMarker("default", "prod"))).toContain("Since the previous version of this note (`sha256:aaa111`): pending migrations changed: new pending migrations: 003_orders;");
  });
});

describe("subjectChanges and sinceLastLine (#4972)", () => {
  test("chant's words name each group's parts added, gone and changed", () => {
    expect(subjectChanges({ env: "a", "x/1": "p", "x/2": "q" }, { env: "b", "x/1": "p2", "x/3": "r" })).toEqual(["env: a -> b changed", "x: 3 added", "x: 2 gone", "x: 1 changed"]);
  });

  test("an item's words read its values", () => {
    expect(subjectChanges({ "done/m1": "1" }, { "done/m1": "1,2" }, { done: { changed: "ran part way since: {items}", item: "{item} (statements {after} done now)" } })).toEqual(["ran part way since: m1 (statements 1,2 done now)"]);
  });

  test("the same id is no line, another is chant's line by default", () => {
    expect(sinceLastLine({ id: "a" }, { id: "a" })).toBeUndefined();
    expect(sinceLastLine({ id: "a", parts: { p: "1" } }, { id: "b", parts: { p: "2" } })).toBe("Since the previous version of this note (`a`): p: 1 -> 2 changed.");
  });
});
