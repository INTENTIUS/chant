/**
 * The Plan phase's read of the subscriptions a table is the target of
 * (#4405), and its refusal. The e2e is `subscriber.e2e.test.ts`.
 */

import { describe, expect, test } from "vitest";
import type { PostgresClient } from "../live/client";
import { subscriptionRefusal, subscriptionsOf } from "./replication";

function fake(rows: unknown[]) {
  const calls: { sql: string; params?: readonly unknown[] }[] = [];
  const client = {
    query: async (sql: string, params?: readonly unknown[]) => {
      calls.push({ sql, params });
      return rows;
    },
  } as unknown as Pick<PostgresClient, "query">;
  return { client, calls };
}

describe("subscriptionsOf", () => {
  test("reads pg_subscription_rel and pg_subscription for this database, by schema and table", async () => {
    const { client, calls } = fake([{ subname: "sub_a", subenabled: true }, { subname: "sub_b", subenabled: false }]);
    expect(await subscriptionsOf(client, "app", "users", 18)).toEqual([{ name: "sub_a", enabled: true }, { name: "sub_b", enabled: false }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual(["app", "users"]);
    expect(calls[0]!.sql).toContain("pg_catalog.pg_subscription_rel");
    expect(calls[0]!.sql).toContain("pg_catalog.pg_subscription s");
    expect(calls[0]!.sql).toContain("s.subdbid");
  });

  test("a partitioned table is matched through its partitions; before 12 the table alone", async () => {
    const now = fake([]);
    await subscriptionsOf(now.client, "app", "events", 18);
    expect(now.calls[0]!.sql).toContain("pg_partition_tree");
    const old = fake([]);
    await subscriptionsOf(old.client, "app", "events", 11);
    expect(old.calls[0]!.sql).not.toContain("pg_partition_tree");
  });

  test("no row means no subscription", async () => {
    expect(await subscriptionsOf(fake([]).client, "app", "users", 18)).toEqual([]);
  });
});

describe("subscriptionRefusal", () => {
  const message = subscriptionRefusal("app.users", "login", [{ name: "sub_a", enabled: true }, { name: "sub_b", enabled: false }]);

  test("names each subscription, and a disabled one as such", () => {
    expect(message).toContain("sub_a, sub_b (disabled)");
    expect(message.startsWith("app.users is a target")).toBe(true);
  });

  test("gives the reason and the way out", () => {
    expect(message).toContain("session_replication_role = replica");
    expect(message).toContain("ENABLE ALWAYS");
    expect(message).toContain("REFRESH PUBLICATION");
  });
});
