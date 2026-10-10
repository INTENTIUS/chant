/**
 * Access control (#3682): the `user`, `role`, `policy` and `grant` tags,
 * each compared with what the server prints for it, grants compared per
 * grantee, the statements for each change, and `ON CLUSTER` per topology.
 * `live/access.e2e.test.ts` runs them against a server.
 */

import { describe, expect, test } from "vitest";
import { grant, policy, role, table, user, CLICKHOUSE_ENTITY_TYPES } from "./entities";
import { canonicalObject, grantsObject, objectKey } from "./plan/normalize";
import { diffSchemas } from "./plan/diff";
import { planStatements, type DeclaredObject } from "./apply/statements";
import { declaredObjects } from "./apply/apply";
import { foldAtoms, grantsByGrantee } from "./access";
import { renderStatement } from "./topology";

const t = (s: string) => [s] as unknown as TemplateStringsArray;

describe("the access tags", () => {
  test("a user, with a method that holds no secret", () => {
    const u = user(t("CREATE USER app IDENTIFIED WITH ssl_certificate CN 'app' HOST IP '10.0.0.0/8', LOCAL DEFAULT DATABASE shop SETTINGS max_threads = 4 READONLY"));
    expect(u.entityType).toBe("ClickHouse::User");
    expect(u.props).toMatchObject({ name: "app", identified: "WITH ssl_certificate CN 'app'", host: "IP '10.0.0.0/8', LOCAL", defaultDatabase: "shop", settings: "max_threads = 4 READONLY" });
  });

  test("a password is refused, written or hashed; ssh_key's public key is taken", () => {
    expect(() => user(t("CREATE USER app IDENTIFIED BY 'secret'"))).toThrow(/environment's/);
    expect(() => user(t("CREATE USER app IDENTIFIED WITH sha256_hash BY 'abc'"))).toThrow(/environment's/);
    expect(user(t("CREATE USER app IDENTIFIED WITH ssh_key BY KEY 'AAAA' TYPE 'ssh-ed25519'")).props.identified).toBe("WITH ssh_key BY KEY 'AAAA' TYPE 'ssh-ed25519'");
  });

  test("a role, a row policy and grants, with references", () => {
    const events = table`CREATE TABLE shop.events (id UInt64, tenant String) ENGINE = MergeTree ORDER BY id`;
    const reader = role`CREATE ROLE reader SETTINGS max_memory_usage = 1000000000`;
    const p = policy`CREATE ROW POLICY tenant_a ON ${events} AS RESTRICTIVE FOR SELECT USING ${events.columns.tenant} = 'a' TO ${reader}`;
    expect(p.props).toMatchObject({ name: "tenant_a", database: "shop", table: "events", as: "RESTRICTIVE", using: "tenant = 'a'", to: "reader" });
    const g = grant`GRANT SELECT(id, tenant), INSERT ON ${events} TO ${reader} WITH GRANT OPTION`;
    expect(g.props).toMatchObject({ privileges: ["SELECT(id, tenant)", "INSERT"], on: "shop.events", to: ["reader"], withGrantOption: true });
    expect(grant`GRANT ${reader} TO app WITH ADMIN OPTION`.props).toMatchObject({ roles: ["reader"], to: ["app"], withAdminOption: true });
  });

  test("a REVOKE, WITH REPLACE OPTION and the wrong tag are refused", () => {
    expect(() => grant(t("REVOKE SELECT ON shop.* FROM reader"))).toThrow(/REVOKE/);
    expect(() => grant(t("GRANT SELECT ON shop.* TO reader WITH REPLACE OPTION"))).toThrow(/REPLACE OPTION/);
    expect(() => role(t("CREATE USER app"))).toThrow(/use the user tag/);
    expect(() => policy(t("CREATE ROW POLICY p ON shop.t FOR SELECT TO r"))).toThrow(/USING/);
  });
});

describe("compared with what the server prints", () => {
  const same = (declared: string, shown: string) => diffSchemas([{ key: "k", canonical: canonicalObject(shown, "shop") }], [{ key: "k", canonical: canonicalObject(declared, "shop") }]).changes;

  test("a user: hosts sorted, READONLY as CONST, defaults left out, a password's method read without the password", () => {
    expect(
      same(
        "CREATE USER app IDENTIFIED WITH ssl_certificate CN 'app' HOST IP '10.0.0.0/8', LOCAL DEFAULT ROLE ALL DEFAULT DATABASE shop SETTINGS readonly = 1, max_threads = 4 READONLY",
        "CREATE USER app IDENTIFIED WITH ssl_certificate CN 'app' HOST LOCAL, IP '10.0.0.0/8' DEFAULT DATABASE shop SETTINGS max_threads = 4 CONST, readonly = 1",
      ),
    ).toEqual([]);
    // Declared without IDENTIFIED: the server's password is not compared.
    expect(same("CREATE USER app DEFAULT ROLE reader", "CREATE USER app IDENTIFIED WITH sha256_password DEFAULT ROLE reader")).toEqual([]);
    expect(same("CREATE USER app HOST LOCAL", "CREATE USER app IDENTIFIED WITH sha256_password").map((c) => [c.field, c.rule])).toEqual([["host", "SQLCH271"]]);
  });

  test("a role's settings and a row policy's defaults", () => {
    expect(same("CREATE ROLE r SETTINGS max_threads = 2 READONLY", "CREATE ROLE r SETTINGS max_threads = 2 CONST")).toEqual([]);
    expect(same("CREATE ROLE r", "CREATE ROLE r SETTINGS max_threads = 2").map((c) => [c.field, c.rule])).toEqual([["settings", "SQLCH270"]]);
    expect(same("CREATE ROW POLICY p ON t AS PERMISSIVE USING a > 1 TO b, a", "CREATE ROW POLICY p ON shop.t FOR SELECT USING a > 1 TO a, b")).toEqual([]);
    expect(same("CREATE ROW POLICY p ON t USING a > 2", "CREATE ROW POLICY p ON shop.t FOR SELECT USING a > 1").map((c) => [c.field, c.rule])).toEqual([["using", "SQLCH272"]]);
  });

  test("grants: what SHOW GRANTS prints, folded the server's way", () => {
    const declared = grantsObject(
      ["GRANT SELECT(a, b), INSERT ON t TO r", "GRANT SELECT ON shop.* TO r WITH GRANT OPTION", "GRANT dictget ON shop.* TO r", "GRANT viewer TO r"].join(";\n"),
      "r",
      "shop",
    );
    const shown = grantsObject(
      [
        "GRANT dictGet ON shop.* TO r",
        "GRANT SELECT ON shop.* TO r WITH GRANT OPTION",
        "GRANT INSERT ON shop.t TO r",
        "GRANT viewer TO r",
      ].join("\n"),
      "r",
      "shop",
    );
    expect(Object.keys(declared.access!)).toEqual(["DICTGET ON shop.*", "INSERT ON shop.t", "ROLE viewer", "SELECT ON shop.* WITH GRANT OPTION"]);
    expect(diffSchemas([{ key: "g", canonical: shown }], [{ key: "g", canonical: declared }]).changes).toEqual([]);
    // A grant made by hand is revoked, a declared one missing is granted.
    const live = grantsObject("GRANT INSERT ON shop.t TO r\nGRANT ALTER ON shop.t TO r\nREVOKE SELECT(b) ON shop.t FROM r", "r", "shop");
    const changes = diffSchemas([{ key: "g", canonical: live }], [{ key: "g", canonical: grantsObject("GRANT INSERT, SELECT ON shop.t TO r", "r", "shop") }]).changes;
    expect(changes.map((c) => [c.field, c.rule])).toEqual([
      ["grants.ALTER ON shop.t", "SQLCH274"],
      ["grants.REVOKE SELECT(b) ON shop.t", "SQLCH274"],
      ["grants.SELECT ON shop.t", "SQLCH273"],
    ]);
  });

  test("an atom another covers is folded away; a wider grant option is not covered", () => {
    const folded = foldAtoms([
      { privilege: "SELECT", target: "shop.t", column: "a" },
      { privilege: "SELECT", target: "shop.t" },
      { privilege: "SELECT", target: "shop.*", option: true },
      { privilege: "INSERT", target: "shop.t", option: true },
      { privilege: "INSERT", target: "shop.*" },
    ]);
    expect(folded.map((a) => `${a.privilege} ${a.target}${a.option ? " +" : ""}`)).toEqual(["SELECT shop.* +", "INSERT shop.t +", "INSERT shop.*"]);
  });
});

describe("the statements", () => {
  const build = (objects: Array<{ export: string; type: string; ddl: string; dependsOn?: string[] }>) =>
    JSON.stringify({ dialect: "clickhouse", objects: objects.map((o) => ({ dependsOn: [], ...o })) });

  test("grant declarations are compared per grantee, after every other object", () => {
    const declared = declaredObjects(
      build([
        { export: "toReader", type: "ClickHouse::Grant", ddl: "GRANT SELECT ON shop.* TO reader, auditor" },
        { export: "reader", type: "ClickHouse::Role", ddl: "CREATE ROLE reader" },
        { export: "toAuditor", type: "ClickHouse::Grant", ddl: "GRANT ALTER ON shop.t TO auditor", dependsOn: ["reader"] },
      ]),
      "shop",
    );
    expect(declared.map((o) => [o.exportName, o.key])).toEqual([
      ["reader", "role reader"],
      ["grants reader", "grants reader"],
      ["grants auditor", "grants auditor"],
    ]);
    expect(declared[2]!.dependsOn).toEqual(["reader"]);
    expect(grantsByGrantee([{ export: "x", type: "ClickHouse::Grant", ddl: "GRANT r1, r2 TO a" }])).toEqual([{ grantee: "a", exports: ["x"], ddl: "GRANT r1, r2 TO a", dependsOn: [] }]);
  });

  test("a grantee's first grants, then its revokes before its grants", () => {
    const [obj] = declaredObjects(build([{ export: "g", type: "ClickHouse::Grant", ddl: "GRANT SELECT(a), INSERT ON shop.t TO r WITH GRANT OPTION" }]), "shop") as [DeclaredObject];
    const created = planStatements({ declared: [obj], changes: diffSchemas([], [{ key: obj.key, canonical: obj.canonical }]).changes, current: new Map() });
    const c = created.objects[0]!;
    expect(c.verdict === "create" ? c.steps.map((s) => s.sql) : []).toEqual([
      "GRANT INSERT ON `shop`.`t` TO `r` WITH GRANT OPTION",
      "GRANT SELECT(`a`) ON `shop`.`t` TO `r` WITH GRANT OPTION",
    ]);
    const live = grantsObject("GRANT INSERT ON shop.t TO r WITH GRANT OPTION\nGRANT ALTER ON shop.* TO r", "r", "shop");
    const changes = diffSchemas([{ key: obj.key, canonical: live }], [{ key: obj.key, canonical: obj.canonical }]).changes;
    const altered = planStatements({ declared: [obj], changes, current: new Map([[obj.key, live]]) }).objects[0]!;
    expect(altered.verdict === "alter" ? altered.steps.map((s) => [s.rule, s.sql]) : []).toEqual([
      ["SQLCH274", "REVOKE ALTER ON `shop`.* FROM `r`"],
      ["SQLCH273", "GRANT SELECT(`a`) ON `shop`.`t` TO `r` WITH GRANT OPTION"],
    ]);
  });

  test("a user with a password is the environment's to create; once there, each changed clause is one ALTER USER", () => {
    const decl = (ddl: string): DeclaredObject => {
      const canonical = canonicalObject(ddl);
      return { exportName: "app", type: CLICKHOUSE_ENTITY_TYPES.user, key: objectKey(canonical), ddl, canonical, dependsOn: [] };
    };
    const app = decl("CREATE USER app HOST LOCAL DEFAULT ROLE reader SETTINGS max_threads = 4");
    const created = planStatements({ declared: [app], changes: diffSchemas([], [{ key: app.key, canonical: app.canonical }]).changes, current: new Map() }).objects[0]!;
    expect(created.verdict).toBe("withheld");
    expect(created.verdict === "withheld" ? created.detail : "").toMatch(/password is the environment's/);
    const cert = decl("CREATE USER app IDENTIFIED WITH ssl_certificate CN 'app'");
    const made = planStatements({ declared: [cert], changes: diffSchemas([], [{ key: cert.key, canonical: cert.canonical }]).changes, current: new Map() }).objects[0]!;
    expect(made.verdict === "create" ? made.steps.map((s) => s.sql) : []).toEqual(["CREATE USER app IDENTIFIED WITH ssl_certificate CN 'app'"]);

    const live = canonicalObject("CREATE USER app IDENTIFIED WITH sha256_password HOST ANY DEFAULT ROLE NONE SETTINGS max_threads = 8");
    const changes = diffSchemas([{ key: app.key, canonical: live }], [{ key: app.key, canonical: app.canonical }]).changes;
    const altered = planStatements({ declared: [app], changes, current: new Map([[app.key, live]]) }).objects[0]!;
    expect(altered.verdict === "alter" ? altered.steps.map((s) => s.sql) : []).toEqual([
      "ALTER USER `app` HOST LOCAL",
      "ALTER USER `app` DEFAULT ROLE reader",
      "ALTER USER `app` SETTINGS max_threads = 4",
    ]);
    // A clause left out goes back to the server's default.
    const back = diffSchemas([{ key: app.key, canonical: app.canonical }], [{ key: app.key, canonical: canonicalObject("CREATE USER app") }]).changes;
    const reset = planStatements({ declared: [decl("CREATE USER app")], changes: back, current: new Map([[app.key, app.canonical]]) }).objects[0]!;
    expect(reset.verdict === "alter" ? reset.steps.map((s) => s.sql) : []).toEqual(["ALTER USER `app` HOST ANY", "ALTER USER `app` DEFAULT ROLE ALL", "ALTER USER `app` SETTINGS NONE"]);
  });

  test("a row policy is replaced whole; nothing of access control is ever dropped", () => {
    const ddl = "CREATE ROW POLICY p ON shop.t USING a > 2 TO r";
    const canonical = canonicalObject(ddl);
    const obj: DeclaredObject = { exportName: "p", type: CLICKHOUSE_ENTITY_TYPES.rowPolicy, key: objectKey(canonical), ddl, canonical, dependsOn: [] };
    expect(obj.key).toBe("row policy p ON shop.t");
    const live = canonicalObject("CREATE ROW POLICY p ON shop.t FOR SELECT USING a > 1 TO r");
    const changes = diffSchemas([{ key: obj.key, canonical: live }], [{ key: obj.key, canonical }]).changes;
    const entry = planStatements({ declared: [obj], changes, current: new Map([[obj.key, live]]) }).objects[0]!;
    expect(entry.verdict === "alter" ? entry.steps.map((s) => s.sql) : []).toEqual(["CREATE ROW POLICY OR REPLACE p ON shop.t USING a > 2 TO r"]);
    const gone = diffSchemas([{ key: obj.key, canonical: live }, { key: "role r", canonical: canonicalObject("CREATE ROLE r") }], []).changes;
    expect(planStatements({ declared: [], changes: gone, current: new Map([[obj.key, live], ["role r", canonicalObject("CREATE ROLE r")]]), allowDestructive: true }).drops).toEqual([]);
  });

  test("ON CLUSTER on a cluster, and in the replicated topology its cluster, since none of these is in a database", () => {
    const cluster = { kind: "cluster" as const, cluster: "main" };
    expect(renderStatement("CREATE USER app IDENTIFIED WITH ssl_certificate CN 'app'", cluster)).toBe("CREATE USER app ON CLUSTER `main` IDENTIFIED WITH ssl_certificate CN 'app'");
    expect(renderStatement("CREATE ROLE reader", cluster)).toBe("CREATE ROLE reader ON CLUSTER `main`");
    expect(renderStatement("CREATE ROW POLICY p ON shop.t USING 1", cluster)).toBe("CREATE ROW POLICY p ON CLUSTER `main` ON shop.t USING 1");
    expect(renderStatement("CREATE ROW POLICY OR REPLACE p ON shop.t USING 1", { kind: "replicated", cluster: "main" })).toBe("CREATE ROW POLICY OR REPLACE p ON CLUSTER `main` ON shop.t USING 1");
    expect(renderStatement("GRANT SELECT ON `shop`.* TO `r`", cluster)).toBe("GRANT ON CLUSTER `main` SELECT ON `shop`.* TO `r`");
    expect(renderStatement("REVOKE ALTER ON `shop`.* FROM `r`", cluster)).toBe("REVOKE ON CLUSTER `main` ALTER ON `shop`.* FROM `r`");
    expect(renderStatement("ALTER USER `app` HOST LOCAL", cluster)).toBe("ALTER USER `app` ON CLUSTER `main` HOST LOCAL");
    expect(renderStatement("ALTER ROLE `r` SETTINGS NONE", { kind: "replicated" })).toBe("ALTER ROLE `r` SETTINGS NONE");
    expect(renderStatement("GRANT SELECT ON `shop`.* TO `r`", { kind: "single" })).toBe("GRANT SELECT ON `shop`.* TO `r`");
  });
});
