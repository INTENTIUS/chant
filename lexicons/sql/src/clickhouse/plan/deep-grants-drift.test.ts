/**
 * ClickHouse grants in `chant lifecycle diff --live` (#4582): each grant
 * declaration is read atom by atom, so a privilege revoked by hand is
 * `absent` drift on the declaration that gives it, a privilege granted by
 * hand is pending on its grantee, and a grant whose grantee the server does
 * not have is missing in the thin diff. The server is a stub answering the
 * queries `readLiveAccess` sends with recorded `SHOW GRANTS FOR` lines; no
 * ClickHouse runs.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { diffDeepObservation } from "@intentius/chant/lifecycle/deep-observe";
import { normalizeObservation } from "@intentius/chant/observation";
import { normalizeDeepObservation } from "@intentius/chant/deep-observation";
import { grant } from "../entities";
import type { ClickHouseTarget } from "../live/bind";

/** What `SHOW GRANTS FOR` prints, by grantee; a grantee missing here does not exist. */
let held: Record<string, string[]> = {};

const target: ClickHouseTarget = { endpoint: { url: "http://stub:8123" }, source: "sql.profiles.test", defaultDatabase: "shop", access: true };

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    clickhouseQuery: async (_endpoint: unknown, sql: string) => {
      if (/FROM system\.users/.test(sql)) return Object.keys(held).filter((n) => sql.includes(`'${n}'`)).map((name) => ({ name }));
      if (/FROM system\.roles/.test(sql)) return [];
      const show = /^SHOW GRANTS FOR `(.+)`$/.exec(sql.trim());
      if (show) return (held[show[1]!] ?? []).map((line) => ({ [`GRANTS FOR ${show[1]}`]: line }));
      throw new Error(`unexpected query: ${sql}`);
    },
  };
});

vi.mock("../live/bind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live/bind")>();
  return { ...actual, bindClickHouse: async () => target };
});

vi.mock("../live/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../live/catalog")>();
  // No tables, views or databases: these tests declare grants only.
  return { ...actual, readLiveSchema: async () => [] };
});

const { observeResourcesDeep, sqlDeepNormalizationHooks } = await import("./deep");
const { describeResources } = await import("../live/describe-resources");

type Entities = Map<string, { entityType: string; props: Record<string, unknown> }>;

const entities = (all: Record<string, ReturnType<typeof grant>>): Entities =>
  new Map(Object.entries(all).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));

const declared = entities({
  readEvents: grant`GRANT SELECT ON shop.events TO app`,
  // A bare table is the profile's default database.
  readOrders: grant`GRANT SELECT ON orders TO app`,
});

async function liveDiff(all: Entities) {
  const live = await observeResourcesDeep({ environment: "test", entityNames: [...all.keys()], entities: all });
  return diffDeepObservation(all, normalizeDeepObservation(live), sqlDeepNormalizationHooks);
}

beforeEach(() => {
  held = {};
});

describe("grants in the live diff (#4582)", () => {
  test("a grant declaration's declared tree is its atoms by grantee, as it spells them", () => {
    const props = declared.get("readOrders")!.props;
    expect(sqlDeepNormalizationHooks.prepare!(props, { entityType: "ClickHouse::Grant", side: "declared" })).toEqual({ grants: { app: { "SELECT ON orders": "granted" } } });
  });

  test("a grantee holding every declared grant is unchanged, and no grant is unobserved", async () => {
    held = { app: ["GRANT SELECT ON shop.events TO app", "GRANT SELECT ON shop.orders TO app"] };
    const diff = await liveDiff(declared);
    expect(diff.drifted).toEqual([]);
    expect(diff.unobserved).toEqual([]);
    expect(diff.unchanged).toEqual(["readEvents", "readOrders"]);
    expect(diff.pending).toBeUndefined();
  });

  test("a privilege revoked by hand is absent drift on the declaration that gives it (SQLCH273)", async () => {
    held = { app: ["GRANT SELECT ON shop.events TO app"] };
    const diff = await liveDiff(declared);
    expect(diff.drifted).toEqual([{ name: "readOrders", type: "ClickHouse::Grant", changes: [{ path: "grants.app.SELECT ON orders", kind: "absent", declared: "granted" }] }]);
    expect(diff.unchanged).toEqual(["readEvents"]);
    expect(diff.pending).toBeUndefined();
  });

  test("a privilege granted by hand is pending on its grantee, the revoke an apply would send (SQLCH274)", async () => {
    held = { app: ["GRANT INSERT, SELECT ON shop.events TO app", "GRANT SELECT ON shop.orders TO app"] };
    const diff = await liveDiff(declared);
    expect(diff.drifted).toEqual([]);
    expect(diff.pending).toEqual([{ subject: "grants app", change: "REVOKE INSERT ON `shop`.`events` FROM `app`", entities: ["readEvents", "readOrders"] }]);
  });

  test("a privilege the server folds under a wider one is held", async () => {
    held = { app: ["GRANT SELECT ON shop.* TO app"] };
    const all = entities({ readShop: grant`GRANT SELECT ON shop.* TO app`, readEvents: grant`GRANT SELECT ON shop.events TO app` });
    const diff = await liveDiff(all);
    expect(diff.drifted).toEqual([]);
    expect(diff.unchanged).toEqual(["readEvents", "readShop"]);
  });

  test("a partial revoke held under a declared privilege is drift", async () => {
    held = { app: ["GRANT SELECT ON shop.events TO app", "REVOKE SELECT(email) ON shop.events FROM app", "GRANT SELECT ON shop.orders TO app"] };
    const diff = await liveDiff(declared);
    expect(diff.drifted.map((d) => [d.name, d.changes.map((c) => `${c.path} ${c.kind}`)])).toEqual([["readEvents", ["grants.app.SELECT ON shop.events absent"]]]);
  });

  test("a role revoked by hand is absent drift", async () => {
    held = { app: ["GRANT reader TO app"] };
    const all = entities({ appReads: grant`GRANT reader, writer TO app` });
    const diff = await liveDiff(all);
    expect(diff.drifted).toEqual([{ name: "appReads", type: "ClickHouse::Grant", changes: [{ path: "grants.app.ROLE writer", kind: "absent", declared: "granted" }] }]);
  });

  test("a grant whose grantee the server does not have is missing in the thin diff and not restated in the deep one", async () => {
    held = {};
    const diff = await liveDiff(declared);
    expect(diff.drifted).toEqual([]);
    expect(diff.unobserved).toEqual([]);
    const thin = normalizeObservation(await describeResources({ environment: "test", entityNames: [...declared.keys()], entities: declared }));
    expect(Object.keys(thin.resources)).toEqual([]);
    expect(Object.keys(thin.unobserved)).toEqual([]);
  });

  test("a grant whose grantees the server has is present in the thin diff", async () => {
    held = { app: ["GRANT SELECT ON shop.events TO app"] };
    const thin = normalizeObservation(await describeResources({ environment: "test", entityNames: [...declared.keys()], entities: declared }));
    expect(Object.keys(thin.resources).sort()).toEqual(["readEvents", "readOrders"]);
    expect(thin.resources.readEvents).toMatchObject({ type: "ClickHouse::Grant", physicalId: "grants app" });
  });

  test("a profile that does not manage access leaves grants filtered", async () => {
    target.access = false;
    try {
      const diff = await liveDiff(declared);
      expect(diff.unobserved.map((u) => [u.name, u.reason])).toEqual([
        ["readEvents", "filtered"],
        ["readOrders", "filtered"],
      ]);
    } finally {
      target.access = true;
    }
  });
});
