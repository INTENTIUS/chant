/**
 * Sessions from a UI (#2693): `records new` on a session kind records the
 * commit it opened at, `records close` closes and seals a session in one
 * write, `records review --session` refuses a session that does not exist or
 * is not open and appends the verdict to the session too, and
 * `records --since <session id>` compares the session's own revisions. The
 * fixture is a copy of the reference workspace's decisions and design
 * member with a declaration naming both kinds. The CLI run of close and
 * --since is in records-sessions-write.e2e.test.ts (#2817).
 */

import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, git, REPO, scratchDir } from "./__fixtures__/contract-repo";
import { declareSessions, DECISIONS_KIND, newSessionFields, sessionsRepo, SESSIONS_KIND } from "./__fixtures__/sessions";
import { sessionSeal } from "./record-sessions";
import { parseFrontMatter, recordTextDigest } from "./records";
import { queryRecords } from "./records-cli";
import { closeRecord } from "./records-close";
import closeSchema from "./records-close.schema.json";
import { queryRecordsSince, type RecordsSinceDocument } from "./records-since";
import sinceSchema from "./records-since.schema.json";
import { amendRecord, newRecord, reviewRecord } from "./records-write";
import newSchema from "./records-new.schema.json";
import reviewSchema from "./records-review.schema.json";

afterAll(cleanScratch);

const close = contract(closeSchema);
const since = contract(sinceSchema);
const review = contract(reviewSchema);
const created = contract(newSchema);

const code = (doc: object) => ("error" in doc ? (doc as { error: { code: string } }).error.code : "ok");
const HEX = /^[0-9a-f]{40}$/;

/** The reference fixture with a declaration, committed. */
function declared(): string {
  const root = sessionsRepo();
  declareSessions(root);
  commitAll(root, "declare");
  return root;
}

function front(root: string, path: string): Record<string, unknown> {
  const fm = parseFrontMatter(readFileSync(join(root, path), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
}

/** Open S-0002 through records new, and commit it. */
async function opened(root: string): Promise<{ path: string; head: string }> {
  const head = git(root, "rev-parse", "HEAD");
  const doc = await newRecord({ kind: SESSIONS_KIND, fields: newSessionFields(), cwd: root });
  created.expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  expect(doc.id).toBe("S-0002");
  commitAll(root, "open S-0002");
  return { path: doc.path, head };
}

async function sessions(root: string) {
  const doc = await queryRecords({ kind: SESSIONS_KIND, cwd: root });
  if ("error" in doc) throw new Error(doc.error.message);
  return doc;
}

describe("opening revisions (#2693)", () => {
  test("records new on a session kind writes opened_rev, the commit HEAD names", async () => {
    const root = declared();
    const { path, head } = await opened(root);
    expect(front(root, path).opened_rev).toBe(head);
    expect((await sessions(root)).records.find((r) => r.id === "S-0002")).toMatchObject({ state: "open", valid: true });
  });

  test("before the first commit it is null, and the next amend fills it", async () => {
    const root = scratchDir("chant-sessions-nocommit-");
    for (const d of ["decisions", "design"]) cpSync(join(REPO, "reference-workspace", d), join(root, d), { recursive: true });
    declareSessions(root);
    git(root, "init", "-q");
    const doc = await newRecord({ kind: SESSIONS_KIND, fields: newSessionFields(), cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(front(root, doc.path).opened_rev).toBeNull();
    const head = commitAll(root, "first");
    const amended = await amendRecord({ kind: SESSIONS_KIND, id: "S-0002", fields: "{}", cwd: root });
    expect(amended).toMatchObject({ changed: ["opened_rev"] });
    expect(front(root, doc.path).opened_rev).toBe(head);
  });

  test("a caller can't set the opening or closing revision", async () => {
    const root = declared();
    expect(code(await newRecord({ kind: SESSIONS_KIND, fields: newSessionFields({ opened_rev: "a".repeat(40) }), cwd: root }))).toBe("write-input-invalid");
    await opened(root);
    expect(code(await amendRecord({ kind: SESSIONS_KIND, id: "S-0002", fields: JSON.stringify({ opened_rev: "b".repeat(40) }), cwd: root }))).toBe("write-input-invalid");
    expect(code(await amendRecord({ kind: SESSIONS_KIND, id: "S-0002", fields: JSON.stringify({ closed_rev: "b".repeat(40) }), cwd: root }))).toBe("write-input-invalid");
  });
});

describe("records close (#2693)", () => {
  test("sets the state, the close time, the closing revision and the seal in one write, and the session reads back sealed", async () => {
    const root = declared();
    const { path } = await opened(root);
    const head = git(root, "rev-parse", "HEAD");
    const dry = await closeRecord({ kind: SESSIONS_KIND, id: "S-0002", dryRun: true, cwd: root, now: new Date("2026-09-25T10:30:00.123Z") });
    close.expectValid(dry);
    expect(dry).toMatchObject({ dryRun: true, closedRev: head, text: expect.stringContaining('state: "closed"') });
    expect(front(root, path).state).toBe("open");

    const doc = await closeRecord({ kind: SESSIONS_KIND, id: "S-0002", cwd: root, now: new Date("2026-09-25T10:30:00.123Z") });
    close.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.changed.sort()).toEqual(["closed", "closed_digest", "closed_rev", "state"]);
    const fm = front(root, path);
    expect(fm).toMatchObject({ state: "closed", closed: "2026-09-25T10:30:00Z", closed_rev: head, opened_rev: expect.stringMatching(HEX) });
    const text = readFileSync(join(root, path), "utf-8");
    expect(fm.closed_digest).toBe(sessionSeal(text, "closed_digest"));
    expect(doc.seal).toEqual({ field: "closed_digest", digest: fm.closed_digest });
    expect((await sessions(root)).records.find((r) => r.id === "S-0002")).toMatchObject({ state: "closed", valid: true, reasons: [] });
  });

  test("refuses a closed session, an unknown id and a verdict naming a record the subjects lack", async () => {
    const root = declared();
    const s1 = await closeRecord({ kind: SESSIONS_KIND, id: "S-0001", cwd: root });
    close.expectValid(s1);
    expect(code(s1)).toBe("record-closed");
    expect(code(await closeRecord({ kind: SESSIONS_KIND, id: "S-0404", cwd: root }))).toBe("record-not-found");
    expect(code(await closeRecord({ kind: DECISIONS_KIND, id: "ref-001", cwd: root }))).toBe("write-usage-invalid");
    await opened(root);
    const file = join(root, "design", "sessions", "S-0002-second-walk.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("verdicts: []", 'verdicts:\n  - record: "ref-999"\n    principal: "alice"\n    verdict: "agree"'));
    const before = readFileSync(file, "utf-8");
    const bad = await closeRecord({ kind: SESSIONS_KIND, id: "S-0002", cwd: root });
    close.expectValid(bad);
    expect(code(bad)).toBe("session-verdict-unknown-record");
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  test("amend's refusal on a closed session does not advise a supersedes field the session schema lacks", async () => {
    const root = declared();
    const doc = await amendRecord({ kind: SESSIONS_KIND, id: "S-0001", fields: JSON.stringify({ title: "x" }), cwd: root });
    expect(code(doc)).toBe("record-closed");
    const message = "error" in doc ? doc.error.message : "";
    expect(message).not.toContain("supersedes");
    expect(message).toContain("open a new session");
  });
});

describe("records review --session (#2693)", () => {
  test("refuses a session that does not exist and one that is closed, writing nothing", async () => {
    const root = declared();
    const decision = join(root, "decisions", "ref-001-how-the-app-is-deployed.md");
    const before = readFileSync(decision, "utf-8");
    const unknown = await reviewRecord({ kind: DECISIONS_KIND, id: "ref-001", verdict: "agree", by: "alice", session: "S-9999", cwd: root });
    review.expectValid(unknown);
    expect(code(unknown)).toBe("session-unknown");
    const closed = await reviewRecord({ kind: DECISIONS_KIND, id: "ref-001", verdict: "agree", by: "alice", session: "S-0001", cwd: root });
    review.expectValid(closed);
    expect(code(closed)).toBe("session-not-open");
    expect(readFileSync(decision, "utf-8")).toBe(before);
  });

  test("a verdict given in a session shows on both the decision and the session, with the same digest", async () => {
    const root = declared();
    const { path } = await opened(root);
    const decision = join(root, "decisions", "ref-001-how-the-app-is-deployed.md");
    const digest = recordTextDigest(readFileSync(decision, "utf-8"));

    const dry = await reviewRecord({ kind: DECISIONS_KIND, id: "ref-001", verdict: "agree", by: "alice", session: "S-0002", dryRun: true, cwd: root });
    review.expectValid(dry);
    expect(dry).toMatchObject({ session: { id: "S-0002", path, text: expect.stringContaining('principal: "alice"') } });
    expect(front(root, path).verdicts).toEqual([]);

    const doc = await reviewRecord({ kind: DECISIONS_KIND, id: "ref-001", verdict: "agree", by: "alice", session: "S-0002", on: "2026-09-25", cwd: root });
    review.expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    const verdict = { record: "ref-001", principal: "alice", verdict: "agree", digest };
    expect(doc.session).toEqual({ id: "S-0002", path, verdict });
    expect(front(root, "decisions/ref-001-how-the-app-is-deployed.md").reviews).toEqual([{ reviewer: "alice", verdict: "agree", on: "2026-09-25", digest, session: "S-0002" }]);
    expect(front(root, path).verdicts).toEqual([verdict]);

    const s2 = (await sessions(root)).records.find((r) => r.id === "S-0002")!;
    expect(s2).toMatchObject({ valid: true, citedBy: [{ id: "ref-001", index: 0, reviewer: "alice", verdict: "agree" }] });
    expect(s2.data?.verdicts).toEqual([verdict]);

    // The session closes over the verdict, and a later one is refused.
    close.expectValid(await closeRecord({ kind: SESSIONS_KIND, id: "S-0002", cwd: root }));
    expect(code(await reviewRecord({ kind: DECISIONS_KIND, id: "ref-002", verdict: "agree", by: "bob", session: "S-0002", cwd: root }))).toBe("session-not-open");
  });
});

describe("records --since <session id> (#2693)", () => {
  async function sinceDoc(q: { kind: string; since: string; at?: string; cwd: string }): Promise<Extract<RecordsSinceDocument, { changes: unknown }>> {
    const doc = await queryRecordsSince(q);
    since.expectValid(doc);
    if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
    return doc;
  }

  test("an open session compares its opening revision with the working tree, and a closed one its opening and closing revisions", async () => {
    const root = declared();
    const { head } = await opened(root);
    await reviewRecord({ kind: DECISIONS_KIND, id: "ref-001", verdict: "agree", by: "alice", session: "S-0002", on: "2026-09-25", cwd: root });

    const open = await sinceDoc({ kind: DECISIONS_KIND, since: "S-0002", cwd: root });
    expect(open.since).toBe(head);
    expect(open.at).toBeNull();
    expect(open.session).toMatchObject({ id: "S-0002", state: "open", sinceFrom: "opened-rev", atFrom: "working-tree", reasons: [{ code: "since-session-open" }] });
    expect(open.changes).toEqual([{ change: "verdict", id: "ref-001", principal: "alice", verdict: "agree", index: 0, session: "S-0002" }]);

    // Closed but not committed: closed_rev is HEAD before the close, and the close is only in the working tree.
    const closing = await closeRecord({ kind: SESSIONS_KIND, id: "S-0002", cwd: root });
    expect(closing).toMatchObject({ closedRev: git(root, "rev-parse", "HEAD") });
    expect((await sinceDoc({ kind: DECISIONS_KIND, since: "S-0002", cwd: root })).session).toMatchObject({ state: "closed", atFrom: "working-tree", reasons: [] });
    const closeCommit = commitAll(root, "the verdict and the close");
    await reviewRecord({ kind: DECISIONS_KIND, id: "ref-002", verdict: "agree", by: "bob", cwd: root });

    const done = await sinceDoc({ kind: DECISIONS_KIND, since: "S-0002", cwd: root });
    expect(done).toMatchObject({ since: head, at: closeCommit, session: { state: "closed", sinceFrom: "opened-rev", atFrom: "close-commit", reasons: [] } });
    // The later review of ref-002 came after the session closed, so it is not listed.
    expect(done.changes).toEqual([{ change: "verdict", id: "ref-001", principal: "alice", verdict: "agree", index: 0, session: "S-0002" }]);
    // The session was written after its opening commit, so it is new, with the verdict it produced.
    const own = await sinceDoc({ kind: SESSIONS_KIND, since: "S-0002", cwd: root });
    expect(own.changes).toEqual([
      { change: "new", id: "S-0002", path: "design/sessions/S-0002-second-walk.md", state: "closed" },
      { change: "verdict", id: "S-0002", principal: "alice", verdict: "agree", index: 0, record: "ref-001" },
    ]);
  });

  test("a session without revision fields falls back to its file's history, and an unknown id is since-session-unknown", async () => {
    const root = declared();
    const added = git(root, "log", "--diff-filter=A", "--format=%H", "--", "design/sessions/S-0001-first-walk-of-the-reference-decisions.md");
    const s1 = await sinceDoc({ kind: SESSIONS_KIND, since: "S-0001", cwd: root });
    expect(s1).toMatchObject({ since: added, at: added, session: { sinceFrom: "history", atFrom: "history" }, changes: [] });
    const unknown = await queryRecordsSince({ kind: DECISIONS_KIND, since: "S-9999", cwd: root });
    since.expectValid(unknown);
    expect(code(unknown)).toBe("since-session-unknown");
    // An id-shaped value that names a commit, such as a tag, is still read as the commit.
    git(root, "tag", "v-1");
    expect((await sinceDoc({ kind: DECISIONS_KIND, since: "v-1", cwd: root })).session).toBeUndefined();
  });
});
