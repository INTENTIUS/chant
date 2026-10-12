/**
 * Quotas and settings profiles (#3911): the `quota` and `settingsProfile`
 * tags, each compared with what the pinned server prints for it, the
 * `ALTER` each change takes, `ON CLUSTER` per topology, and reading them
 * from a `.sql` file. `live/quota-profile.e2e.test.ts` runs them against a
 * server.
 */

import { describe, expect, test } from "vitest";
import { quota, role, settingsProfile, CLICKHOUSE_ENTITY_TYPES } from "./entities";
import { canonicalObject, objectKey } from "./plan/normalize";
import { diffSchemas } from "./plan/diff";
import { planStatements, type DeclaredObject } from "./apply/statements";
import { renderStatement } from "./topology";
import { readClickHouse } from "../files/clickhouse";
import { clickhouseTemplates } from "./import/generator";

const t = (s: string) => [s] as unknown as TemplateStringsArray;

describe("the tags", () => {
  test("a quota: its key, its intervals as written, whom it applies to", () => {
    const reader = role`CREATE ROLE reader`;
    const q = quota`CREATE QUOTA IF NOT EXISTS per_user KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 100, errors = 5, FOR RANDOMIZED INTERVAL 1 day TRACKING ONLY TO ${reader}`;
    expect(q.entityType).toBe("ClickHouse::Quota");
    expect(q.props).toMatchObject({
      name: "per_user",
      ifNotExists: true,
      keyed: "user_name",
      intervals: "FOR INTERVAL 1 hour MAX queries = 100, errors = 5, FOR RANDOMIZED INTERVAL 1 day TRACKING ONLY",
      to: "reader",
    });
    expect(q.props.ddl).toBe("CREATE QUOTA IF NOT EXISTS per_user KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 100, errors = 5, FOR RANDOMIZED INTERVAL 1 day TRACKING ONLY TO reader");
  });

  test("a settings profile, written either way, inheriting another", () => {
    const base = settingsProfile`CREATE SETTINGS PROFILE base SETTINGS max_threads = 8`;
    const p = settingsProfile`CREATE PROFILE analysts SETTINGS PROFILE ${base}, max_memory_usage = 10000000000 MIN 1000000 MAX 20000000000, readonly = 1 CONST TO ALL EXCEPT admin`;
    expect(p.entityType).toBe("ClickHouse::SettingsProfile");
    expect(p.props).toMatchObject({ name: "analysts", settings: "PROFILE base, max_memory_usage = 10000000000 MIN 1000000 MAX 20000000000, readonly = 1 CONST", to: "ALL EXCEPT admin" });
    expect(p.dependsOn).toContain(base);
  });

  test("one per template, the wrong tag, and malformed intervals are refused", () => {
    expect(() => quota(t("CREATE QUOTA a, b"))).toThrow(/one quota per template/);
    expect(() => settingsProfile(t("CREATE SETTINGS PROFILE a, b"))).toThrow(/one settings profile per template/);
    expect(() => quota(t("CREATE SETTINGS PROFILE p"))).toThrow(/holds a CREATE SETTINGS PROFILE; use the settingsProfile tag/);
    expect(() => settingsProfile(t("CREATE QUOTA q"))).toThrow(/holds a CREATE QUOTA; use the quota tag/);
    expect(() => role(t("CREATE QUOTA q"))).toThrow(/use the quota tag/);
    expect(() => quota(t("CREATE QUOTA q KEYED BY user_name NOT KEYED"))).toThrow(/both written/);
    expect(() => quota(t("CREATE QUOTA q FOR INTERVAL 1 hour MAX queries = 1 TO r FOR INTERVAL 1 day MAX queries = 2"))).toThrow(/FOR is written twice/);
    expect(() => canonicalObject("CREATE QUOTA q FOR INTERVAL 1 fortnight MAX queries = 1")).toThrow(/whole number and a unit/);
  });
});

describe("compared with what the server prints", () => {
  const same = (declared: string, shown: string) => diffSchemas([{ key: "k", canonical: canonicalObject(shown) }], [{ key: "k", canonical: canonicalObject(declared) }]).changes;

  test("a quota: units in seconds, limits sorted and lower case, numbers as the server keeps them, NO LIMITS as no interval", () => {
    expect(
      same(
        "CREATE QUOTA q KEYED BY 'user_name' FOR INTERVAL 60 MINUTE MAX QUERIES 100, errors = 5, FOR RANDOMIZED INTERVAL 1 DAY MAX execution_time = 1000.0, read_bytes = 1e9, FOR INTERVAL 1 week NO LIMITS TO r1",
        "CREATE QUOTA q KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 100, errors = 5, FOR RANDOMIZED INTERVAL 1 day MAX read_bytes = 1000000000, execution_time = 1000 TO r1",
      ),
    ).toEqual([]);
    // Three months are a quarter, as the server counts them.
    expect(same("CREATE QUOTA q FOR INTERVAL 3 month MAX queries = 1", "CREATE QUOTA q FOR INTERVAL 1 quarter MAX queries = 1")).toEqual([]);
    expect(same("CREATE QUOTA q NOT KEYED TO NONE", "CREATE QUOTA q")).toEqual([]);
    // `KEY BY` is `KEYED BY`; an IP key's prefix bits are part of the key.
    expect(same("CREATE QUOTA q KEY BY ip_address ipv6_prefix_bits 64", "CREATE QUOTA q KEYED BY ip_address IPV6_PREFIX_BITS 64")).toEqual([]);
    expect(canonicalObject("CREATE QUOTA q KEYED BY ip_address ipv4_prefix_bits 16 ipv6_prefix_bits 48").access).toEqual({ keyed: "ip_address ipv4_prefix_bits 16 ipv6_prefix_bits 48" });
    // A name may start with a digit, as the server's own tests write them.
    expect(canonicalObject("CREATE SETTINGS PROFILE 02294_profile1 SETTINGS max_execution_time = 0.5 TO default").name).toBe("02294_profile1");
    expect(canonicalObject("CREATE QUOTA `q x` KEYED BY client_key, user_name FOR INTERVAL 2 week MAX queries = 1 TO ALL").access).toEqual({
      keyed: "client_key , user_name",
      "interval.1209600": "MAX queries = 1",
      to: "ALL",
    });
  });

  test("a changed quota is SQLCH275 per field and per interval", () => {
    expect(
      same(
        "CREATE QUOTA q KEYED BY ip_address FOR INTERVAL 1 hour MAX queries = 7, FOR INTERVAL 1 day TRACKING ONLY",
        "CREATE QUOTA q KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 5, errors = 2, FOR INTERVAL 1 week MAX queries = 1 TO r",
      ).map((c) => [c.field, c.rule, c.before, c.after]),
    ).toEqual([
      ["keyed", "SQLCH275", "user_name", "ip_address"],
      ["interval.3600", "SQLCH275", "MAX errors = 2 , queries = 5", "MAX queries = 7"],
      ["interval.86400", "SQLCH275", undefined, "TRACKING ONLY"],
      ["interval.604800", "SQLCH275", "MAX queries = 1", undefined],
      ["to", "SQLCH275", "r", undefined],
    ]);
  });

  test("a settings profile: READONLY as CONST, PROFILE 'x' as INHERIT x, the name quoted or not", () => {
    expect(
      same(
        "CREATE PROFILE p2 SETTINGS PROFILE 'p1', readonly = 1, max_threads READONLY, max_memory_usage = 100 MIN 90 MAX 110 TO b, a",
        "CREATE SETTINGS PROFILE `p2` SETTINGS INHERIT `p1`, readonly = 1, max_memory_usage = 100 MIN 90 MAX 110, max_threads CONST TO a, b",
      ),
    ).toEqual([]);
    expect(same("CREATE SETTINGS PROFILE p SETTINGS max_threads = 4", "CREATE SETTINGS PROFILE `p` SETTINGS max_threads = 5 TO r").map((c) => [c.field, c.rule])).toEqual([
      ["settings", "SQLCH276"],
      ["to", "SQLCH276"],
    ]);
  });
});

describe("the statements", () => {
  const decl = (type: string, ddl: string): DeclaredObject => {
    const canonical = canonicalObject(ddl);
    return { exportName: "x", type: type as DeclaredObject["type"], key: objectKey(canonical), ddl, canonical, dependsOn: [] };
  };
  const steps = (obj: DeclaredObject, shown?: string) => {
    const live = shown === undefined ? undefined : canonicalObject(shown);
    const changes = diffSchemas(live ? [{ key: obj.key, canonical: live }] : [], [{ key: obj.key, canonical: obj.canonical }]).changes;
    const entry = planStatements({ declared: [obj], changes, current: new Map(live ? [[obj.key, live]] : []) }).objects[0]!;
    return entry.verdict === "create" || entry.verdict === "alter" ? entry.steps.map((s) => s.sql) : [entry.verdict];
  };

  test("a quota is created as declared, then changed with ALTER QUOTA, never replaced", () => {
    const q = decl(CLICKHOUSE_ENTITY_TYPES.quota, "CREATE QUOTA q KEYED BY ip_address FOR RANDOMIZED INTERVAL 1 hour MAX queries = 7, errors = 1 TO r");
    expect(q.key).toBe("quota q");
    expect(steps(q)).toEqual(["CREATE QUOTA q KEYED BY ip_address FOR RANDOMIZED INTERVAL 1 hour MAX queries = 7, errors = 1 TO r"]);
    expect(steps(q, "CREATE QUOTA q FOR INTERVAL 1 hour MAX queries = 5, FOR INTERVAL 1 day MAX queries = 100")).toEqual([
      "ALTER QUOTA `q` KEYED BY ip_address",
      "ALTER QUOTA `q` FOR RANDOMIZED INTERVAL 3600 second MAX errors = 1, queries = 7",
      "ALTER QUOTA `q` FOR INTERVAL 86400 second NO LIMITS",
      "ALTER QUOTA `q` TO r",
    ]);
    expect(steps(decl(CLICKHOUSE_ENTITY_TYPES.quota, "CREATE QUOTA q"), "CREATE QUOTA q KEYED BY user_name TO r")).toEqual(["ALTER QUOTA `q` NOT KEYED", "ALTER QUOTA `q` TO NONE"]);
  });

  test("a settings profile is changed with ALTER SETTINGS PROFILE, so what inherits it keeps it", () => {
    const p = decl(CLICKHOUSE_ENTITY_TYPES.settingsProfile, "CREATE SETTINGS PROFILE p SETTINGS max_threads = 4 TO r");
    expect(p.key).toBe("settings profile p");
    expect(steps(p, "CREATE SETTINGS PROFILE `p` SETTINGS max_threads = 8")).toEqual(["ALTER SETTINGS PROFILE `p` SETTINGS max_threads = 4", "ALTER SETTINGS PROFILE `p` TO r"]);
    expect(steps(decl(CLICKHOUSE_ENTITY_TYPES.settingsProfile, "CREATE PROFILE p"), "CREATE SETTINGS PROFILE `p` SETTINGS max_threads = 8 TO r")).toEqual([
      "ALTER SETTINGS PROFILE `p` SETTINGS NONE",
      "ALTER SETTINGS PROFILE `p` TO NONE",
    ]);
  });

  test("neither is ever dropped", () => {
    const live = [
      { key: "quota q", canonical: canonicalObject("CREATE QUOTA q") },
      { key: "settings profile p", canonical: canonicalObject("CREATE SETTINGS PROFILE p") },
    ];
    const gone = diffSchemas(live, []).changes;
    expect(planStatements({ declared: [], changes: gone, current: new Map(live.map((l) => [l.key, l.canonical])), allowDestructive: true }).drops).toEqual([]);
  });

  test("ON CLUSTER on a cluster, since neither is in a database", () => {
    const cluster = { kind: "cluster" as const, cluster: "main" };
    expect(renderStatement("CREATE QUOTA q KEYED BY user_name", cluster)).toBe("CREATE QUOTA q ON CLUSTER `main` KEYED BY user_name");
    expect(renderStatement("CREATE SETTINGS PROFILE p SETTINGS max_threads = 1", cluster)).toBe("CREATE SETTINGS PROFILE p ON CLUSTER `main` SETTINGS max_threads = 1");
    expect(renderStatement("CREATE PROFILE p", cluster)).toBe("CREATE PROFILE p ON CLUSTER `main`");
    expect(renderStatement("ALTER QUOTA `q` TO r", cluster)).toBe("ALTER QUOTA `q` ON CLUSTER `main` TO r");
    expect(renderStatement("ALTER SETTINGS PROFILE `p` SETTINGS NONE", cluster)).toBe("ALTER SETTINGS PROFILE `p` ON CLUSTER `main` SETTINGS NONE");
  });
});

describe("import", () => {
  test("a .sql file's quotas and settings profiles are read by their tags", () => {
    const problems: string[] = [];
    const objects = readClickHouse(
      "CREATE SETTINGS PROFILE `p` SETTINGS max_threads = 4;\nCREATE QUOTA q KEYED BY user_name FOR INTERVAL 1 hour MAX queries = 5 TO r;\nCREATE NAMED COLLECTION c AS password = 'x';\n",
      { origin: "access.sql" },
      problems,
    );
    expect(objects.map((o) => [o.type, o.name])).toEqual([
      ["ClickHouse::SettingsProfile", "p"],
      ["ClickHouse::Quota", "q"],
    ]);
    expect(problems).toEqual([expect.stringMatching(/NAMED COLLECTION is not declared: a named collection holds credentials/)]);
  });

  test("the generator writes them with their tags, never as a relation another object names", () => {
    const items = [
      { exportName: "q", type: CLICKHOUSE_ENTITY_TYPES.quota, name: "q", ddl: "CREATE QUOTA q TO events" },
      { exportName: "events", type: CLICKHOUSE_ENTITY_TYPES.table, database: "default", name: "events", ddl: "CREATE TABLE default.events (a UInt8) ENGINE = Log" },
    ];
    const { bodies } = clickhouseTemplates(items);
    expect(bodies.get("q")!.refs).toEqual([]);
  });
});
