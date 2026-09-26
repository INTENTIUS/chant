/**
 * Record formats beyond Markdown front matter (ws-053, #2664): JSON records,
 * kinds without a lifecycle, a supersedes field of bare ids, schema files a
 * schema `$ref`s, and content-addressed ids.
 *
 * The fixtures are shaped like a development-model plugin's records (ported
 * from chud, jhgaylor/chud#78: units, evidence named by the hash of its
 * bytes, sessions, driver closures and Markdown contracts, with draft-07
 * schemas that `$ref` a shared `defs.schema.json`), trimmed to the fields
 * that matter here. Each one reads through a kind file alone: no reader code.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parseArgs } from "../cli/main";
import { queryRecords, type RecordsDocument } from "./records-cli";
import { newRecord, runRecordsWrite } from "./records-write";
import { loadRecordKind, parseJsonRecord, RECORD_FORMATS, recordTextDigest } from "./records";
import schema from "./records.schema.json";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const validateOutput = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "chant-record-formats-")));
  writeAcmeModel();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const git = (...args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  }).trim();

function commit(): string {
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "records");
  return git("rev-parse", "HEAD");
}

async function query(kind: string, at?: string): Promise<Extract<RecordsDocument, { records: unknown }>> {
  const doc = await queryRecords({ kind: `design/${kind}.kind.mjs`, cwd: root, ...(at ? { at } : {}) });
  expect(validateOutput(doc), JSON.stringify(validateOutput.errors, null, 2)).toBe(true);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

async function failure(kind: string): Promise<{ code: string; message: string }> {
  const doc = await queryRecords({ kind: `design/${kind}.kind.mjs`, cwd: root });
  expect(validateOutput(doc), JSON.stringify(validateOutput.errors, null, 2)).toBe(true);
  if (!("error" in doc)) throw new Error("the read worked");
  return doc.error;
}

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);
const warned = (r: { warnings: Array<{ code: string }> }) => r.warnings.map((x) => x.code);

// ── acme's model, as kind files ──────────────────────────────────────────────

const BASE = "https://schemas.example.test/acme-runtime/v0";
const ref = (name: string) => ({ $ref: `defs.schema.json#/definitions/${name}` });

const DEFS = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `${BASE}/defs.schema.json`,
  definitions: {
    datetime: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$" },
    sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    gitId: { type: "string", pattern: "^[0-9a-f]{40}$" },
    text: { type: "string", minLength: 1 },
    contractId: { type: "string", pattern: "^C-\\d{3,}$" },
    unitId: { type: "string", pattern: "^U-\\d{4,}$" },
    driverId: { type: "string", pattern: "^D-\\d{3,}$" },
    sessionId: { type: "string", pattern: "^S-\\d{4,}$" },
  },
};

const UNIT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `${BASE}/unit.schema.json`,
  type: "object",
  required: ["id", "role", "agent", "scope", "base_commit", "result", "evidence", "outcome", "opened_at"],
  additionalProperties: false,
  properties: {
    id: ref("unitId"),
    role: { enum: ["formalize", "build", "manual", "split"] },
    contract: { type: "object", required: ["id", "sha"], properties: { id: ref("contractId"), sha: ref("sha256") } },
    agent: { type: "object", required: ["name", "model", "runtime"], properties: { name: ref("text"), model: ref("text"), runtime: ref("text") } },
    scope: { type: "array", minItems: 1, items: ref("text") },
    base_commit: ref("gitId"),
    result: { type: "object", required: ["commit", "ref"], properties: { commit: { type: ["string", "null"] }, ref: { type: ["string", "null"] } } },
    // A bare hash, as acme writes today, or a pin chant checks.
    evidence: {
      type: "array",
      items: { anyOf: [ref("sha256"), { type: "object", required: ["path", "sha256"], properties: { path: ref("text"), sha256: ref("sha256") } }] },
    },
    outcome: { enum: ["open", "done", "not_done"] },
    corrects: ref("unitId"),
    opened_at: ref("datetime"),
    closed_at: ref("datetime"),
  },
};

const EVIDENCE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `${BASE}/evidence.schema.json`,
  type: "object",
  required: ["contract", "check_sha", "commit", "tree", "runner", "ok", "criteria", "output", "at"],
  properties: {
    contract: { type: "object", required: ["id", "sha"], properties: { id: ref("contractId"), sha: ref("sha256") } },
    check_sha: ref("sha256"),
    commit: { type: ["string", "null"] },
    tree: ref("gitId"),
    runner: { type: "object", required: ["kind"], properties: { kind: { enum: ["design-check", "release-check", "upgrade-check"] } } },
    ok: { type: "boolean" },
    criteria: { type: "object", additionalProperties: { enum: ["pass", "fail", "unchecked"] } },
    output: { type: "string", maxLength: 6000 },
    at: ref("datetime"),
  },
};

const SESSION_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `${BASE}/session.schema.json`,
  type: "object",
  required: ["id", "title", "status", "opened_by", "opened_at", "participants", "reviewed", "approvals", "decisions", "comments", "follow_ups"],
  properties: {
    id: ref("sessionId"),
    title: ref("text"),
    status: { enum: ["open", "closed"] },
    opened_by: ref("text"),
    opened_at: ref("datetime"),
    participants: { type: "array" },
    reviewed: { type: "array", minItems: 1 },
    approvals: { type: "array" },
    decisions: { type: "array" },
    comments: { type: "array" },
    follow_ups: { type: "array", items: ref("contractId") },
    closed_at: ref("datetime"),
    seal: ref("sha256"),
  },
};

const CLOSURE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `${BASE}/driver-closure.schema.json`,
  type: "object",
  required: ["driver", "closed_at", "by"],
  properties: { driver: ref("driverId"), closed_at: ref("datetime"), by: ref("text"), note: { type: "string" } },
};

const CONTRACT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: `${BASE}/contract.schema.json`,
  type: "object",
  required: ["id", "status"],
  properties: {
    id: ref("contractId"),
    status: { enum: ["draft", "approved", "retired"] },
    supersedes: { anyOf: [ref("contractId"), { type: "array", items: ref("contractId") }] },
  },
};

/** A kind file: data only, the way acme's model package would ship it. */
function kindFile(kind: Record<string, unknown>): string {
  return `export const recordKind = ${JSON.stringify(kind, null, 2)};\n`;
}

const schemaOf = (name: string) => ({ id: `${BASE}/${name}.schema.json`, path: `schemas/${name}.schema.json`, refs: [{ id: `${BASE}/defs.schema.json`, path: "schemas/defs.schema.json" }] });

const KINDS: Record<string, Record<string, unknown>> = {
  unit: {
    name: "unit",
    location: { dir: "units", match: "^U-\\d+\\.json$" },
    format: "json",
    schema: schemaOf("unit"),
    idField: "id",
    stateField: "outcome",
    states: ["open", "done", "not_done"],
    closedStates: ["done", "not_done"],
    pins: { field: "evidence" },
  },
  evidence: {
    name: "evidence",
    location: { dir: "evidence", match: "^[0-9a-f]{64}\\.json$" },
    format: "json",
    schema: schemaOf("evidence"),
    idFrom: "sha256",
  },
  session: {
    name: "session",
    location: { dir: "sessions", match: "^S-\\d+\\.json$" },
    format: "json",
    schema: schemaOf("session"),
    idField: "id",
    stateField: "status",
    states: ["open", "closed"],
    closedStates: ["closed"],
  },
  closure: {
    name: "driver-closure",
    location: { dir: "drivers/closures", match: "^D-\\d+\\.json$" },
    format: "json",
    schema: schemaOf("driver-closure"),
    idField: "driver",
  },
  contract: {
    name: "contract",
    location: { dir: "contracts", match: "^C-\\d+.*\\.md$" },
    format: "markdown-front-matter",
    schema: schemaOf("contract"),
    idField: "id",
    stateField: "status",
    states: ["draft", "approved", "retired"],
    closedStates: ["retired"],
    supersedes: { field: "supersedes" },
    approval: { draft: 0, approved: 1, retired: 1 },
  },
};

function writeAcmeModel(): void {
  write("design/schemas/defs.schema.json", json(DEFS));
  write("design/schemas/unit.schema.json", json(UNIT_SCHEMA));
  write("design/schemas/evidence.schema.json", json(EVIDENCE_SCHEMA));
  write("design/schemas/session.schema.json", json(SESSION_SCHEMA));
  write("design/schemas/driver-closure.schema.json", json(CLOSURE_SCHEMA));
  write("design/schemas/contract.schema.json", json(CONTRACT_SCHEMA));
  for (const [file, kind] of Object.entries(KINDS)) write(`design/${file}.kind.mjs`, kindFile(kind));
  for (const dir of ["units", "evidence", "sessions", "drivers/closures", "contracts"]) mkdirSync(join(root, "design", dir), { recursive: true });
}

function unit(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    role: "build",
    agent: { name: "builder", model: "m", runtime: "r" },
    scope: ["app/src"],
    base_commit: "a".repeat(40),
    result: { commit: null, ref: null },
    evidence: [],
    outcome: "open",
    opened_at: "2026-09-24T10:00:00.000Z",
    ...extra,
  };
}

const EVIDENCE = {
  contract: { id: "C-001", sha: "b".repeat(64) },
  check_sha: "c".repeat(64),
  commit: null,
  tree: "d".repeat(40),
  runner: { kind: "design-check" },
  ok: true,
  criteria: { renders: "pass" },
  output: "1 passed",
  at: "2026-09-24T10:00:00.000Z",
};

/** Write an evidence record named by the hash of its bytes, and return that hash. */
function writeEvidence(value: Record<string, unknown> = EVIDENCE): string {
  const text = json(value);
  const h = sha256(text);
  write(`design/evidence/${h}.json`, text);
  return h;
}

const SESSION = {
  id: "S-0001",
  title: "First walk",
  status: "closed",
  opened_by: "alex",
  opened_at: "2026-09-24T10:00:00.000Z",
  participants: [{ name: "alex", roles: ["maintainer"], joined_at: "2026-09-24T10:00:00.000Z" }],
  reviewed: [{ kind: "contract", id: "C-001" }],
  approvals: [],
  decisions: [],
  comments: [],
  follow_ups: ["C-002"],
  closed_at: "2026-09-24T11:00:00.000Z",
  seal: "e".repeat(64),
};

// ── 1. The json format ───────────────────────────────────────────────────────

test("the output schema lists exactly the formats a kind file may name", () => {
  expect(schema.$defs.result.properties.kind.properties.format.enum).toEqual([...RECORD_FORMATS]);
});

describe("format json", () => {
  test("acme's units, sessions and driver closures read through kind files alone", async () => {
    write("design/units/U-0001.json", json(unit("U-0001", { outcome: "done", closed_at: "2026-09-24T11:00:00.000Z" })));
    write("design/units/U-0002.json", json(unit("U-0002")));
    write("design/sessions/S-0001.json", json(SESSION));
    write("design/drivers/closures/D-001.json", json({ driver: "D-001", closed_at: "2026-09-24T11:00:00.000Z", by: "alex" }));

    const units = await query("unit");
    expect(units.kind).toMatchObject({ name: "unit", format: "json" });
    expect(units.records.map((r) => [r.id, r.state, r.valid, r.supersededBy])).toEqual([
      ["U-0001", "done", true, null],
      ["U-0002", "open", true, null],
    ]);
    expect(units.records[0].data).toMatchObject({ id: "U-0001", scope: ["app/src"] });
    // An empty pins list cites nothing, as the design note says it should for an open unit.
    expect(warned(units.records[1])).toEqual(["record-no-evidence"]);

    const sessions = await query("session");
    expect(sessions.records.map((r) => [r.id, r.state, r.valid])).toEqual([["S-0001", "closed", true]]);

    const closures = await query("closure");
    expect(closures.records.map((r) => [r.id, r.state, r.valid, r.supersededBy])).toEqual([["D-001", null, true, null]]);
  });

  test("a record that fails its schema is record-schema-invalid, with the shared defs applied", async () => {
    write("design/units/U-0001.json", json(unit("U-0001", { base_commit: "not-a-commit" })));
    const [r] = (await query("unit")).records;
    expect(codes(r)).toEqual(["record-schema-invalid"]);
    expect(r.reasons[0].message).toMatch(/\/base_commit must match pattern/);
    expect(r.id).toBe("U-0001");
  });

  test.each([
    ["a file that is not JSON", '{"id": "U-0001",\n', /not valid JSON/],
    ["an array at the top level", json([unit("U-0001")]), /one object at the top level/],
    ["a string at the top level", '"U-0001"\n', /one object at the top level/],
    ["a repeated member name", '{\n  "id": "U-0001",\n  "outcome": "open",\n  "outcome": "done"\n}\n', /"outcome" repeats/],
    ["a repeated name in a nested object, spelled with an escape", '{"id": "U-0001", "agent": {"name": "a", "\\u006eame": "b"}}\n', /\/agent: member name "name" repeats/],
    ["a number too large for a double", '{"id": "U-0001", "n": 1e400}\n', /not a JSON number/],
  ])("%s is record-unparseable", async (_label, text, why) => {
    write("design/units/U-0001.json", text);
    const [r] = (await query("unit")).records;
    expect(codes(r)).toEqual(["record-unparseable"]);
    expect(r.reasons[0].message).toMatch(why);
    expect(r.data).toBeNull();
    expect(r.id).toBeNull();
  });

  test("the same member name in two objects is not a repeat", () => {
    expect(parseJsonRecord('{"a": {"x": 1}, "b": {"x": 2}, "c": [{"x": 1}, {"x": 2}]}')).toMatchObject({ ok: true });
  });

  test("reads the same way under --at", async () => {
    write("design/units/U-0001.json", json(unit("U-0001")));
    write("design/units/U-0002.json", '[{"id": "U-0002"}]\n');
    write("design/units/U-0003.json", '{"id": "U-0003", "id": "U-0004"}\n');
    const head = commit();
    write("design/units/U-0001.json", "broken now\n");
    const doc = await query("unit", "main");
    expect(doc.at).toBe(head);
    expect(doc.records.map((r) => [r.id, codes(r)])).toEqual([
      ["U-0001", []],
      [null, ["record-unparseable"]],
      [null, ["record-unparseable"]],
    ]);
  });
});

describe("a JSON session kind (#2673)", () => {
  test("its seal is the digest without the seal member, by the JSON rule", async () => {
    write("design/session.kind.mjs", kindFile({ ...KINDS.session, session: { verdicts: "approvals", seal: "seal", subjects: { kind: "contract.kind.mjs" } } }));
    write("design/contracts/C-001-first.md", '---\nid: "C-001"\nstatus: "approved"\n---\n');
    const { seal: _drop, ...unsealed } = SESSION;
    const seal = sha256(json(unsealed));
    write("design/sessions/S-0001.json", json({ ...SESSION, approvals: [{ record: "C-001" }], seal }));
    write("design/sessions/S-0002.json", json({ ...SESSION, id: "S-0002", seal }));
    const doc = await query("session");
    expect(doc.records.map((r) => [r.id, codes(r)])).toEqual([
      ["S-0001", ["session-seal-mismatch"]],
      ["S-0002", ["session-seal-mismatch"]],
    ]);
    const good = { ...unsealed, id: "S-0003" };
    write("design/sessions/S-0003.json", json({ ...good, seal: sha256(json(good)) }));
    const [, , third] = (await query("session")).records;
    expect([third.id, codes(third)]).toEqual(["S-0003", []]);
  });
});

describe("the write commands", () => {
  test("refuse a JSON kind and a content-addressed one, which they cannot write", async () => {
    for (const kind of ["unit", "evidence"]) {
      const doc = await newRecord({ kind: `design/${kind}.kind.mjs`, fields: "{}", cwd: root, dryRun: true });
      expect("error" in doc && doc.error.code).toBe("write-usage-invalid");
      expect("error" in doc && doc.error.message).toMatch(/write only Markdown front matter records with an idField/);
    }
  });
});

describe("the write commands through a declared kind (#2680)", () => {
  afterEach(() => vi.restoreAllMocks());

  test.each(["unit", "evidence"])("refuse the declared %s kind with write-usage-invalid", async (kind) => {
    write(
      "chant.workspace.json",
      json({ name: "acme", schema: 1, members: [{ name: "design", dir: "design", kind: "other", because: "acme's records" }], records: [{ kind: `design/${kind}.kind.mjs` }] }),
    );
    write("design/units/U-0001.json", json(unit("U-0001")));
    write("fields.json", "{}\n");
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const runs: string[][] = [
      ["new", "--from", join(root, "fields.json"), "--dry-run"],
      ["amend", "U-0001", "--set", join(root, "fields.json"), "--dry-run"],
      ["review", "U-0001", "--verdict", "agree", "--by", "bo", "--dry-run"],
    ];
    for (const argv of runs) {
      out.length = 0;
      const status = await runRecordsWrite({ args: parseArgs(["workspace", "records", ...argv]), plugins: [] } as never);
      const doc = JSON.parse(out.join("\n")) as { error?: { code: string; message: string } };
      expect(status, argv[0]).toBe(1);
      expect(doc.error?.code, argv[0]).toBe("write-usage-invalid");
      expect(doc.error?.message, argv[0]).toMatch(/write only Markdown front matter records with an idField/);
    }
  });
});

describe("the decision kind", () => {
  test("still reads as markdown front matter, and says so", async () => {
    const doc = await queryRecords({ kind: "docs/design/decisions/decision.kind.mjs", cwd: REPO });
    expect(validateOutput(doc)).toBe(true);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.kind.format).toBe("markdown-front-matter");
    expect(doc.records.find((r) => r.id === "ws-053")).toMatchObject({ state: "decided", valid: true, supersededBy: null });
  });
});

// ── The digest of a JSON record ──────────────────────────────────────────────

describe("the digest of a JSON record", () => {
  const withReviews = (reviews: unknown[], at: "middle" | "last" | "first") => {
    const body: Record<string, unknown> = { id: "U-0001", outcome: "open" };
    const entries = Object.entries(body);
    const member: [string, unknown] = ["reviews", reviews];
    const ordered = at === "first" ? [member, ...entries] : at === "middle" ? [entries[0], member, entries[1]] : [...entries, member];
    return json(Object.fromEntries(ordered));
  };

  test.each(["first", "middle", "last"] as const)("with the reviews member %s, is the hash of the text with that member and one comma deleted", (at) => {
    const without = json({ id: "U-0001", outcome: "open" });
    const one = withReviews([{ reviewer: "bo", verdict: "agree" }], at);
    const two = withReviews([{ reviewer: "bo", verdict: "agree" }, { reviewer: "cy", verdict: "dissent", note: "no" }], at);
    // What a hand-editor gets by deleting the member's lines and the comma, then running sha256sum.
    expect(recordTextDigest(one, "reviews", "json")).toBe(sha256(without));
    expect(recordTextDigest(two, "reviews", "json")).toBe(sha256(without));
    expect(recordTextDigest(withReviews([], at), "reviews", "json")).toBe(sha256(without));
    expect(recordTextDigest(without, "reviews", "json")).toBe(sha256(without));
    // Any other edit moves it.
    expect(recordTextDigest(one.replace('"open"', '"done"'), "reviews", "json")).not.toBe(sha256(without));
  });

  test("CRLF reads as LF, a lone member leaves the braces, and a nested reviews member stays", () => {
    expect(recordTextDigest('{\r\n  "id": "U-0001",\r\n  "reviews": []\r\n}\r\n', "reviews", "json")).toBe(sha256('{\n  "id": "U-0001"\n}\n'));
    expect(recordTextDigest('{\n  "reviews": []\n}\n', "reviews", "json")).toBe(sha256("{\n}\n"));
    const nested = '{"id": "U-0001", "x": {"reviews": []}}';
    expect(recordTextDigest(nested, "reviews", "json")).toBe(sha256(nested));
  });

  test("text that is not a JSON record is hashed whole, and markdown keeps #2672's rule", () => {
    expect(recordTextDigest('[{"reviews": []}]', "reviews", "json")).toBe(sha256('[{"reviews": []}]'));
    const md = '---\nid: "a-001"\nreviews:\n  - reviewer: "bo"\n---\n# A\n';
    expect(recordTextDigest(md, "reviews")).toBe(sha256('---\nid: "a-001"\n---\n# A\n'));
    expect(recordTextDigest(md, "reviews", "json")).toBe(sha256(md));
  });

  test("records reports it, and a verdict on it counts toward the quorum", async () => {
    write(
      "design/review.kind.mjs",
      kindFile({ ...KINDS.unit, name: "reviewed-unit", schema: { id: "urn:test:open", path: "schemas/open.schema.json" }, pins: undefined, reviews: { field: "reviews", decider: "by" } }),
    );
    write("design/schemas/open.schema.json", json({ $id: "urn:test:open", type: "object" }));
    const bare = json({ id: "U-0001", outcome: "done", by: "alex" });
    const digest = sha256(bare);
    write("design/units/U-0001.json", json({ id: "U-0001", outcome: "done", by: "alex", reviews: [{ reviewer: "bo", verdict: "agree", digest }, { reviewer: "cy", verdict: "agree", digest }] }));
    const [r] = (await query("review")).records;
    expect(r.digest).toBe(digest);
    expect(r.quorum).toMatchObject({ agreed: 2, met: true });
  });
});

// ── 2. Optional lifecycle, and supersedes of bare ids ────────────────────────

describe("kinds without a lifecycle", () => {
  test("a stateless kind's records have state null and are valid", async () => {
    write("design/drivers/closures/D-001.json", json({ driver: "D-001", closed_at: "2026-09-24T11:00:00.000Z", by: "alex" }));
    write("design/drivers/closures/D-002.json", json({ driver: "D-002", closed_at: "2026-09-24T12:00:00.000Z", by: "bo", note: "done" }));
    const doc = await query("closure");
    expect(doc.records.map((r) => [r.id, r.state, r.valid, r.supersededBy])).toEqual([
      ["D-001", null, true, null],
      ["D-002", null, true, null],
    ]);
    expect(doc.summary).toEqual({ total: 2, valid: 2, invalid: 0, superseded: 0 });
  });

  const contract = (id: string, status: string, supersedes?: string | string[]) =>
    `---\nid: "${id}"\nstatus: "${status}"\n${supersedes === undefined ? "" : `supersedes: ${JSON.stringify(supersedes)}\n`}---\n\n# ${id}\n`;

  test("supersedes as one id, as acme's contracts write it, derives supersededBy under approval ranks", async () => {
    write("design/contracts/C-001-first.md", contract("C-001", "approved"));
    write("design/contracts/C-002-second.md", contract("C-002", "approved", "C-001"));
    write("design/contracts/C-003-draft.md", contract("C-003", "draft", "C-002"));
    write("design/contracts/C-004-typo.md", contract("C-004", "approved", "C-999"));
    const doc = await query("contract");
    const by = Object.fromEntries(doc.records.map((r) => [r.id, r]));
    expect(by["C-001"].supersededBy).toBe("C-002");
    expect(by["C-002"].supersededBy).toBeNull();
    expect(warned(by["C-003"])).toEqual(["record-supersedes-pending"]);
    expect(codes(by["C-004"])).toEqual(["record-supersedes-unknown"]);
    expect(doc.summary.superseded).toBe(1);
  });

  test("supersedes as a list of ids works the same way", async () => {
    write("design/contracts/C-001-a.md", contract("C-001", "approved"));
    write("design/contracts/C-002-b.md", contract("C-002", "approved"));
    write("design/contracts/C-003-c.md", contract("C-003", "retired", ["C-001", "C-002"]));
    write("design/contracts/C-004-d.md", contract("C-004", "draft", ["C-003"]));
    const doc = await query("contract");
    expect(doc.records.map((r) => [r.id, r.supersededBy])).toEqual([
      ["C-001", "C-003"],
      ["C-002", "C-003"],
      ["C-003", null],
      ["C-004", null],
    ]);
    expect(warned(doc.records[3])).toEqual(["record-supersedes-pending"]);
  });

  test.each([
    ["supersedes without states", { ...KINDS.closure, supersedes: { field: "supersedes" } }, /supersedes: a kind without states cannot have supersedes/],
    ["approval without states", { ...KINDS.closure, approval: { a: 1 } }, /approval: a kind without states cannot have approval ranks/],
    ["states without a stateField", { ...KINDS.closure, states: ["open"], closedStates: [] }, /states: stateField, states and closedStates are given together/],
    ["both idField and idFrom", { ...KINDS.closure, idFrom: "sha256" }, /idField: a kind names its id with exactly one of idField and idFrom/],
    ["neither idField nor idFrom", { ...KINDS.closure, idField: undefined }, /idField: a kind names its id with exactly one of idField and idFrom/],
    ["an unknown format", { ...KINDS.closure, format: "yaml" }, /format/],
    ["a session block without states", { ...KINDS.closure, session: { verdicts: "approvals", seal: "seal", subjects: { kind: "contract.kind.mjs" } } }, /session: a session kind must have states/],
  ])("a kind with %s is kind-invalid, naming the field", async (_label, kind, why) => {
    write("design/closure.kind.mjs", kindFile(kind));
    const error = await failure("closure");
    expect(error.code).toBe("kind-invalid");
    expect(error.message).toMatch(why);
  });
});

// ── 3. Schema files a schema references ──────────────────────────────────────

describe("schema.refs", () => {
  test("each named file is loaded, by its $id", async () => {
    const loaded = await loadRecordKind(join(root, "design", "unit.kind.mjs"));
    expect(loaded.refs.map((s) => s.$id)).toEqual([`${BASE}/defs.schema.json`]);
  });

  test("a missing file is schema-unreadable, naming it", async () => {
    rmSync(join(root, "design", "schemas", "defs.schema.json"));
    const error = await failure("unit");
    expect(error.code).toBe("schema-unreadable");
    expect(error.message).toMatch(/schemas\/defs\.schema\.json/);
  });

  test("a file whose $id differs is schema-id-mismatch, naming it", async () => {
    write("design/schemas/defs.schema.json", json({ ...DEFS, $id: `${BASE}/other.schema.json` }));
    const error = await failure("unit");
    expect(error.code).toBe("schema-id-mismatch");
    expect(error.message).toMatch(/schemas\/defs\.schema\.json has \$id/);
  });

  test("without refs, a schema whose $ref resolves nowhere is still schema-invalid", async () => {
    write("design/unit.kind.mjs", kindFile({ ...KINDS.unit, schema: { id: UNIT_SCHEMA.$id, path: "schemas/unit.schema.json" } }));
    write("design/units/U-0001.json", json(unit("U-0001")));
    const error = await failure("unit");
    expect(error.code).toBe("schema-invalid");
  });
});

// ── 4. Content-addressed ids ─────────────────────────────────────────────────

describe("idFrom sha256", () => {
  test("acme's evidence reads with the hash of its bytes as its id, in the tree and under --at", async () => {
    const h = writeEvidence();
    const bytes = readFileSync(join(root, "design", "evidence", `${h}.json`));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(h);
    const tree = await query("evidence");
    expect(tree.records.map((r) => [r.id, r.state, r.valid, r.assets, r.warnings])).toEqual([[h, null, true, [], []]]);
    commit();
    const at = await query("evidence", "HEAD");
    expect(at.records.map((r) => [r.id, r.valid, r.assets])).toEqual([[h, true, []]]);
  });

  test("a file that changes keeps its name: valid, a new id, and itself pinned drifted; a unit pinning it drifts too", async () => {
    const h = writeEvidence();
    const path = `design/evidence/${h}.json`;
    write("design/units/U-0001.json", json(unit("U-0001", { outcome: "done", evidence: [h, { path, sha256: h }] })));
    const before = await query("unit");
    expect(before.records[0].assets).toEqual([{ path, sha256: h, actual: h, state: "pinned" }]);

    const edited = json({ ...EVIDENCE, ok: false });
    write(path, edited);
    const actual = sha256(edited);
    const [r] = (await query("evidence")).records;
    expect(r.valid).toBe(true);
    expect(r.id).toBe(actual);
    expect(r.assets).toEqual([{ path, sha256: h, actual, state: "drifted" }]);
    expect(warned(r)).toEqual(["asset-drift"]);

    const [u] = (await query("unit")).records;
    expect(u.assets).toEqual([{ path, sha256: h, actual, state: "drifted" }]);
    expect(warned(u)).toEqual(["asset-drift"]);
  });

  test("the drift shows under --at as well", async () => {
    const h = writeEvidence();
    write(`design/evidence/${h}.json`, json({ ...EVIDENCE, output: "0 passed" }));
    commit();
    const [r] = (await query("evidence", "HEAD")).records;
    expect(r.assets[0]).toMatchObject({ sha256: h, state: "drifted" });
  });

  test("a name that claims no hash warns asset-drift and lists nothing it cannot pin", async () => {
    write("design/evidence.kind.mjs", kindFile({ ...KINDS.evidence, location: { dir: "evidence", match: "\\.json$" } }));
    write("design/evidence/latest.json", json(EVIDENCE));
    const [r] = (await query("evidence")).records;
    expect(r.valid).toBe(true);
    expect(r.assets).toEqual([]);
    expect(warned(r)).toEqual(["asset-drift"]);
    expect(r.warnings[0].message).toMatch(/claims no sha256/);
  });
});
