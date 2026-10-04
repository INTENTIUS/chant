/**
 * Concurrent writers in one working tree through the command line (#3173,
 * ws-089): three `records amend --expect` processes started at once against
 * one record, two people's and an agent's (CHANT_AGENT). Exactly one wins;
 * the others exit 1 with record-conflict and the digest to retry from, and the
 * retry wins. Then a batch: `lock acquire` holds the lock, a write run with
 * CHANT_WRITE_LOCK goes ahead, and one without it is refused with
 * write-lock-timeout until `lock release`. The in-process cases are in
 * records-concurrent.test.ts.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, git, REPO, repo } from "./__fixtures__/contract-repo";
import { parseFrontMatter } from "./records";
import { renderRecord } from "./records-write";

const DECISIONS = join(REPO, "docs", "design", "decisions");
const KIND = "decisions/decision.kind.mjs";
type Data = Record<string, unknown>;

const SAMPLE = (() => {
  const fm = parseFrontMatter(readFileSync(join(DECISIONS, "ws-003-seal-scope.md"), "utf-8"));
  if (!fm.ok) throw new Error(fm.message);
  return fm.value;
})();
const proposal = (over: Data): Data => ({ ...structuredClone(SAMPLE), state: "proposed", choice: null, decided_by: null, decided_on: null, ...over });

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
      "decisions/ws-001-one.md": renderRecord(proposal({ id: "ws-001", title: "One" }), "\n# One\n"),
      "app/server.mjs": "export const port = 8080;\n",
    },
    true,
  );
  git(root, "branch", "-M", "main");
});
afterAll(cleanScratch);

/** Run chant in the repository, without waiting on the others. */
function chant(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<{ status: number; doc: Record<string, any> }> {
  const loader = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--import", loader, join(REPO, "packages", "core", "src", "cli", "main.ts"), "workspace", ...args],
      { cwd: root, encoding: "utf-8", env: { ...process.env, TSX_DISABLE_CACHE: "1", ...opts.env } },
      (err, stdout, stderr) => {
        try {
          resolve({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, doc: JSON.parse(stdout) });
        } catch {
          reject(new Error(`chant ${args.join(" ")} printed no JSON: ${stderr}`));
        }
      },
    );
    child.stdin!.end(opts.input ?? "");
  });
}

const amend = (fields: Data, expect: string, env?: Record<string, string>) => chant(["records", "amend", "ws-001", "--kind", KIND, "--set", "-", "--expect", expect], { input: JSON.stringify(fields), env });

describe("concurrent writers through the command line (#3173)", () => {
  test(
    "three amends from one digest in three processes: one wins, two conflict, and their retries win",
    async () => {
      const read = await chant(["records", "--kind", KIND, "--json"]);
      const d0 = read.doc.records.find((r: { id: string }) => r.id === "ws-001").digest as string;
      const runs = await Promise.all([
        amend({ title: "One, as alice has it" }, d0),
        amend({ question: "What does bob ask?" }, d0),
        amend({ constrains: ["member:app"] }, d0, { CHANT_AGENT: "app-agent" }),
      ]);
      const won = runs.filter((r) => r.status === 0);
      const lost = runs.filter((r) => r.status !== 0);
      expect(won).toHaveLength(1);
      expect(lost.map((r) => r.doc.error.code)).toEqual(["record-conflict", "record-conflict"]);
      const d1 = won[0].doc.digest as string;
      for (const r of lost) expect(r.doc.conflict).toMatchObject({ expected: d0, digest: d1, lastWrite: { verb: "records amend" } });

      // Each loser retries from what it was told, one after the other.
      const fieldsOf = (i: number) => [{ title: "One, as alice has it" }, { question: "What does bob ask?" }, { constrains: ["member:app"] }][i];
      let digest = d1;
      for (const r of lost) {
        const i = runs.indexOf(r);
        const retry = await amend(fieldsOf(i), digest, i === 2 ? { CHANT_AGENT: "app-agent" } : undefined);
        expect(retry.status).toBe(0);
        digest = retry.doc.digest;
      }
      const end = await chant(["records", "--kind", KIND, "--json"]);
      const rec = end.doc.records.find((r: { id: string }) => r.id === "ws-001");
      expect(rec.digest).toBe(digest);
      expect(rec.data).toMatchObject({ title: "One, as alice has it", question: "What does bob ask?", constrains: ["member:app"] });
      expect(rec.lastWrite).toMatchObject({ verb: "records amend" });
    },
    120_000,
  );

  test(
    "a batch holds the lock across calls: its own writes go ahead, another writer's waits and is refused",
    async () => {
      const taken = await chant(["lock", "acquire", "--holder", "hud:alice", "--ttl", "60s"]);
      expect(taken).toMatchObject({ status: 0, doc: { verb: "acquire", holder: { verb: "batch", by: "hud:alice" } } });
      const token = taken.doc.token as string;
      const status = await chant(["lock"]);
      expect(status.doc.holder).toMatchObject({ by: "hud:alice" });
      expect(status.doc.token).toBeUndefined();

      const outsider = await chant(["records", "review", "ws-001", "--kind", KIND, "--verdict", "agree", "--by", "bob"], { env: { CHANT_WRITE_LOCK_WAIT_MS: "300" } });
      expect(outsider).toMatchObject({ status: 1, doc: { error: { code: "write-lock-timeout" } } });
      expect(outsider.doc.error.message).toContain("hud:alice");
      const inside = await chant(["records", "review", "ws-001", "--kind", KIND, "--verdict", "agree", "--by", "alice"], { env: { CHANT_WRITE_LOCK: token } });
      expect(inside.status).toBe(0);

      expect((await chant(["lock", "release", "--token", token])).status).toBe(0);
      const after = await chant(["records", "review", "ws-001", "--kind", KIND, "--verdict", "agree", "--by", "bob"]);
      expect(after.status).toBe(0);
    },
    120_000,
  );
});
