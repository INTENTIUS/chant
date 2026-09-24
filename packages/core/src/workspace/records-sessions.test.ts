/**
 * Review sessions as a record kind (#2673, #2650 C10), read through the
 * reference workspace's session kind: a closed session's seal is checked on
 * read, each verdict names a decision that exists, and each session lists the
 * decision reviews that cite it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, REPO } from "./__fixtures__/contract-repo";
import { reviewed, sessionText, SESSIONS_KIND as SESSIONS, sessionsRepo as fixture } from "./__fixtures__/sessions";
import { sessionSeal } from "./record-sessions";
import { queryRecords, type RecordsDocument } from "./records-cli";
import recordsSchema from "./records.schema.json";

afterAll(cleanScratch);

const { expectValid } = contract(recordsSchema);

async function read(root: string, at?: string): Promise<Extract<RecordsDocument, { records: unknown }>> {
  const doc = await queryRecords({ kind: SESSIONS, cwd: root, ...(at ? { at } : {}) });
  expectValid(doc);
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

describe("the session kind (#2673)", () => {
  test("the reference workspace's session is closed, sealed and valid, and cited by nothing", async () => {
    const doc = await read(join(REPO, "reference-workspace"));
    expect(doc.kind.name).toBe("session");
    expect(doc.records.map((r) => [r.id, r.state, r.valid])).toEqual([["S-0001", "closed", true]]);
    expect(doc.records[0].citedBy).toEqual([]);
  });

  test("the seal is the awk recipe the docs give", () => {
    const file = join(REPO, "reference-workspace", "design", "sessions", "S-0001-first-walk-of-the-reference-decisions.md");
    const awk = execFileSync("sh", ["-c", `awk 'NR==1&&/^---$/{f=1;print;next} f&&/^---$/{f=0} f&&/^closed_digest:/{next} {print}' "$1" | shasum -a 256`, "sh", file], { encoding: "utf-8" });
    const text = readFileSync(file, "utf-8");
    expect(awk.split(" ")[0]).toBe(sessionSeal(text, "closed_digest"));
    expect(text).toContain(`closed_digest: "${sessionSeal(text, "closed_digest")}"`);
    // CRLF line endings hash as LF.
    expect(sessionSeal(text.replace(/\n/g, "\r\n"), "closed_digest")).toBe(sessionSeal(text, "closed_digest"));
  });

  test("a closed session edited after it closed is session-seal-mismatch", async () => {
    const root = fixture();
    const file = join(root, "design", "sessions", "S-0001-first-walk-of-the-reference-decisions.md");
    writeFileSync(file, readFileSync(file, "utf-8").replace("First walk", "Second walk"));
    const s1 = (await read(root)).records[0];
    expect(s1.valid).toBe(false);
    expect(s1.reasons.map((r) => r.code)).toEqual(["session-seal-mismatch"]);
  });

  test("an open session with a seal, or a closed one without, is schema-invalid", async () => {
    const root = fixture();
    const dir = join(root, "design", "sessions");
    writeFileSync(join(dir, "S-0002-open.md"), sessionText({ id: "S-0002", state: "open" }).replace("verdicts: []", 'verdicts: []\nclosed_digest: "' + "0".repeat(64) + '"'));
    writeFileSync(join(dir, "S-0003-closed.md"), sessionText({ id: "S-0003", state: "closed" }).replace(/^closed_digest: .*\n/m, ""));
    const doc = await read(root);
    expect(doc.records.filter((r) => r.id !== "S-0001").map((r) => [r.id, r.reasons.map((x) => x.code)])).toEqual([
      ["S-0002", ["record-schema-invalid"]],
      ["S-0003", ["record-schema-invalid"]],
    ]);
  });

  test("a verdict naming a record no decision has is session-verdict-unknown-record", async () => {
    const root = fixture();
    writeFileSync(
      join(root, "design", "sessions", "S-0002-walk.md"),
      sessionText({ id: "S-0002", state: "closed", verdicts: [{ record: "ref-001", principal: "alice", verdict: "agree" }, { record: "ref-999", principal: "alice", verdict: "agree" }] }),
    );
    const s2 = (await read(root)).records.find((r) => r.id === "S-0002")!;
    expect(s2.valid).toBe(false);
    expect(s2.reasons).toEqual([{ code: "session-verdict-unknown-record", message: expect.stringContaining("verdicts[1] names ref-999") }]);
  });

  test("each session lists the decision reviews that name it, and --at reads both kinds at the revision", async () => {
    const root = fixture();
    writeFileSync(join(root, "design", "sessions", "S-0002-walk.md"), sessionText({ id: "S-0002", state: "open" }));
    const open = commitAll(root, "open S-0002");
    reviewed(root, ["alice", "bob"], "S-0002");
    writeFileSync(
      join(root, "design", "sessions", "S-0002-walk.md"),
      sessionText({ id: "S-0002", state: "closed", verdicts: [{ record: "ref-001", principal: "alice", verdict: "agree" }, { record: "ref-001", principal: "bob", verdict: "agree" }] }),
    );
    const doc = await read(root);
    expect(doc.summary.invalid).toBe(0);
    const s2 = doc.records.find((r) => r.id === "S-0002")!;
    expect(s2.citedBy).toEqual([
      { id: "ref-001", path: "decisions/ref-001-how-the-app-is-deployed.md", index: 0, reviewer: "alice", verdict: "agree" },
      { id: "ref-001", path: "decisions/ref-001-how-the-app-is-deployed.md", index: 1, reviewer: "bob", verdict: "agree" },
    ]);
    expect(doc.records.find((r) => r.id === "S-0001")!.citedBy).toEqual([]);
    const then = await read(root, open);
    expect(then.records.find((r) => r.id === "S-0002")).toMatchObject({ state: "open", valid: true, citedBy: [] });
  });

  test("the decision kind accepts a review entry naming its session", async () => {
    const root = fixture();
    reviewed(root, ["alice"], "S-0001");
    const doc = await queryRecords({ kind: "decisions/decision.kind.mjs", cwd: root });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.records.find((r) => r.id === "ref-001")).toMatchObject({ valid: true });
    expect((await read(root)).records[0].citedBy).toEqual([expect.objectContaining({ id: "ref-001", reviewer: "alice" })]);
  });
});
