/**
 * A ClickHouse table's columns in `chant lifecycle diff --live` (#4944): a
 * column's drift is addressed by its name, a column the server has and the
 * declaration does not is pending (an apply drops it), and a column moved on
 * the server is drift on `columnOrder`. The server is a stub answering
 * `readLiveSchema` with a recorded `SHOW CREATE`; no ClickHouse runs.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { diffDeepObservation } from "@intentius/chant/lifecycle/deep-observe";
import { normalizeDeepObservation } from "@intentius/chant/deep-observation";
import { table } from "../entities";
import type { ClickHouseTarget } from "../live/bind";
import type { LiveObject } from "../live/catalog";

/** The server's `SHOW CREATE` for shop.events. */
let shown = "";

const target: ClickHouseTarget = { endpoint: { url: "http://stub:8123" }, source: "sql.profiles.test", defaultDatabase: "shop" };

vi.mock("../live/bind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live/bind")>();
  return { ...actual, bindClickHouse: async () => target };
});

vi.mock("../live/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live/catalog")>();
  return {
    ...actual,
    readLiveSchema: async (): Promise<LiveObject[]> => [{ type: "ClickHouse::Table", database: "shop", name: "events", engine: "MergeTree", statement: shown }],
  };
});

const { observeResourcesDeep, sqlDeepNormalizationHooks } = await import("./deep");

const events = table`CREATE TABLE shop.events (id UInt64, country String DEFAULT 'US', ts DateTime) ENGINE = MergeTree ORDER BY id`;
const declared = new Map([["events", { entityType: events.entityType, props: events.props as unknown as Record<string, unknown> }]]);

const show = (columns: string[]) =>
  `CREATE TABLE shop.events\n(\n${columns.map((c) => `    ${c}`).join(",\n")}\n)\nENGINE = MergeTree\nORDER BY id\nSETTINGS index_granularity = 8192`;

async function liveDiff() {
  const live = await observeResourcesDeep({ environment: "test", entityNames: ["events"], entities: declared });
  return diffDeepObservation(declared, normalizeDeepObservation(live), sqlDeepNormalizationHooks);
}

beforeEach(() => {
  shown = show(["`id` UInt64", "`country` String DEFAULT 'US'", "`ts` DateTime"]);
});

describe("a ClickHouse table's columns in the live diff (#4944)", () => {
  test("a table the server holds as declared is unchanged", async () => {
    const diff = await liveDiff();
    expect(diff.drifted).toEqual([]);
    expect(diff.unclaimed).toEqual([]);
    expect(diff.unchanged).toEqual(["events"]);
    expect(diff.pending).toBeUndefined();
  });

  test("a column's drift is addressed by the column's name", async () => {
    shown = show(["`id` UInt64", "`country` String DEFAULT 'GB'", "`ts` DateTime"]);
    const diff = await liveDiff();
    expect(diff.drifted).toEqual([{ name: "events", type: "ClickHouse::Table", changes: [{ path: "columns[#country].default.expr", kind: "changed", declared: "'US'", live: "'GB'" }] }]);
  });

  test("a column the server has and the declaration does not is pending, and not unclaimed", async () => {
    shown = show(["`id` UInt64", "`note` String", "`country` String DEFAULT 'US'", "`ts` DateTime"]);
    const diff = await liveDiff();
    expect(diff.pending).toEqual([{ subject: "column shop.events.note", change: "the server has column note String, which the declaration does not", entities: ["events"] }]);
    expect(diff.drifted).toEqual([]);
    expect(diff.unclaimed).toEqual([]);
  });

  test("a declared column the server does not have is absent drift by its name", async () => {
    shown = show(["`id` UInt64", "`ts` DateTime"]);
    const diff = await liveDiff();
    expect(diff.drifted[0]!.changes.map((c) => `${c.path} ${c.kind}`)).toEqual(["columns[#country].name absent", "columns[#country].type absent", "columns[#country].default.kind absent", "columns[#country].default.expr absent"].sort());
  });

  test("a column moved on the server is drift on columnOrder", async () => {
    shown = show(["`id` UInt64", "`ts` DateTime", "`country` String DEFAULT 'US'"]);
    const diff = await liveDiff();
    expect(diff.drifted).toEqual([{ name: "events", type: "ClickHouse::Table", changes: [{ path: "columnOrder", kind: "changed", declared: "id, country, ts", live: "id, ts, country" }] }]);
  });
});
