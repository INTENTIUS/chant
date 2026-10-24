import { describe, expect, it } from "vitest";
import { FilterError, matchesWhere, parseInstant, parseSince, parseWhere, type FilterFields } from "./read-filter";

const fields: FilterFields = { name: "text", count: "number", ok: "boolean", at: "time", labels: "json", "unit.id": "text" };
const now = new Date("2026-10-23T12:00:00.000Z");
const keep = (rows: { name: string }[], ...where: string[]) => rows.filter((r) => matchesWhere(r, parseWhere(where, fields, now))).map((r) => r.name);

describe("typed filters (#4363)", () => {
  const rows = [
    { name: "web", count: 3, ok: true, at: "2026-10-22T00:00:00.000Z", labels: { team: "core", size: 2 }, unit: { id: "W-1" } },
    { name: "worker", count: 10, ok: false, at: "2026-10-01T00:00:00.000Z", labels: '{"team":"edge","size":12}', unit: null },
    { name: "db", count: null, ok: true, at: null, labels: null, unit: { id: "W-2" } },
  ];

  it("filters each type with its operators, every clause holding", () => {
    expect(keep(rows, "name=web")).toEqual(["web"]);
    expect(keep(rows, "name~w")).toEqual(["web", "worker"]);
    expect(keep(rows, "count>=3", "count<10")).toEqual(["web"]);
    expect(keep(rows, "ok=false")).toEqual(["worker"]);
    expect(keep(rows, "at>7d")).toEqual(["web"]);
    expect(keep(rows, "at<2026-10-10")).toEqual(["worker"]);
    expect(keep(rows, "unit.id=W-2")).toEqual(["db"]);
  });

  it("reads a key under a json field, parsing JSON text, as the type it holds", () => {
    expect(keep(rows, "labels.team=edge")).toEqual(["worker"]);
    expect(keep(rows, "labels.size>5")).toEqual(["worker"]);
  });

  it("matches null with = and !=, and a null field only with !=", () => {
    expect(keep(rows, "count=null")).toEqual(["db"]);
    expect(keep(rows, "count!=null")).toEqual(["web", "worker"]);
    expect(keep(rows, "count!=3")).toEqual(["worker", "db"]);
    expect(keep(rows, "count<100")).toEqual(["web", "worker"]);
  });

  it("refuses a field, operator or value that doesn't fit, before reading", () => {
    expect(() => parseWhere(["nope=1"], fields)).toThrow(/no such field; this read filters on name, count/);
    expect(() => parseWhere(["count=many"], fields)).toThrow(FilterError);
    expect(() => parseWhere(["ok>true"], fields)).toThrow(/= or != only/);
    expect(() => parseWhere(["count~1"], fields)).toThrow(/takes a text field/);
    expect(() => parseWhere(["at=yesterday"], fields)).toThrow(/is a time/);
    expect(() => parseWhere(["labels=x"], fields)).toThrow(/name a key under it/);
    expect(() => parseWhere(["name>=null"], fields)).toThrow(/null takes = or != only/);
    expect(() => parseWhere(["just-a-word"], fields)).toThrow(/<field><op><value>/);
  });

  it("reads --since as an ISO time or a span back from now", () => {
    expect(parseSince("7d", now)).toBe("2026-10-16T12:00:00.000Z");
    expect(parseSince("2026-10-01", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(parseInstant("90m", now)).toBe(now.getTime() - 90 * 60_000);
    expect(() => parseSince("last week", now)).toThrow(FilterError);
  });
});
