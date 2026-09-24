/**
 * `chant workspace records --since <rev>` (#2673, #2650 C11), the contract
 * and the comparison. The fixture is a repository with commits for a review
 * session's open and close: between them the session closes with two
 * verdicts, ref-001 gains the two reviews that name it and is ratified,
 * a new decision supersedes ref-002, and ref-002's pin moves. Every document
 * validates against records-since.schema.json.
 */

import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, git, REPO, scratchDir, validSchema } from "./__fixtures__/contract-repo";
import { DECISIONS_KIND, reviewed, sessionText, SESSIONS_KIND, sessionsRepo } from "./__fixtures__/sessions";
import { queryRecordsSince, RECORDS_SINCE_ERROR_CODES, RECORDS_SINCE_OUTPUT_SCHEMA_ID, SINCE_CHANGE_KINDS, type RecordsSinceDocument } from "./records-since";
import schema from "./records-since.schema.json";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

async function since(q: { kind: string; since: string; at?: string; cwd: string }): Promise<RecordsSinceDocument> {
  const doc = await queryRecordsSince(q);
  expectValid(doc);
  return doc;
}

function ok(doc: RecordsSinceDocument): Extract<RecordsSinceDocument, { changes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

/** The session fixture: returns the repository and its commits. */
function sessionHistory(): { root: string; before: string; open: string; close: string } {
  const root = sessionsRepo();
  const before = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "design", "sessions", "S-0002-walk.md"), sessionText({ id: "S-0002", state: "open", agenda: ["ref-001", "ref-002"] }));
  const open = commitAll(root, "open S-0002");

  reviewed(root, ["alice", "bob"], "S-0002", "ratified");
  writeFileSync(
    join(root, "design", "sessions", "S-0002-walk.md"),
    sessionText({
      id: "S-0002",
      state: "closed",
      agenda: ["ref-001", "ref-002"],
      verdicts: [
        { record: "ref-001", principal: "alice", verdict: "agree" },
        { record: "ref-001", principal: "bob", verdict: "agree" },
      ],
    }),
  );
  const ref002 = join(root, "decisions", "ref-002-where-the-screen-design-lives.md");
  const text = readFileSync(ref002, "utf-8");
  writeFileSync(ref002, text.replace(/sha256: "[0-9a-f]{64}"/, `sha256: "${"a".repeat(64)}"`));
  writeFileSync(
    join(root, "decisions", "ref-003-a-successor.md"),
    text.replace(/^id: .*$/m, 'id: "ref-003"').replace(/^supersedes: \[\]$/m, 'supersedes:\n  - decision: "ref-002"'),
  );
  const close = commitAll(root, "close S-0002");
  return { root, before, open, close };
}

describe("records-since output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(RECORDS_SINCE_OUTPUT_SCHEMA_ID);
  });

  test("lists exactly the error codes and change kinds the code can return", () => {
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...RECORDS_SINCE_ERROR_CODES]);
    expect(schema.$defs.change.oneOf.map((r) => (schema.$defs as unknown as Record<string, { properties: { change: { const: string } } }>)[r.$ref.replace("#/$defs/", "")].properties.change.const)).toEqual([...SINCE_CHANGE_KINDS]);
    expect(Object.keys(schema.$defs.result.properties.summary.properties)).toEqual([...SINCE_CHANGE_KINDS]);
  });
});

describe("records --since (#2673)", () => {
  const h = sessionHistory();

  test("between a session's open and close commits, the decisions show every verdict, state change, supersession and pin", async () => {
    const doc = ok(await since({ kind: DECISIONS_KIND, since: h.open, at: h.close, cwd: h.root }));
    expect(doc.since).toBe(h.open);
    expect(doc.at).toBe(h.close);
    expect(doc.kind).toEqual({ name: "decision", schema: "urn:intentius:chant:decision:1", file: "decisions/decision.kind.mjs" });
    expect(doc.changes).toEqual([
      { change: "new", id: "ref-003", path: "decisions/ref-003-a-successor.md", state: "decided" },
      { change: "state", id: "ref-001", from: "decided", to: "ratified" },
      { change: "verdict", id: "ref-001", principal: "alice", verdict: "agree", index: 0, session: "S-0002" },
      { change: "verdict", id: "ref-001", principal: "bob", verdict: "agree", index: 1, session: "S-0002" },
      { change: "supersession", id: "ref-003", supersedes: "ref-002" },
      { change: "pin", id: "ref-002", path: "design/screens/home.json", from: expect.stringMatching(/^[0-9a-f]{64}$/), to: "a".repeat(64) },
    ]);
    expect(doc.summary).toEqual({ new: 1, removed: 0, state: 1, verdict: 2, supersession: 1, pin: 1 });
  });

  test("the session kind shows the session closing and the verdicts it produced", async () => {
    const doc = ok(await since({ kind: SESSIONS_KIND, since: h.open, at: h.close, cwd: h.root }));
    expect(doc.changes).toEqual([
      { change: "state", id: "S-0002", from: "open", to: "closed" },
      { change: "verdict", id: "S-0002", principal: "alice", verdict: "agree", index: 0, record: "ref-001" },
      { change: "verdict", id: "S-0002", principal: "bob", verdict: "agree", index: 1, record: "ref-001" },
    ]);
  });

  test("without --at it compares with the working tree, and a record deleted there is removed", async () => {
    rmSync(join(h.root, "decisions", "ref-003-a-successor.md"));
    try {
      const doc = ok(await since({ kind: DECISIONS_KIND, since: h.close, cwd: h.root }));
      expect(doc.at).toBeNull();
      expect(doc.changes).toEqual([{ change: "removed", id: "ref-003", path: "decisions/ref-003-a-successor.md", state: "decided" }]);
    } finally {
      git(h.root, "checkout", "--", "decisions");
    }
  });

  test("a directory that did not exist at --since held no records, so every record in it is new", async () => {
    const root = scratchDir("chant-since-empty-");
    git(root, "init", "-q");
    writeFileSync(join(root, "README.md"), "empty\n");
    const first = commitAll(root, "empty");
    const copy = sessionsRepo();
    for (const d of ["decisions", "design"]) cpSync(join(copy, d), join(root, d), { recursive: true });
    const doc = ok(await since({ kind: SESSIONS_KIND, since: first, cwd: root }));
    expect(doc.changes).toEqual([{ change: "new", id: "S-0001", path: "design/sessions/S-0001-first-walk-of-the-reference-decisions.md", state: "closed" }]);
  });

  test("nothing changed is an empty list", async () => {
    const doc = ok(await since({ kind: DECISIONS_KIND, since: h.close, at: "HEAD", cwd: h.root }));
    expect(doc.changes).toEqual([]);
  });

  test("a --since that names no commit is since-rev-unknown, and a bad --at is revision-unknown", async () => {
    const docs = [
      await since({ kind: DECISIONS_KIND, since: "no-such-rev", cwd: h.root }),
      await since({ kind: DECISIONS_KIND, since: "--all", cwd: h.root }),
      await since({ kind: DECISIONS_KIND, since: h.open, at: "no-such-rev", cwd: h.root }),
      await since({ kind: "missing.kind.mjs", since: h.open, cwd: h.root }),
    ];
    expect(docs.map((d) => ("error" in d ? d.error.code : "ok"))).toEqual(["since-rev-unknown", "since-rev-unknown", "revision-unknown", "kind-unreadable"]);
  });

  test("outside a git repository it is not-a-git-repository", async () => {
    const root = scratchDir("chant-since-nogit-");
    const doc = await since({ kind: DECISIONS_KIND, since: "HEAD", cwd: root });
    expect("error" in doc && doc.error.code).toBe("not-a-git-repository");
  });

  test(
    "through the CLI: --json prints the document, the text form a line per change, and a bad --since exits 1",
    () => {
      const run = (...args: string[]) =>
        spawnSync(process.execPath, ["--import", pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href, join(REPO, "packages/core/src/cli/main.ts"), "workspace", "records", ...args], {
          cwd: h.root,
          encoding: "utf-8",
          env: { ...process.env, NO_COLOR: "1" },
          timeout: 60_000,
        });
      const json = run("--kind", SESSIONS_KIND, "--since", h.open, "--at", h.close, "--json");
      expect(json.status, json.stderr).toBe(0);
      expectValid(JSON.parse(json.stdout));
      const text = run("--kind", SESSIONS_KIND, "--since", h.open, "--at", h.close);
      expect(text.stdout).toContain("S-0002  state open to closed");
      expect(text.stdout).toContain("S-0002  verdict agree by alice on ref-001");
      const bad = run("--kind", SESSIONS_KIND, "--since", "nope", "--json");
      expect(bad.status).toBe(1);
      expect(JSON.parse(bad.stdout).error.code).toBe("since-rev-unknown");
      const mixed = run("--kind", SESSIONS_KIND, "--since", h.open, "--current");
      expect(mixed.status).toBe(1);
    },
    120_000,
  );
});
