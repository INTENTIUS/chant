/**
 * `chant workspace records new|amend|review` (#2670): each command validates
 * before it writes, writes exactly one file or none, and refuses with a closed
 * code. Run in a directory outside git holding a copy of the decision kind.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseFrontMatter, recordTextDigest } from "./records";
import { allocateId, amendRecord, newRecord, renderRecord, reviewRecord, toYaml } from "./records-write";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";

type Data = Record<string, unknown>;

const SAMPLE = (() => {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();

/** A decided decision like ws-003, with `over` laid on top. */
function decision(over: Data = {}): Data {
  return { ...structuredClone(SAMPLE), ...over };
}

/** A proposed decision: no choice, nobody decided. */
function proposal(over: Data = {}): Data {
  return decision({ state: "proposed", choice: null, decided_by: null, decided_on: null, ...over });
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-records-write-")));
  mkdirSync(join(dir, "decisions"));
  cpSync(join(DECISIONS, "decision.kind.mjs"), join(dir, "decisions", "decision.kind.mjs"));
  cpSync(join(DECISIONS, "decision.schema.json"), join(dir, "decisions", "decision.schema.json"));
  put("ws-001-one.md", decision({ id: "ws-001", title: "One" }));
  put("ws-002-two.md", proposal({ id: "ws-002", title: "Two" }));
  put("ws-003-three.md", decision({ id: "ws-003", title: "Three", state: "ratified" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(name: string, data: Data): void {
  writeFileSync(join(dir, "decisions", name), renderRecord(data, `\n# ${String(data.title)}\n`));
}

function text(name: string): string {
  return readFileSync(join(dir, "decisions", name), "utf-8");
}

function data(name: string): Data {
  const fm = parseFrontMatter(text(name));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
}

/** Every file under the directory, with the hash of its bytes. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(join(dir, "decisions"))) out[f] = createHash("sha256").update(readFileSync(join(dir, "decisions", f))).digest("hex");
  return out;
}

/** The files that differ between two snapshots. */
function touched(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort();
}

const fields = (d: Data) => JSON.stringify(d);
const code = (doc: object) => ("error" in doc ? (doc as { error: { code: string } }).error.code : "ok");

describe("rendering", () => {
  test("every decision in this repository and the reference workspace renders back to its own bytes", () => {
    const dirs = [DECISIONS, join(REPO, "reference-workspace", "decisions")];
    let n = 0;
    for (const d of dirs) {
      for (const f of readdirSync(d).filter((x) => /^[a-z]+-\d{3}-.+\.md$/.test(x))) {
        const t = readFileSync(join(d, f), "utf-8");
        const fm = parseFrontMatter(t);
        if (!fm.ok) throw new Error(`${f}: ${fm.message}`);
        expect(renderRecord(fm.value, t.replace(/^---\n[\s\S]*?\n---\n/, "")), f).toBe(t);
        n++;
      }
    }
    expect(n).toBeGreaterThan(50);
  });

  test("reads back to the same value, whatever the keys, nesting and empties", () => {
    const value = {
      plain: "a \"quoted\" line\nand another",
      "needs quoting": 1,
      true: false,
      n: -2.5,
      none: null,
      list: [[], {}, ["x", ["y"]], { a: [], b: { c: "d" } }],
      obj: {},
      nested: { deeper: [{ k: "v", l: [1, 2] }] },
    };
    const fm = parseFrontMatter(`---\n${toYaml(value)}\n---\n`);
    expect(fm).toEqual({ ok: true, value });
  });
});

describe("the digest a review names (#2672)", () => {
  test("records review changes only the reviews block, so recordTextDigest of the file is unchanged", async () => {
    // A hand-laid file: comments, blank lines and a flow list the writer would never produce.
    const hand = text("ws-001-one.md").replace('title: "One"', "title:   \"One\"   # set by hand").replace("reviews: []", "reviews: [] # none yet\n");
    writeFileSync(join(dir, "decisions", "ws-001-one.md"), hand);
    const judged = recordTextDigest(hand);
    for (const [by, verdict, note] of [["alice", "agree", undefined], ["bob", "dissent", "Not yet."], ["carol", "abstain", undefined]] as const) {
      const doc = await reviewRecord({ kind: KIND, id: "ws-001", verdict, by, note, cwd: dir });
      expect(doc).toMatchObject({ review: { digest: judged } });
      expect(recordTextDigest(text("ws-001-one.md")), by).toBe(judged);
    }
    const after = text("ws-001-one.md");
    expect(after).toContain('title:   "One"   # set by hand');
    const cut = (t: string) => t.replace(/\nreviews:[^\n]*(?:\n(?:[ \t#-][^\n]*|))*?(?=\n[a-z])/, "");
    expect(cut(after)).toBe(cut(hand));
  });

  test("an amendment outside the reviews moves the digest, and one inside them does not", async () => {
    await reviewRecord({ kind: KIND, id: "ws-001", verdict: "dissent", by: "bob", note: "Why?", cwd: dir });
    const judged = recordTextDigest(text("ws-001-one.md"));
    const reviews = (data("ws-001-one.md").reviews as Data[]).map((r) => ({ ...r, addressed_by: "INTENTIUS/chant#2670" }));
    expect(await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ reviews }), cwd: dir })).toMatchObject({ changed: ["reviews"] });
    expect(recordTextDigest(text("ws-001-one.md"))).toBe(judged);
    expect(await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ evidence: [] }), cwd: dir })).toMatchObject({ changed: ["evidence"] });
    expect(recordTextDigest(text("ws-001-one.md"))).not.toBe(judged);
  });

  test("an amendment rewrites only the fields it changes", async () => {
    const hand = text("ws-002-two.md").replace('title: "Two"', "title: \"Two\" # kept");
    writeFileSync(join(dir, "decisions", "ws-002-two.md"), hand);
    await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ area: "D9" }), cwd: dir });
    expect(text("ws-002-two.md")).toBe(hand.replace('area: "D4"', 'area: "D9"'));
  });
});

describe("records new", () => {
  const fresh = () => {
    const { id: _id, ...rest } = decision({ title: "Four things", reviews: [] });
    return rest;
  };

  test("allocates the next id, writes one file named for it, and prints its path and id", async () => {
    const before = snapshot();
    const doc = await newRecord({ kind: KIND, fields: fields(fresh()), cwd: dir });
    expect(doc).toMatchObject({ path: "decisions/ws-004-four-things.md", id: "ws-004", dryRun: false, warnings: [] });
    expect(touched(before, snapshot())).toEqual(["ws-004-four-things.md"]);
    expect(data("ws-004-four-things.md")).toEqual({ ...decision({ title: "Four things" }), id: "ws-004" });
    expect(Object.keys(data("ws-004-four-things.md"))).toEqual(Object.keys(SAMPLE));
    expect(text("ws-004-four-things.md")).toMatch(/\n---\n\n# Four things\n$/);
  });

  test("--dry-run prints the text and writes nothing", async () => {
    const before = snapshot();
    const doc = await newRecord({ kind: KIND, fields: fields(fresh()), dryRun: true, cwd: dir });
    expect(doc).toMatchObject({ id: "ws-004", dryRun: true });
    expect("text" in doc && doc.text).toContain('id: "ws-004"');
    expect(touched(before, snapshot())).toEqual([]);
  });

  test("keeps a caller's id, and refuses one already used", async () => {
    expect(await newRecord({ kind: KIND, fields: fields({ ...fresh(), id: "ws-010" }), cwd: dir })).toMatchObject({ id: "ws-010" });
    const doc = await newRecord({ kind: KIND, fields: fields({ ...fresh(), id: "ws-002" }), cwd: dir });
    expect(code(doc)).toBe("record-id-taken");
    // An unreadable file still holds its id through its name.
    writeFileSync(join(dir, "decisions", "ws-020-broken.md"), "no front matter\n");
    expect(code(await newRecord({ kind: KIND, fields: fields({ ...fresh(), id: "ws-020" }), cwd: dir }))).toBe("record-id-taken");
    expect(await newRecord({ kind: KIND, fields: fields(fresh()), dryRun: true, cwd: dir })).toMatchObject({ id: "ws-021" });
  });

  test("allocates under --prefix, and refuses to guess between prefixes", async () => {
    put("ref-001-other.md", decision({ id: "ref-001", title: "Other" }));
    expect(code(await newRecord({ kind: KIND, fields: fields(fresh()), cwd: dir }))).toBe("record-id-unallocatable");
    expect(await newRecord({ kind: KIND, fields: fields(fresh()), prefix: "ref", dryRun: true, cwd: dir })).toMatchObject({ id: "ref-002" });
    expect(await newRecord({ kind: KIND, fields: fields(fresh()), prefix: "adr", dryRun: true, cwd: dir })).toMatchObject({ id: "adr-001" });
    expect(code(await newRecord({ kind: KIND, fields: fields(fresh()), prefix: "Bad!", cwd: dir }))).toBe("write-usage-invalid");
  });

  test("keeps the width of the ids it follows", () => {
    const entry = (id: string) => ({ id, path: `d/${id}-x.md`, state: null, valid: true, reasons: [], supersededBy: null, data: {}, digest: "", assets: [], warnings: [] });
    expect(allocateId([entry("s-0009"), entry("s-0010")], undefined, "k")).toBe("s-0011");
    expect(allocateId([entry("s-999")], undefined, "k")).toBe("s-1000");
    // Case and padding come from the records (#2683).
    expect(allocateId([entry("W-001"), entry("W-002")], undefined, "work")).toBe("W-003");
    expect(allocateId([entry("W-0009")], undefined, "work")).toBe("W-0010");
    expect(allocateId([], "W", "work")).toBe("W-001");
  });

  test("refuses fields the schema refuses, and writes nothing", async () => {
    const before = snapshot();
    const doc = await newRecord({ kind: KIND, fields: fields({ ...fresh(), constrains: [] }), cwd: dir });
    expect(code(doc)).toBe("record-schema-invalid");
    expect("error" in doc && doc.error.message).toMatch(/constrains/);
    expect(touched(before, snapshot())).toEqual([]);
  });

  test("refuses input that is not a JSON object", async () => {
    for (const input of ["not json", "[1]", "null"]) expect(code(await newRecord({ kind: KIND, fields: input, cwd: dir })), input).toBe("write-input-invalid");
  });

  test("refuses a supersedes link to no record, and one that would make another record invalid", async () => {
    expect(code(await newRecord({ kind: KIND, fields: fields({ ...fresh(), supersedes: [{ decision: "ws-099" }] }), cwd: dir }))).toBe("record-supersedes-unknown");
    // ws-005 ratified supersedes ws-001; a second ratified record claiming ws-001, sorting first, would make ws-005 conflict.
    put("ws-005-five.md", decision({ id: "ws-005", title: "Five", state: "ratified", supersedes: [{ decision: "ws-001" }] }));
    const doc = await newRecord({ kind: KIND, fields: fields({ ...fresh(), id: "ws-004", state: "ratified", supersedes: [{ decision: "ws-001" }] }), cwd: dir });
    expect(code(doc)).toBe("record-supersedes-conflict");
    expect("error" in doc && doc.error.message).toContain("ws-005-five.md");
  });

  test("reports the written record's warnings without refusing it", async () => {
    const doc = await newRecord({ kind: KIND, fields: fields({ ...fresh(), evidence: [] }), dryRun: true, cwd: dir });
    expect("warnings" in doc && doc.warnings.map((w) => w.code)).toEqual(["record-no-evidence"]);
  });

  test("a kind that can't be read is its read error", async () => {
    expect(code(await newRecord({ kind: "missing.kind.mjs", fields: fields(fresh()), cwd: dir }))).toBe("kind-unreadable");
  });
});

describe("records amend", () => {
  test("a proposed record changes freely, and prints what changed", async () => {
    const before = snapshot();
    const doc = await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ question: "A new question?", area: "D9" }), cwd: dir });
    expect(doc).toMatchObject({ path: "decisions/ws-002-two.md", id: "ws-002", changed: ["area", "question"] });
    expect(touched(before, snapshot())).toEqual(["ws-002-two.md"]);
    expect(data("ws-002-two.md")).toMatchObject({ question: "A new question?", area: "D9" });
    expect(text("ws-002-two.md")).toMatch(/\n# Two\n$/);
  });

  test("a proposed record can be decided, when the decision is complete", async () => {
    const doc = await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ state: "decided", choice: SAMPLE.choice, decided_by: "lex00", decided_on: "2026-09-24" }), cwd: dir });
    expect(doc).toMatchObject({ changed: ["state", "choice", "decided_by", "decided_on"] });
    expect(code(await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ decided_by: null }), cwd: dir }))).toBe("amend-supersede-instead");
  });

  test("a decided record refuses a change to its substance and says to supersede it", async () => {
    const before = snapshot();
    const doc = await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ choice: { option: "b", reason: "changed my mind" } }), cwd: dir });
    expect(code(doc)).toBe("amend-supersede-instead");
    expect("error" in doc && doc.error.message).toMatch(/supersedes: \[\{"decision": "ws-001"\}\]/);
    expect(touched(before, snapshot())).toEqual([]);
  });

  test("a decided record may be ratified, re-pin its evidence and take reviews, but not move down", async () => {
    const evidence = [{ title: "A spec", url: "https://example.com/spec" }];
    expect(await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ evidence }), cwd: dir })).toMatchObject({ changed: ["evidence"] });
    expect(await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ state: "ratified" }), cwd: dir })).toMatchObject({ changed: ["state"] });
    put("ws-006-six.md", decision({ id: "ws-006", title: "Six" }));
    expect(code(await amendRecord({ kind: KIND, id: "ws-006", fields: fields({ state: "withdrawn" }), cwd: dir }))).toBe("amend-supersede-instead");
  });

  test("a closed record never changes", async () => {
    expect(code(await amendRecord({ kind: KIND, id: "ws-003", fields: fields({ reviews: [] , title: "x" }), cwd: dir }))).toBe("record-closed");
  });

  test("an id never changes", async () => {
    expect(code(await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ id: "ws-012" }), cwd: dir }))).toBe("amend-id-immutable");
  });

  test("an amendment that changes nothing writes nothing", async () => {
    const before = snapshot();
    expect(await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ title: "One" }), cwd: dir })).toMatchObject({ changed: [] });
    expect(touched(before, snapshot())).toEqual([]);
  });

  test("the result must still be valid", async () => {
    expect(code(await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ options: [] }), cwd: dir }))).toBe("record-schema-invalid");
  });

  test("an unknown or repeated id is refused", async () => {
    expect(code(await amendRecord({ kind: KIND, id: "ws-404", fields: "{}", cwd: dir }))).toBe("record-not-found");
    put("ws-002-again.md", proposal({ id: "ws-002", title: "Again" }));
    expect(code(await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ area: "D1" }), cwd: dir }))).toBe("record-id-duplicate");
  });

  test("--dry-run prints the text and writes nothing", async () => {
    const before = snapshot();
    const doc = await amendRecord({ kind: KIND, id: "ws-002", fields: fields({ area: "D7" }), dryRun: true, cwd: dir });
    expect("text" in doc && doc.text).toContain('area: "D7"');
    expect(touched(before, snapshot())).toEqual([]);
  });
});

describe("records review", () => {
  test("appends a dated verdict bound to the digest of the text it judged", async () => {
    const judged = recordTextDigest(text("ws-001-one.md"));
    const before = snapshot();
    const doc = await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "alice", on: "2026-09-24", cwd: dir });
    const review = { reviewer: "alice", verdict: "agree", on: "2026-09-24", digest: judged };
    expect(doc).toMatchObject({ path: "decisions/ws-001-one.md", id: "ws-001", review, dryRun: false });
    expect(touched(before, snapshot())).toEqual(["ws-001-one.md"]);
    expect(data("ws-001-one.md").reviews).toEqual([review]);
    // A review leaves the digest alone; an amendment moves it, so the verdict no longer matches the text.
    expect(recordTextDigest(text("ws-001-one.md"))).toBe(judged);
    await amendRecord({ kind: KIND, id: "ws-001", fields: fields({ evidence: [] }), cwd: dir });
    expect(recordTextDigest(text("ws-001-one.md"))).not.toBe(judged);
  });

  test("a dissent needs a note", async () => {
    const before = snapshot();
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "dissent", by: "bob", cwd: dir }))).toBe("review-note-required");
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "dissent", by: "bob", note: "  ", cwd: dir }))).toBe("review-note-required");
    expect(touched(before, snapshot())).toEqual([]);
    const doc = await reviewRecord({ kind: KIND, id: "ws-001", verdict: "dissent", by: "bob", note: "It leaves out X.", cwd: dir });
    expect(doc).toMatchObject({ review: { reviewer: "bob", verdict: "dissent", note: "It leaves out X." } });
    // No session kind names these decisions as its subjects, so no session exists to give a verdict in (#2693).
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "carol", session: "S-0001", cwd: dir }))).toBe("session-unknown");
  });

  test("reviews accumulate on a proposal too", async () => {
    await reviewRecord({ kind: KIND, id: "ws-002", verdict: "abstain", by: "carol", cwd: dir });
    await reviewRecord({ kind: KIND, id: "ws-002", verdict: "agree", by: "dan", note: "fine", cwd: dir });
    expect((data("ws-002-two.md").reviews as Data[]).map((r) => r.reviewer)).toEqual(["carol", "dan"]);
  });

  test("a closed record takes no review, and a bad verdict, reviewer or id is refused", async () => {
    expect(code(await reviewRecord({ kind: KIND, id: "ws-003", verdict: "agree", by: "a", cwd: dir }))).toBe("record-closed");
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "approve", by: "a", cwd: dir }))).toBe("write-usage-invalid");
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: " ", cwd: dir }))).toBe("write-usage-invalid");
    expect(code(await reviewRecord({ kind: KIND, id: "ws-404", verdict: "agree", by: "a", cwd: dir }))).toBe("record-not-found");
  });

  test("a kind that declares no reviews takes none", async () => {
    const kindFile = join(dir, "decisions", "decision.kind.mjs");
    writeFileSync(kindFile, readFileSync(kindFile, "utf-8").replace(/^\s*reviews: \{[^}]*\},?\n/m, ""));
    expect(code(await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "a", cwd: dir }))).toBe("review-unsupported");
  });
});

describe("the command line", () => {
  const cli = (args: string[], input?: string) => {
    const loader = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
    try {
      const out = execFileSync(process.execPath, ["--import", loader, join(REPO, "packages", "core", "src", "cli", "main.ts"), "workspace", "records", ...args], {
        cwd: dir,
        input,
        encoding: "utf-8",
        env: { ...process.env, TSX_DISABLE_CACHE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, doc: JSON.parse(out) };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { status: e.status, doc: JSON.parse(e.stdout) };
    }
  };

  test(
    "new reads fields from standard input, review appends, and a refusal exits 1 with its code",
    () => {
      const { id: _id, ...rest } = decision({ title: "From stdin" });
      const made = cli(["new", KIND, "--from", "-"], JSON.stringify(rest));
      expect(made).toMatchObject({ status: 0, doc: { id: "ws-004", path: "decisions/ws-004-from-stdin.md" } });
      expect(existsSync(join(dir, "decisions", "ws-004-from-stdin.md"))).toBe(true);
      const reviewed = cli(["review", "ws-004", "--kind", KIND, "--verdict", "agree", "--by", "alice"]);
      expect(reviewed).toMatchObject({ status: 0, doc: { review: { reviewer: "alice", verdict: "agree" } } });
      const refused = cli(["review", "ws-004", "--kind", KIND, "--verdict", "dissent", "--by", "bob"]);
      expect(refused).toMatchObject({ status: 1, doc: { error: { code: "review-note-required" } } });
      writeFileSync(join(dir, "patch.json"), JSON.stringify({ title: "Changed" }));
      expect(cli(["amend", "ws-004", "--kind", KIND, "--set", "patch.json"])).toMatchObject({ status: 1, doc: { error: { code: "amend-supersede-instead" } } });
      expect(cli(["amend", "ws-004", "--set", "patch.json"])).toMatchObject({ status: 1, doc: { error: { code: "write-usage-invalid" } } });
    },
    120_000,
  );
});
