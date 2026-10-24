import { describe, expect, it } from "vitest";
import { parseArgs } from "../cli/main";
import { matchesWhere, parseWhere } from "../read-filter";
import { filterRecordsDocument, RECORD_FILTER_FIELDS, type RecordsDocument } from "./records-cli";
import { RUN_FILTER_FIELDS, RunsFilterError, workspaceRuns } from "./runs-cli";

describe("--where on records and runs (#4363)", () => {
  it("parses --where as a repeatable flag", () => {
    expect(parseArgs(["ledger", "gates", "--where", "op=tf-apply", "--where", "kind=pending"]).where).toEqual(["op=tf-apply", "kind=pending"]);
    expect(() => parseArgs(["ledger", "gates", "--where"])).toThrow(/--where needs a clause/);
  });

  it("filters the records a read lists and counts summary over them", () => {
    const rec = (id: string, state: string, valid: boolean, data: Record<string, unknown>) => ({ id, path: `d/${id}.md`, state, valid, data, supersededBy: null, provenance: { level: "unattested" } });
    const doc = {
      $schema: "x",
      contract: 1,
      records: [rec("D-1", "accepted", true, { owner: "ops" }), rec("D-2", "proposed", true, { owner: "dev" }), rec("D-3", "accepted", false, { owner: "dev" })],
      summary: { total: 3, valid: 2, invalid: 1, superseded: 4 },
    } as unknown as RecordsDocument;
    const where = ["state=accepted", "data.owner=dev"];
    const out = filterRecordsDocument(doc, parseWhere(where, RECORD_FILTER_FIELDS), where);
    if ("error" in out) throw new Error("failed");
    expect(out.records.map((r) => r.id)).toEqual(["D-3"]);
    expect(out.summary).toEqual({ total: 1, valid: 0, invalid: 1, superseded: 4 });
    expect(out.where).toEqual(where);
    expect(filterRecordsDocument(doc, [], [])).toBe(doc);
  });

  it("filters runs on their typed fields", () => {
    const run = { id: "r1", state: "ended", startedAt: "2026-10-22T00:00:00.000Z", model: "opus", unit: { id: "W-1", kind: "work" }, cost: { amount: 1.5, currency: "USD" } };
    expect(matchesWhere(run, parseWhere(["cost.amount>1", "unit.id=W-1", "startedAt>=2026-10-21"], RUN_FILTER_FIELDS))).toBe(true);
    expect(matchesWhere(run, parseWhere(["model!=opus"], RUN_FILTER_FIELDS))).toBe(false);
  });

  it("refuses a runs --where it can't apply before reading anything", async () => {
    await expect(workspaceRuns({ cwd: "/nonexistent", where: ["tokens>5"] })).rejects.toThrow(RunsFilterError);
  });
});
