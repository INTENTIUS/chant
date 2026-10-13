/**
 * The grants the deep read reports as pending (#3733): what an apply would
 * grant or revoke from each declared grantee, so a privilege granted by hand
 * after an approval moves the plan digest. The server is a stub answering the
 * queries `readLiveAccess` sends.
 */

import { describe, expect, test, vi } from "vitest";
import { grant } from "../entities";
import type { ClickHouseTarget } from "../live/bind";

/** What `SHOW GRANTS FOR` prints, by grantee; a grantee missing here does not exist. */
let held: Record<string, string[]> = {};

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

const { pendingGrants } = await import("./deep");

const target: ClickHouseTarget = { endpoint: { url: "http://stub:8123" }, source: "sql.profiles.test", defaultDatabase: "default", access: true };

const entities = (all: Record<string, ReturnType<typeof grant>>) =>
  new Map(Object.entries(all).map(([k, e]) => [k, { entityType: e.entityType, props: e.props as unknown as Record<string, unknown> }]));

const declared = entities({
  readEvents: grant`GRANT SELECT ON shop.events TO app`,
  readOrders: grant`GRANT SELECT ON shop.orders TO app`,
});

describe("pendingGrants (#3733)", () => {
  test("a grantee holding what is declared has nothing pending", async () => {
    held = { app: ["GRANT SELECT ON shop.events TO app", "GRANT SELECT ON shop.orders TO app"] };
    expect(await pendingGrants(target, declared)).toEqual([]);
  });

  test("a privilege granted by hand is a REVOKE, one revoked by hand a GRANT, revokes first", async () => {
    held = { app: ["GRANT INSERT, SELECT ON shop.events TO app"] };
    expect(await pendingGrants(target, declared)).toEqual([
      {
        subject: "grants app",
        change: "REVOKE INSERT ON `shop`.`events` FROM `app`; GRANT SELECT ON `shop`.`orders` TO `app`",
        entities: ["readEvents", "readOrders"],
      },
    ]);
  });

  test("a grantee the server does not hold yet is given every declared grant", async () => {
    held = {};
    expect((await pendingGrants(target, declared)).map((p) => p.change)).toEqual(["GRANT SELECT ON `shop`.`events` TO `app`; GRANT SELECT ON `shop`.`orders` TO `app`"]);
  });

  test("no grant declarations read nothing", async () => {
    held = {};
    expect(await pendingGrants(target, new Map())).toEqual([]);
  });
});
