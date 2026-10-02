/**
 * A record's stored source block (#2708): the decision schema documents it,
 * records new writes it and records returns it unchanged, a harvested record
 * opens proposed, and records warns source-transcript-drift when the pinned
 * transcript is here and hashes to something else.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFrontMatter, type RecordEntry } from "./records";
import { queryRecords } from "./records-cli";
import { newRecord, renderRecord, stableJson } from "./records-write";
import { sourceBlockProblems, transcriptDrift, transcriptFile } from "./source-block";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";

type Data = Record<string, unknown>;

const SAMPLE = (() => {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

/** A proposed decision like ws-003, with `over` laid on top. */
function proposal(over: Data = {}): Data {
  const d: Data = { ...structuredClone(SAMPLE), state: "proposed", choice: null, decided_by: null, decided_on: null, reviews: [], ...over };
  delete d.id;
  return d;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const TRANSCRIPT = '{"turn":1,"role":"user","text":"which way do we deploy?"}\n';

const HARNESS = {
  via: "mcp",
  client: { name: "claude-code", version: "2.1.0" },
  harness: "claude-code",
  model: "claude-opus-5-5",
  session: { id: "0f4c2a", record: "S-0002" },
  turns: { from: 12, to: 18 },
  transcript: { path: "transcripts/0f4c2a.jsonl", sha256: sha(TRANSCRIPT) },
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-source-block-")));
  mkdirSync(join(dir, "decisions"));
  mkdirSync(join(dir, "transcripts"));
  cpSync(join(DECISIONS, "decision.kind.mjs"), join(dir, "decisions", "decision.kind.mjs"));
  cpSync(join(DECISIONS, "decision.schema.json"), join(dir, "decisions", "decision.schema.json"));
  writeFileSync(join(dir, "decisions", "ws-001-one.md"), renderRecord({ ...proposal({ title: "One" }), id: "ws-001" }, "\n# One\n"));
  writeFileSync(join(dir, "transcripts", "0f4c2a.jsonl"), TRANSCRIPT);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const code = (doc: object) => ("error" in doc ? (doc as { error: { code: string } }).error.code : "ok");

async function read(): Promise<RecordEntry[]> {
  const doc = await queryRecords({ kind: KIND, cwd: dir });
  if (!("records" in doc)) throw new Error(JSON.stringify(doc));
  return doc.records;
}

async function write(source: unknown, over: Data = {}) {
  return newRecord({ kind: KIND, fields: JSON.stringify(proposal({ title: "Two", source, ...over })), cwd: dir });
}

describe("the decision schema documents the block", () => {
  test("each form takes the proposal fields, and a harness form needs via", async () => {
    for (const source of [
      HARNESS,
      { ...HARNESS, issue: "INTENTIUS/chant#2708" },
      { issue: "INTENTIUS/chant#2708", row: "Source", revision: null, ...HARNESS },
      { kind: "workspace", member: "app", ...HARNESS, session: "S-0001" },
      { via: "cli" },
    ]) {
      const doc = await write(source, { title: `T ${Math.random()}` });
      expect(code(doc), JSON.stringify(source)).toBe("ok");
    }
    const { via: _via, ...noVia } = HARNESS;
    for (const source of [
      noVia,
      { ...HARNESS, via: "email" },
      { ...HARNESS, transcript: { path: "a", uri: "file:///a", sha256: sha("a") } },
      { ...HARNESS, transcript: { path: "a", sha256: "ABC" } },
      { ...HARNESS, turns: { from: 3 } },
      { ...HARNESS, session: {} },
      { ...HARNESS, client: { version: "1" } },
      { ...HARNESS, row: "a row without an issue" },
    ]) {
      const doc = await write(source);
      expect(code(doc), JSON.stringify(source)).toBe("record-schema-invalid");
    }
  });

  test("chant checks the shapes the schema can't: turns that end before they start", async () => {
    const doc = await write({ ...HARNESS, turns: { from: 18, to: 12 } });
    expect(doc).toMatchObject({ error: { code: "record-schema-invalid", message: expect.stringContaining("/source/turns ends before it starts") } });
    expect(sourceBlockProblems({ ...HARNESS, turns: { from: 18, to: 12 } }, "source")).toEqual(["/source/turns ends before it starts"]);
    expect(sourceBlockProblems({ issue: "o/r#1", row: "anything the kind says" }, "source")).toEqual([]);
  });
});

describe("records new and records", () => {
  test("records new --from with a source block writes it, and records --json returns it unchanged", async () => {
    const doc = await write(HARNESS);
    expect(code(doc)).toBe("ok");
    const written = (await read()).find((r) => r.id === "ws-002");
    expect(stableJson(written?.data?.source)).toBe(stableJson(HARNESS));
    expect(written?.valid).toBe(true);
    expect(written?.warnings.map((w) => w.code)).not.toContain("source-transcript-drift");
  });

  test("a harvested record opens proposed; any other state is refused with a remedy", async () => {
    const decided = await write(
      { ...HARNESS, via: "harvest" },
      { state: "decided", choice: SAMPLE.choice, decided_by: "alice", decided_on: "2026-09-25" },
    );
    expect(decided).toMatchObject({ error: { code: "source-harvest-not-proposed", message: expect.stringContaining('write it with state "proposed"') } });
    const withdrawn = await write({ ...HARNESS, via: "harvest" }, { state: "withdrawn" });
    expect(code(withdrawn)).toBe("source-harvest-not-proposed");
    expect(code(await write({ ...HARNESS, via: "harvest" }))).toBe("ok");
    // Only a harvest opens proposed: a decision written at the CLI may still be decided in one go.
    const cli = await write({ via: "cli" }, { title: "Three", state: "decided", choice: SAMPLE.choice, decided_by: "alice", decided_on: "2026-09-25" });
    expect(code(cli)).toBe("ok");
  });
});

describe("source-transcript-drift", () => {
  test("warns when the transcript is here and its bytes changed, and not when they match or it is missing", async () => {
    expect(code(await write(HARNESS))).toBe("ok");
    const drift = async () => (await read()).find((r) => r.id === "ws-002")!.warnings.filter((w) => w.code === "source-transcript-drift");
    expect(await drift()).toEqual([]);
    writeFileSync(join(dir, "transcripts", "0f4c2a.jsonl"), TRANSCRIPT + '{"turn":2}\n');
    const warned = await drift();
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain("transcripts/0f4c2a.jsonl is pinned at sha256");
    rmSync(join(dir, "transcripts", "0f4c2a.jsonl"));
    expect(await drift()).toEqual([]);
  });

  test("reads an absolute path, ~/ and file: URIs, and never fetches another URI", () => {
    const file = join(dir, "transcripts", "0f4c2a.jsonl");
    const bad = "0".repeat(64);
    expect(transcriptDrift({ transcript: { path: file, sha256: sha(TRANSCRIPT) } }, "source", "/nowhere")).toBeUndefined();
    expect(transcriptDrift({ transcript: { path: file, sha256: bad } }, "source", "/nowhere")).toContain("is pinned at sha256 000000000000");
    expect(transcriptDrift({ transcript: { uri: pathToFileURL(file).href, sha256: bad } }, "source", "/nowhere")).toContain("file:");
    expect(transcriptDrift({ transcript: { uri: "https://example.com/t.jsonl", sha256: bad } }, "source", dir)).toBeUndefined();
    expect(transcriptFile({ path: "~/t.jsonl" }, dir)).toMatch(/\/t\.jsonl$/);
    expect(transcriptFile({ path: "t.jsonl" }, dir)).toBe(join(dir, "t.jsonl"));
  });

  test("a kind that does not opt in is not checked", async () => {
    const kindFile = join(dir, "decisions", "decision.kind.mjs");
    writeFileSync(kindFile, readFileSync(kindFile, "utf-8").replace(/\n\s*source: \{ field: "source" \},/, ""));
    expect(code(await write({ ...HARNESS, turns: { from: 18, to: 12 } }))).toBe("ok");
    writeFileSync(join(dir, "transcripts", "0f4c2a.jsonl"), "changed");
    expect((await read()).flatMap((r) => r.warnings.map((w) => w.code))).not.toContain("source-transcript-drift");
  });
});
