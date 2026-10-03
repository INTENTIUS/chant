import { describe, expect, test } from "vitest";
import {
  POSTGRES_PROVIDERS,
  isProviderOwned,
  providerAllowsExtension,
  providerData,
  refusedStatement,
  normalizeStatement,
  type PostgresProvider,
} from "./index";

describe("every provider's data", () => {
  test.each(POSTGRES_PROVIDERS)("%s cites a page and the date it was read, and its lists are lower case and unique", (p) => {
    const d = providerData(p);
    expect(d.provider).toBe(p);
    expect(d.sources.length).toBeGreaterThan(0);
    for (const s of d.sources) {
      expect(s.url).toMatch(/^https:\/\//);
      expect(s.readOn).toMatch(/^2026-10-03$/);
    }
    for (const list of [d.reservedRoles, d.reservedSchemas, d.allowedExtensions, d.providerExtensions]) {
      expect(list.every((n) => n === n.toLowerCase())).toBe(true);
      expect(new Set(list).size).toBe(list.length);
    }
    expect(d.allowedExtensions.length).toBeGreaterThan(10);
    for (const t of d.toCheck) expect(t.length).toBeGreaterThan(0);
  });

  test("every provider refuses what needs a superuser", () => {
    for (const p of POSTGRES_PROVIDERS) {
      expect(refusedStatement(p, "CREATE ROLE admin SUPERUSER")?.id).toBe("superuser-role");
      expect(refusedStatement(p, "copy t from program 'curl x'")?.id).toBe("copy-program");
      expect(refusedStatement(p, "CREATE TABLE t (a int)")).toBeUndefined();
    }
  });
});

interface Fixture {
  provider: PostgresProvider;
  allowed: string[];
  refused: string[];
  ownedRole: string;
  ownedExtension: string;
  ownedSchema?: string;
  refusedStatement?: [string, string];
}

const FIXTURES: Fixture[] = [
  {
    provider: "rds",
    allowed: ["pg_stat_statements", "pgcrypto", "vector", "postgis", "aws_s3"],
    refused: ["pg_squeeze", "pg_ivm", "timescaledb"],
    ownedRole: "rds_superuser",
    ownedExtension: "aws_s3",
    refusedStatement: ["CREATE TABLESPACE fast LOCATION '/ssd'", "create-tablespace-location"],
  },
  {
    provider: "aurora",
    allowed: ["pg_stat_statements", "apg_plan_mgmt", "aws_ml", "vector", "pgaudit"],
    refused: ["pg_squeeze", "timescaledb"],
    ownedRole: "rdsadmin",
    ownedExtension: "apg_plan_mgmt",
  },
  {
    provider: "cloud-sql",
    allowed: ["pg_trgm", "vector", "uuid-ossp", "pgaudit", "postgis"],
    refused: ["aws_s3", "timescaledb"],
    ownedRole: "cloudsqlsuperuser",
    ownedExtension: "google_ml_integration",
  },
  {
    provider: "azure",
    allowed: ["pg_trgm", "vector", "azure_ai", "timescaledb", "uuid-ossp"],
    refused: ["aws_s3", "pg_stat_monitor"],
    ownedRole: "azure_pg_admin",
    ownedExtension: "azure_storage",
    refusedStatement: ["GRANT dba TO azure_pg_admin", "grant-to-azure-pg-admin"],
  },
  {
    provider: "neon",
    allowed: ["pg_trgm", "vector", "neon", "pg_graphql", "timescaledb"],
    refused: ["pg_squeeze", "plv8", "wal2json"],
    ownedRole: "neon_superuser",
    ownedExtension: "neon_utils",
    refusedStatement: ["create tablespace t location '/x'", "create-tablespace"],
  },
  {
    provider: "supabase",
    allowed: ["pg_graphql", "vector", "pgtap", "uuid-ossp"],
    refused: [],
    ownedRole: "supabase_admin",
    ownedExtension: "pg_net",
    ownedSchema: "auth",
  },
];

describe.each(FIXTURES)("$provider", (f) => {
  test("allows the extensions its page lists", () => {
    for (const e of f.allowed) expect(providerAllowsExtension(f.provider, e), e).toBe(true);
  });

  test("an extension its page does not list is refused, or unknown when the list is partial", () => {
    for (const e of f.refused) expect(providerAllowsExtension(f.provider, e), e).toBe(false);
    const partial = !providerData(f.provider).extensionListComplete;
    expect(providerAllowsExtension(f.provider, "not_an_extension")).toBe(partial ? undefined : false);
  });

  test("reads its own roles, schemas and extensions as provider-owned, and a customer's as not", () => {
    expect(isProviderOwned(f.provider, { kind: "role", name: f.ownedRole })).toBe(true);
    expect(isProviderOwned(f.provider, { kind: "role", name: f.ownedRole.toUpperCase() })).toBe(true);
    expect(isProviderOwned(f.provider, { kind: "role", name: "pg_monitor" })).toBe(true);
    expect(isProviderOwned(f.provider, { kind: "role", name: "app_owner" })).toBe(false);
    expect(isProviderOwned(f.provider, { kind: "extension", name: f.ownedExtension })).toBe(true);
    expect(isProviderOwned(f.provider, { kind: "extension", name: "pgcrypto" })).toBe(false);
    expect(isProviderOwned(f.provider, { kind: "schema", name: "app" })).toBe(false);
    if (f.ownedSchema) expect(isProviderOwned(f.provider, { kind: "schema", name: f.ownedSchema })).toBe(true);
  });

  if (f.refusedStatement) {
    test("refuses its own statements", () => {
      expect(refusedStatement(f.provider, f.refusedStatement![0])?.id).toBe(f.refusedStatement![1]);
    });
  }
});

describe("normalizeStatement", () => {
  test("drops comments and string contents, collapses whitespace and upper-cases", () => {
    expect(normalizeStatement("/* x */ alter   system -- c\n set a = 'ALTER SYSTEM'")).toBe("ALTER SYSTEM SET A = ''");
  });
  test("a string that names a refused statement does not match", () => {
    expect(refusedStatement("rds", "COMMENT ON TABLE t IS 'ALTER SYSTEM is refused'")).toBeUndefined();
  });
  test("ALTER SYSTEM is refused", () => {
    expect(refusedStatement("neon", "ALTER SYSTEM SET work_mem = '1GB'")?.id).toBe("alter-system");
  });
});
