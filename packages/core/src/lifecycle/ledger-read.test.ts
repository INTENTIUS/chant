import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, it } from "vitest";
import type { LedgerReadPort } from "./ledger-port";
import { ledgerFields, readLedgerTable, resolveLedgerRevision, revisionLedgerReadPort, LedgerRevisionError } from "./ledger-read";

const validate = new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(join(__dirname, "..", "workspace", "ledger.schema.json"), "utf-8")) as object);
const valid = (doc: unknown) => {
  const ok = validate(doc);
  if (!ok) throw new Error(JSON.stringify(validate.errors));
  return ok;
};

/** A port over files held in memory: `{ "<dir>/<file>": text }`. */
function memoryPort(files: Record<string, string>): LedgerReadPort {
  return {
    read: async (dir, file) => files[`${dir}/${file}`] ?? null,
    list: async (dir) => Object.keys(files).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    trees: async () => [...new Set(Object.keys(files).map((k) => k.split("/")[0]))],
  };
}

const pending = { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: "2026-10-09T05:00:00.000Z", expiresAt: "2026-10-10T05:00:00.000Z", planDigest: "sha256:aa" };
const approval = { version: 1, op: "tf-apply", gate: "wave-1", timestamp: "2026-10-09T05:10:00.000Z", resolvedBy: "approver-one", planDigest: "sha256:aa" };
const other = { version: 1, kind: "pending", op: "deploy", gate: "prod", timestamp: "2026-10-20T05:00:00.000Z", expiresAt: "2026-10-21T05:00:00.000Z", planDigest: "sha256:bb" };
const gates = { "_gates/tf-apply.jsonl": `${JSON.stringify(pending)}\n${JSON.stringify(approval)}\nnot json\n`, "_gates/deploy.jsonl": `${JSON.stringify(other)}\n` };
const now = new Date("2026-10-23T00:00:00.000Z");

describe("chant ledger (#4363)", () => {
  it("prints a table's rows as chant query loads them, filtered by --where", async () => {
    const doc = await readLedgerTable("gates", [{ member: null, port: memoryPort(gates) }], { where: ["op=tf-apply", "kind=resolution"], now });
    expect(valid(doc)).toBe(true);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.total).toBe(3);
    expect(doc.malformed).toBe(1);
    expect(doc.filter).toEqual({ where: ["op=tf-apply", "kind=resolution"], since: null });
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]).toMatchObject({ member: null, op: "tf-apply", gate: "wave-1", resolved_by: "approver-one", plan_digest: "sha256:aa", signed: false, empty: false });
    expect(Object.keys(doc.rows[0])).toEqual(doc.columns);
  });

  it("keeps the rows at or after --since on the table's time column", async () => {
    const doc = await readLedgerTable("gates", [{ member: null, port: memoryPort(gates) }], { since: "7d", now });
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.filter.since).toBe("2026-10-16T00:00:00.000Z");
    expect(doc.rows.map((r) => r.op)).toEqual(["deploy"]);
  });

  it("prints a JSON column parsed, and filters on a key under it", async () => {
    const run = { version: 1, id: "r1", op: "tf-apply", env: "prod", started: "2026-10-22T00:00:00.000Z", ended: "2026-10-22T00:01:00.000Z", status: "succeeded", phases: [], labels: { team: "core" }, outcomes: {} };
    const port = memoryPort({ "prod/runs__tf-apply.jsonl": `${JSON.stringify(run)}\n` });
    const doc = await readLedgerTable("runs", [{ member: "app", port }], { where: ["labels.team=core"], now });
    expect(valid(doc)).toBe(true);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.rows).toHaveLength(1);
    expect(doc.rows[0]).toMatchObject({ member: "app", id: "r1", labels: { team: "core" } });
  });

  it("refuses an unknown table, a bad filter, and --since on a table with no time, without reading", async () => {
    const never = async (): Promise<never> => {
      throw new Error("read");
    };
    for (const [table, opts, code] of [
      ["states", {}, "table-unknown"],
      ["gates", { where: ["approver=x"] }, "filter-invalid"],
      ["snapshots", { where: ["resources>many"] }, "filter-invalid"],
      ["releases", { since: "7d" }, "filter-invalid"],
    ] as const) {
      const doc = await readLedgerTable(table, never, opts);
      expect(valid(doc)).toBe(true);
      expect(doc).toMatchObject({ error: { code } });
    }
  });

  it("types each table's columns from chant query's schema", () => {
    expect(ledgerFields("snapshots")).toMatchObject({ resources: "number", observed_at: "time", lexicon: "text" });
    expect(ledgerFields("cuts")).toMatchObject({ signed: "boolean", timestamp: "time" });
    expect(ledgerFields("resources").attributes).toBe("json");
  });

  describe("--at", () => {
    const repo = mkdtempSync(join(tmpdir(), "chant-ledger-at-"));
    afterAll(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...a: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf-8" });

    it("reads the ledger as a commit of chant/lifecycle held it", async () => {
      git("init", "-q", "-b", "chant/lifecycle");
      mkdirSync(join(repo, "_gates"));
      writeFileSync(join(repo, "_gates", "tf-apply.jsonl"), `${JSON.stringify(pending)}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      writeFileSync(join(repo, "_gates", "tf-apply.jsonl"), `${JSON.stringify(pending)}\n${JSON.stringify(approval)}\n`);
      git("commit", "-q", "-am", "two");
      const at = (rev: string) => readLedgerTable("gates", [{ member: null, port: revisionLedgerReadPort(repo, resolveLedgerRevision(repo, rev), "") }], { at: rev });
      const then = await at("chant/lifecycle~1");
      const tip = await at("chant/lifecycle");
      if ("error" in then || "error" in tip) throw new Error("read failed");
      expect(then.at).toBe("chant/lifecycle~1");
      expect(then.rows.map((r) => r.kind)).toEqual(["pending"]);
      expect(tip.rows.map((r) => r.kind)).toEqual(["pending", "resolution"]);
      expect(() => resolveLedgerRevision(repo, "no-such-rev")).toThrow(LedgerRevisionError);
    });
  });
});
