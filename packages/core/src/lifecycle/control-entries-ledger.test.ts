/**
 * #4593: the control repo's `_control/entries.jsonl` (#4568) as the
 * `control_entries` table of read contract v1, in `chant query` and
 * `chant ledger`, over a fixture ledger.
 */

import { describe, expect, test } from "vitest";
import { controlEntryDigest, type ControlEntryRecord } from "../control/records";
import { NEXT_RELEASE } from "../release-floors";
import type { LedgerReadPort } from "./ledger-port";
import { ledgerFields, LEDGER_TABLES, LEDGER_TIME_COLUMN } from "./ledger-read";
import { LEDGER_CONTROL_ENTRIES_FLOOR, loadQueryData, QUERY_TABLES, runQuery } from "./query";

function port(files: Record<string, string>): LedgerReadPort {
  return {
    read: async (dir, file) => files[`${dir}/${file}`] ?? null,
    list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    trees: async () => [...new Set(Object.keys(files).map((p) => p.slice(0, p.indexOf("/"))))],
  };
}

function record(fields: Omit<ControlEntryRecord, "digest" | "version" | "kind">): ControlEntryRecord {
  const body = { version: 1 as const, kind: "control-entry" as const, ...fields };
  return { ...body, digest: controlEntryDigest(body) };
}

const project = "github.com/acme/network";
const v1 = record({ id: "ctl-001", entry: "project", project, state: "active", settings: { waves: ["dev"] }, estates: ["net"], product: "terragucci", at: "2026-10-27T10:00:00Z", by: "github:alice", prev: null });
const v2 = record({ id: "ctl-001", entry: "project", project, state: "active", settings: { waves: ["dev", "prod"] }, estates: ["net"], product: "terragucci", at: "2026-10-27T11:00:00Z", prev: v1.digest });
const defaults = record({ id: "ctl-002", entry: "defaults", project: null, state: "active", settings: { lockGrain: "target" }, estates: [], product: "plywood", at: "2026-10-27T10:30:00Z", prev: null });
const tampered = { ...defaults, settings: { lockGrain: "repo" } };

const FIXTURE = {
  "_control/entries.jsonl": [v1, defaults, v2, tampered].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n",
};

describe("control_entries", () => {
  test("one row per version, with its digest, the digest it replaced and whether it is current", async () => {
    const { data, malformed } = await loadQueryData([{ member: "control", port: port(FIXTURE) }]);
    expect(data.control_entries).toEqual([
      { member: "control", id: "ctl-001", entry: "project", project, state: "active", product: "terragucci", settings: JSON.stringify({ waves: ["dev"] }), estates: JSON.stringify(["net"]), by: "github:alice", timestamp: v1.at, digest: v1.digest, prev_digest: null, current: 0 },
      { member: "control", id: "ctl-002", entry: "defaults", project: null, state: "active", product: "plywood", settings: JSON.stringify({ lockGrain: "target" }), estates: "[]", by: null, timestamp: defaults.at, digest: defaults.digest, prev_digest: null, current: 1 },
      { member: "control", id: "ctl-001", entry: "project", project, state: "active", product: "terragucci", settings: JSON.stringify({ waves: ["dev", "prod"] }), estates: JSON.stringify(["net"]), by: null, timestamp: v2.at, digest: v2.digest, prev_digest: v1.digest, current: 1 },
    ]);
    // The tampered line (its digest no longer matches) and the line that is not JSON.
    expect(malformed.control_entries).toBe(2);
  });

  test("chant query joins a version to the one it replaced", async () => {
    const load = await loadQueryData([{ member: "control", port: port(FIXTURE) }]);
    const result = await runQuery("SELECT n.id, n.digest, o.digest AS replaced FROM control_entries n JOIN control_entries o ON o.digest = n.prev_digest", load);
    expect(result.rows).toEqual([{ id: "ctl-001", digest: v2.digest, replaced: v1.digest }]);
  });

  test("a ledger with no control repo entries has no rows", async () => {
    const { data } = await loadQueryData([{ member: null, port: port({ "_gates/x.jsonl": "" }) }]);
    expect(data.control_entries).toEqual([]);
  });

  test("chant ledger lists the table, with settings and estates as JSON, current as a boolean and timestamp for --since", () => {
    expect(LEDGER_TABLES).toContain("control_entries");
    expect(LEDGER_TIME_COLUMN.control_entries).toBe("timestamp");
    expect(ledgerFields("control_entries")).toMatchObject({ settings: "json", estates: "json", current: "boolean", timestamp: "time", digest: "text", prev_digest: "text" });
    expect(QUERY_TABLES.control_entries.map(([c]) => c)).toEqual(["member", "id", "entry", "project", "state", "product", "settings", "estates", "by", "timestamp", "digest", "prev_digest", "current"]);
  });

  test("the table's floor is the next release", () => {
    expect(LEDGER_CONTROL_ENTRIES_FLOOR).toBe(NEXT_RELEASE);
  });
});
