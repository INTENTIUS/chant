/**
 * Concurrent writers in one working tree (#3173, ws-089): two people and an
 * agent amend one record at once, each from the digest they read. Exactly one
 * write wins per digest; the others are refused with record-conflict, naming
 * the digest the record has now and who wrote it, and win when they retry
 * from it. Nothing anyone wrote is lost. The same through the command line,
 * in separate processes, is in records-concurrent.e2e.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo } from "./__fixtures__/contract-repo";
import { parseFrontMatter } from "./records";
import { queryRecords } from "./records-cli";
import { amendRecord, newRecord, renderRecord, reviewRecord, type AmendDocument } from "./records-write";
import amendSchema from "./records-amend.schema.json";
import recordsSchema from "./records.schema.json";

const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";
type Data = Record<string, unknown>;

const SAMPLE = (() => {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();
const proposal = (over: Data): Data => ({ ...structuredClone(SAMPLE), state: "proposed", choice: null, decided_by: null, decided_on: null, ...over });
const record = (d: Data) => renderRecord(d, `\n# ${String(d.title)}\n`);

const amendDoc = contract(amendSchema);
const recordsDoc = contract(recordsSchema);

let root: string;
beforeAll(() => {
  root = repo(
    {
      "chant.workspace.json": JSON.stringify({
        name: "box",
        schema: 1,
        members: [{ name: "app", dir: "app", kind: "other", because: "a plain Node server" }],
        records: [{ kind: KIND }],
        writeScope: { agent: { records: { decision: ["new", "amend", "review"] } } },
        agents: [{ name: "app-agent", member: "app" }],
      }),
      [KIND]: readFileSync(join(DECISIONS, "decision.kind.mjs"), "utf-8"),
      "decisions/decision.schema.json": readFileSync(join(DECISIONS, "decision.schema.json"), "utf-8"),
      "decisions/ws-001-one.md": record(proposal({ id: "ws-001", title: "One" })),
      "app/server.mjs": "export const port = 8080;\n",
    },
    true,
  );
  git(root, "branch", "-M", "main");
});
afterAll(cleanScratch);

async function read(id: string): Promise<{ digest: string; lastWrite: unknown; data: Data }> {
  const doc = await queryRecords({ kind: KIND, cwd: root });
  recordsDoc.expectValid(doc);
  const r = (doc as { records: { id: string; digest: string; lastWrite: unknown; data: Data }[] }).records.find((x) => x.id === id)!;
  return { digest: r.digest, lastWrite: r.lastWrite, data: r.data };
}

const failed = (d: AmendDocument) => ("error" in d ? d : null);

describe("two people and an agent amend one record at once (#3173)", () => {
  test("exactly one wins per digest, and the others get a conflict they can retry", async () => {
    const start = await read("ws-001");
    expect(start.lastWrite).toBeNull();

    const writes = {
      alice: { fields: { title: "One, as alice has it" } },
      bob: { fields: { question: "What does bob ask?" } },
      agent: { fields: { constrains: ["member:app"] }, agent: "app-agent" },
    } as const;
    const amend = (who: keyof typeof writes, expect: string) =>
      amendRecord({ kind: KIND, id: "ws-001", fields: JSON.stringify(writes[who].fields), cwd: root, expect, agent: who === "agent" ? "app-agent" : undefined });

    // All three from the digest they read, at once.
    const first = await Promise.all((["alice", "bob", "agent"] as const).map(async (who) => [who, await amend(who, start.digest)] as const));
    for (const [, doc] of first) amendDoc.expectValid(doc);
    const won = first.filter(([, d]) => !failed(d));
    const lost = first.filter(([, d]) => failed(d));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(2);
    const [winner, winDoc] = won[0];
    const d1 = (winDoc as { digest: string }).digest;
    expect(d1).not.toBe(start.digest);
    for (const [, doc] of lost) {
      const f = failed(doc)!;
      expect(f.error.code).toBe("record-conflict");
      expect(f.error.message).toContain(d1);
      expect(f.conflict).toMatchObject({ id: "ws-001", path: "decisions/ws-001-one.md", expected: start.digest, digest: d1 });
      expect(f.conflict!.lastWrite).toMatchObject({ verb: "records amend", agent: winner === "agent" ? "app-agent" : null });
    }

    // The read contract shows the same digest and who wrote it.
    const after = await read("ws-001");
    expect(after.digest).toBe(d1);
    expect(after.lastWrite).toMatchObject({ verb: "records amend" });

    // Each loser retries from the digest its conflict named; the first retry wins, the second conflicts again, then wins.
    const [[l1], [l2]] = lost;
    const r1 = await amend(l1, d1);
    expect(failed(r1)).toBeNull();
    const d2 = (r1 as { digest: string }).digest;
    const r2 = await amend(l2, d1);
    expect(failed(r2)?.conflict?.digest).toBe(d2);
    const r3 = await amend(l2, d2);
    expect(failed(r3)).toBeNull();

    // Nothing anyone wrote was lost.
    const end = await read("ws-001");
    expect(end.data).toMatchObject({ title: "One, as alice has it", question: "What does bob ask?", constrains: ["member:app"] });
    expect(end.digest).toBe((r3 as { digest: string }).digest);
  });

  test("a verdict on a text the reviewer did not see is refused, and one on the current text is taken", async () => {
    const now = await read("ws-001");
    const stale = await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "carol", cwd: root, expect: "0".repeat(64) });
    expect(stale).toMatchObject({ error: { code: "record-conflict" }, conflict: { digest: now.digest } });
    const fresh = await reviewRecord({ kind: KIND, id: "ws-001", verdict: "agree", by: "carol", cwd: root, expect: now.digest });
    expect(fresh).toMatchObject({ digest: now.digest, review: { reviewer: "carol", digest: now.digest } });
    expect((await read("ws-001")).lastWrite).toMatchObject({ verb: "records review", by: "carol" });
  });

  test("writes without --expect are serialised, so none is lost and no id is handed out twice", async () => {
    const titles = ["Two", "Three", "Four"];
    const made = await Promise.all(titles.map((title) => newRecord({ kind: KIND, fields: JSON.stringify(proposal({ id: undefined, title })), cwd: root })));
    const ids = made.map((d) => ("error" in d ? d.error.code : d.id));
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^ws-00[2-4]$/);
    const amended = await Promise.all([
      amendRecord({ kind: KIND, id: "ws-002", fields: JSON.stringify({ title: "Two, retitled" }), cwd: root }),
      amendRecord({ kind: KIND, id: "ws-002", fields: JSON.stringify({ question: "Asked again?" }), cwd: root }),
    ]);
    expect(amended.every((d) => !("error" in d))).toBe(true);
    expect((await read("ws-002")).data).toMatchObject({ title: "Two, retitled", question: "Asked again?" });
  });

  test("--expect that is not a digest is a usage error, and nothing is read", async () => {
    expect(await amendRecord({ kind: KIND, id: "ws-001", fields: "{}", cwd: root, expect: "abc" })).toMatchObject({ error: { code: "write-usage-invalid" } });
  });
});
