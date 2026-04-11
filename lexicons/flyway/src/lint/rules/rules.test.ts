import { describe, test, expect } from "vitest";
import { hardcodedCredentialsRule } from "./hardcoded-credentials";
import { hardcodedUrlRule } from "./hardcoded-url";
import { missingSchemasRule } from "./missing-schemas";
import { invalidMigrationNameRule } from "./invalid-migration-name";
import { duplicateVersionRule } from "./duplicate-version";
import * as ts from "typescript";

function createContext(code: string) {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return { sourceFile } as any;
}

// ── WFW001: Hardcoded Credentials ───────────────────────────────────

describe("WFW001: Hardcoded Credentials", () => {
  test("rule metadata", () => {
    expect(hardcodedCredentialsRule.id).toBe("WFW001");
    expect(hardcodedCredentialsRule.severity).toBe("error");
    expect(hardcodedCredentialsRule.category).toBe("security");
  });

  test("flags hardcoded user and password string literals", () => {
    const ctx = createContext(
      `const cfg = { user: "admin", password: "secret" };`,
    );
    const diags = hardcodedCredentialsRule.check(ctx);
    expect(diags.length).toBe(2);
    expect(diags[0].ruleId).toBe("WFW001");
    expect(diags[0].message).toContain("admin");
    expect(diags[1].ruleId).toBe("WFW001");
    expect(diags[1].message).toContain("secret");
  });

  test("does NOT flag variable references", () => {
    const ctx = createContext(
      `const cfg = { user: someVar, password: otherVar };`,
    );
    const diags = hardcodedCredentialsRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("does NOT flag empty strings", () => {
    const ctx = createContext(
      `const cfg = { user: "", password: "" };`,
    );
    const diags = hardcodedCredentialsRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags multiple occurrences across objects", () => {
    const ctx = createContext(`
      const a = { user: "root" };
      const b = { password: "hunter2" };
      const c = { user: "admin", password: "pass123" };
    `);
    const diags = hardcodedCredentialsRule.check(ctx);
    expect(diags.length).toBe(4);
  });
});

// ── WFW002: Hardcoded URL ───────────────────────────────────────────

describe("WFW002: Hardcoded URL", () => {
  test("rule metadata", () => {
    expect(hardcodedUrlRule.id).toBe("WFW002");
    expect(hardcodedUrlRule.severity).toBe("warning");
    expect(hardcodedUrlRule.category).toBe("security");
  });

  test("flags hardcoded JDBC URL string literal", () => {
    const ctx = createContext(
      `const cfg = { url: "jdbc:postgresql://localhost:5432/db" };`,
    );
    const diags = hardcodedUrlRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WFW002");
    expect(diags[0].message).toContain("JDBC URL");
  });

  test("does NOT flag variable reference for url", () => {
    const ctx = createContext(
      `const cfg = { url: dbUrl };`,
    );
    const diags = hardcodedUrlRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("does NOT flag non-JDBC URL string", () => {
    const ctx = createContext(
      `const cfg = { url: "https://example.com" };`,
    );
    const diags = hardcodedUrlRule.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WFW003: Missing Schemas ─────────────────────────────────────────

describe("WFW003: Missing Schemas", () => {
  test("rule metadata", () => {
    expect(missingSchemasRule.id).toBe("WFW003");
    expect(missingSchemasRule.severity).toBe("warning");
    expect(missingSchemasRule.category).toBe("correctness");
  });

  test("flags new Environment({}) without schemas property", () => {
    const ctx = createContext(
      `new Environment({ url: "jdbc:postgresql://localhost/db", user: "admin" });`,
    );
    const diags = missingSchemasRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WFW003");
    expect(diags[0].message).toContain("schemas");
  });

  test("passes when schemas property is present", () => {
    const ctx = createContext(
      `new Environment({ url: "jdbc:postgresql://localhost/db", schemas: ["public"] });`,
    );
    const diags = missingSchemasRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("does NOT flag non-Environment constructors", () => {
    const ctx = createContext(
      `new SomethingElse({ url: "jdbc:postgresql://localhost/db" });`,
    );
    const diags = missingSchemasRule.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WFW004: Invalid Migration Name ──────────────────────────────────

describe("WFW004: Invalid Migration Name", () => {
  test("rule metadata", () => {
    expect(invalidMigrationNameRule.id).toBe("WFW004");
    expect(invalidMigrationNameRule.severity).toBe("warning");
    expect(invalidMigrationNameRule.category).toBe("correctness");
  });

  test("flags .sql string not matching V/R/U pattern", () => {
    const ctx = createContext(
      `const file = "create_users.sql";`,
    );
    const diags = invalidMigrationNameRule.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].ruleId).toBe("WFW004");
    expect(diags[0].message).toContain("create_users.sql");
  });

  test("passes valid versioned migration V1__Create_users.sql", () => {
    const ctx = createContext(
      `const file = "V1__Create_users.sql";`,
    );
    const diags = invalidMigrationNameRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes valid repeatable migration R__Refresh_views.sql", () => {
    const ctx = createContext(
      `const file = "R__Refresh_views.sql";`,
    );
    const diags = invalidMigrationNameRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes valid undo migration U1__Drop_users.sql", () => {
    const ctx = createContext(
      `const file = "U1__Drop_users.sql";`,
    );
    const diags = invalidMigrationNameRule.check(ctx);
    expect(diags.length).toBe(0);
  });
});

// ── WFW005: Duplicate Version ───────────────────────────────────────

describe("WFW005: Duplicate Version", () => {
  test("rule metadata", () => {
    expect(duplicateVersionRule.id).toBe("WFW005");
    expect(duplicateVersionRule.severity).toBe("error");
    expect(duplicateVersionRule.category).toBe("correctness");
  });

  test("flags duplicate V versions in array", () => {
    const ctx = createContext(
      `const migrations = ["V1__Create_users.sql", "V1__Create_orders.sql"];`,
    );
    const diags = duplicateVersionRule.check(ctx);
    expect(diags.length).toBe(2);
    expect(diags[0].ruleId).toBe("WFW005");
    expect(diags[0].message).toContain("V1");
  });

  test("passes with unique V versions", () => {
    const ctx = createContext(
      `const migrations = ["V1__Create_users.sql", "V2__Create_orders.sql"];`,
    );
    const diags = duplicateVersionRule.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("does NOT flag R (repeatable) duplicates since they have no version", () => {
    const ctx = createContext(
      `const migrations = ["R__Refresh_views.sql", "R__Refresh_indexes.sql"];`,
    );
    const diags = duplicateVersionRule.check(ctx);
    expect(diags.length).toBe(0);
  });
});
