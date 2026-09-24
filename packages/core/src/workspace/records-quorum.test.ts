/**
 * A record's digest and its quorum (#2671, #2672).
 *
 * `recordTextDigest` hashes a record's text without its reviews block, so a
 * verdict can name the text it judged and stop counting after an amendment.
 * `computeQuorum` lists which verdicts count toward the quorum and why the
 * others don't. The end-to-end reads through `records --json` are in
 * records-contract.test.ts.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { workingTreeSource } from "./record-source";
import { computeQuorum, DEFAULT_QUORUM, loadRecordKind, normalisePrincipal, readRecords, recordTextDigest, type QuorumOptions, type RecordEntry } from "./records";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const DECISIONS = join(REPO, "docs", "design", "decisions");
const SAMPLE = readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8");

/** ws-003 with its reviews list replaced. `reviews` is the YAML under `reviews:`, or null for `reviews: []`. */
function withReviews(reviews: string | null, text = SAMPLE): string {
  return text.replace(/^reviews: \[\]$/m, reviews === null ? "reviews: []" : `reviews:\n${reviews.replace(/\n$/, "")}`);
}

/** One review entry as YAML. */
function review(reviewer: string, verdict: string, extra: Record<string, string> = {}): string {
  const note = verdict === "dissent" && !extra.note ? { note: "it misses a case" } : {};
  const fields = { reviewer, verdict, on: "2026-09-24", ...note, ...extra };
  return Object.entries(fields)
    .map(([k, v], i) => `${i === 0 ? "  - " : "    "}${k}: ${JSON.stringify(v)}`)
    .join("\n");
}

const BARE = recordTextDigest(SAMPLE);

describe("recordTextDigest", () => {
  test("is the sha256 hex of the text with the reviews block taken out", () => {
    expect(BARE).toMatch(/^[0-9a-f]{64}$/);
    const lines = SAMPLE.split("\n");
    const without = lines.filter((l) => l !== "reviews: []").join("\n");
    expect(recordTextDigest(SAMPLE)).toBe(recordTextDigest(without, null));
  });

  test("does not move when a verdict is added, changed or removed", () => {
    const one = withReviews(review("alice", "agree"));
    const two = withReviews(`${review("alice", "agree", { digest: BARE })}\n${review("bob", "dissent", { note: "no" })}`);
    expect(recordTextDigest(one)).toBe(BARE);
    expect(recordTextDigest(two)).toBe(BARE);
    // The compact form, with the list at column 0, and comments and blank lines inside the block.
    const compact = SAMPLE.replace(/^reviews: \[\]$/m, `reviews:\n# first review\n- reviewer: "alice"\n  verdict: "agree"\n\n  on: "2026-09-24"`);
    expect(recordTextDigest(compact)).toBe(BARE);
    // A quoted key is the same key.
    expect(recordTextDigest(SAMPLE.replace(/^reviews: \[\]$/m, `"reviews": []`))).toBe(BARE);
  });

  test("moves with any other edit, in the front matter or the body", () => {
    expect(recordTextDigest(SAMPLE.replace(/^title: .*$/m, 'title: "Seal scope, amended"'))).not.toBe(BARE);
    expect(recordTextDigest(`${SAMPLE}\nOne more line.\n`)).not.toBe(BARE);
    // The line after the block is kept: removal stops at the next key.
    expect(recordTextDigest(SAMPLE.replace(/^constrains:$/m, "constrains: # the scope"))).not.toBe(BARE);
  });

  test("reads CRLF and LF alike", () => {
    expect(recordTextDigest(SAMPLE.replace(/\n/g, "\r\n"))).toBe(BARE);
  });

  test("hashes text with no front matter as it is", () => {
    expect(recordTextDigest("reviews: []\nbody\n")).toBe(recordTextDigest("reviews: []\nbody\n", null));
    expect(recordTextDigest("---\nreviews: []\nno closing line\n")).toBe(recordTextDigest("---\nreviews: []\nno closing line\n", null));
  });

  test("a hand-editor gets the same digest with awk and sha256sum", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-digest-")));
    try {
      const file = join(dir, "ws-003.md");
      writeFileSync(file, withReviews(`${review("alice", "agree")}\n${review("bob", "dissent")}`));
      // The recipe in docs/src/content/docs/cli/workspace-records.mdx.
      const awk = `awk 'NR==1&&$0=="---"{fm=1;print;next} fm&&$0=="---"{fm=0;skip=0;print;next} fm&&/^reviews[ \\t]*:/{skip=1;next} fm&&skip&&/^([ \\t#-]|$)/{next} {skip=0;print}' "${file}" | shasum -a 256`;
      const out = execFileSync("sh", ["-c", awk], { encoding: "utf-8" });
      expect(out.split(" ")[0]).toBe(BARE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalisePrincipal", () => {
  test("trims and case-folds", () => {
    expect(normalisePrincipal("Alice ")).toBe("alice");
    expect(normalisePrincipal(" ALICE")).toBe(normalisePrincipal("alice"));
    expect(normalisePrincipal("ａｌｉｃｅ")).toBe("alice");
  });
});

describe("computeQuorum", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-quorum-")));
    mkdirSync(join(dir, "decisions"));
    cpSync(join(DECISIONS, "decision.kind.mjs"), join(dir, "decisions", "decision.kind.mjs"));
    cpSync(join(DECISIONS, "decision.schema.json"), join(dir, "decisions", "decision.schema.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const OPTIONS: QuorumOptions = { need: DEFAULT_QUORUM, needFrom: "default", agents: new Set(), attestation: false };

  async function quorumOf(text: string, options: Partial<QuorumOptions> = {}) {
    writeFileSync(join(dir, "decisions", "ws-003-seal-scope.md"), text);
    const loaded = await loadRecordKind(join(dir, "decisions", "decision.kind.mjs"));
    const { records } = await readRecords(loaded, { root: dir, source: workingTreeSource(dir) });
    const record = records[0] as RecordEntry;
    expect(record.reasons).toEqual([]);
    return { record, quorum: computeQuorum(loaded.kind, record, { ...OPTIONS, ...options })! };
  }

  const principals = (list: Array<{ principal: string; reason?: { code: string } }>) => list.map((v) => (v.reason ? `${v.principal}:${v.reason.code}` : v.principal));

  test("alice and 'Alice ' count once: the later verdict stands, the earlier is a duplicate", async () => {
    const { quorum } = await quorumOf(withReviews(`${review("alice", "agree", { digest: BARE })}\n${review("Alice ", "agree", { digest: BARE })}`));
    expect(principals(quorum.counted)).toEqual(["alice"]);
    expect(quorum.counted[0].reviewer).toBe("Alice ");
    expect(principals(quorum.notCounted)).toEqual(["alice:review-duplicate"]);
    expect(quorum).toMatchObject({ need: 2, agreed: 1, met: false, metWithObjections: false });
  });

  test("a review by the decider is listed as not counted", async () => {
    const { quorum } = await quorumOf(withReviews(`${review("Lex00", "agree", { digest: BARE })}\n${review("bob", "agree", { digest: BARE })}`));
    expect(principals(quorum.notCounted)).toEqual(["lex00:review-decider"]);
    expect(principals(quorum.counted)).toEqual(["bob"]);
  });

  test("amending the record after one agree drops the count from 1 to 0, with review-older-digest", async () => {
    const reviewed = withReviews(review("alice", "agree", { digest: BARE }));
    const before = await quorumOf(reviewed);
    expect(before.quorum.agreed).toBe(1);
    const after = await quorumOf(reviewed.replace(/^question: .*$/m, 'question: "What does a seal cover, now?"'));
    expect(after.record.digest).not.toBe(BARE);
    expect(after.quorum.counted).toEqual([]);
    expect(after.quorum.agreed).toBe(0);
    expect(principals(after.quorum.notCounted)).toEqual(["alice:review-older-digest"]);
    expect(after.quorum.notCounted[0].reason!.message).toContain(BARE.slice(0, 12));
  });

  test("a verdict with no digest counts, and the record carries review-undigested", async () => {
    const { record, quorum } = await quorumOf(withReviews(`${review("alice", "agree")}\n${review("bob", "agree", { digest: BARE })}`));
    expect(principals(quorum.counted)).toEqual(["alice", "bob"]);
    expect(quorum.counted[0].digest).toBeNull();
    expect(quorum).toMatchObject({ agreed: 2, met: true, metWithObjections: false });
    expect(record.warnings.map((w) => w.code)).toEqual(["review-undigested"]);
    expect(record.warnings[0].message).toContain("alice");
    expect(record.warnings[0].message).not.toContain("bob");
  });

  test("a met count with an open concern is met with objections, never consensus", async () => {
    const reviews = [review("alice", "agree", { digest: BARE }), review("bob", "agree", { digest: BARE }), review("carol", "dissent", { digest: BARE, proposes: "ws-900" })];
    const { quorum } = await quorumOf(withReviews(reviews.join("\n")));
    expect(quorum).toMatchObject({ agreed: 2, met: true, metWithObjections: true });
    expect(quorum.openConcerns).toEqual([{ index: 2, principal: "carol", reviewer: "carol", note: "it misses a case", proposes: "ws-900" }]);
  });

  test("an addressed or withdrawn dissent is no open concern", async () => {
    const reviews = [
      review("alice", "agree", { digest: BARE }),
      review("bob", "agree", { digest: BARE }),
      review("carol", "dissent", { digest: BARE, addressed_by: "ws-001" }),
      review("dan", "dissent", { digest: BARE, withdrawn_on: "2026-09-25" }),
    ];
    const { quorum } = await quorumOf(withReviews(reviews.join("\n")));
    expect(quorum.openConcerns).toEqual([]);
    expect(quorum).toMatchObject({ met: true, metWithObjections: false });
  });

  test("an agent's verdict is not counted, and under an attestation policy an unsealed one is not either", async () => {
    const text = withReviews(`${review("Bot-1", "agree", { digest: BARE })}\n${review("alice", "agree", { digest: BARE })}`);
    const agents = await quorumOf(text, { agents: new Set(["bot-1"]) });
    expect(principals(agents.quorum.notCounted)).toEqual(["bot-1:review-agent"]);
    const attested = await quorumOf(text, { attestation: true });
    expect(principals(attested.quorum.notCounted)).toEqual(["bot-1:review-unattested", "alice:review-unattested"]);
    expect(attested.quorum.counted).toEqual([]);
  });

  test("the declared need applies, and a need of 0 is met with no verdict", async () => {
    const { quorum } = await quorumOf(SAMPLE, { need: 0, needFrom: "declaration" });
    expect(quorum).toMatchObject({ need: 0, needFrom: "declaration", agreed: 0, met: true, counted: [], notCounted: [], openConcerns: [] });
  });

  test("a kind with no reviews list has no quorum", async () => {
    const loaded = await loadRecordKind(join(DECISIONS, "decision.kind.mjs"));
    const { reviews: _drop, ...kind } = loaded.kind;
    expect(computeQuorum(kind, { data: {}, digest: BARE }, OPTIONS)).toBeNull();
    expect(computeQuorum(loaded.kind, { data: null, digest: BARE }, OPTIONS)).toBeNull();
  });
});
