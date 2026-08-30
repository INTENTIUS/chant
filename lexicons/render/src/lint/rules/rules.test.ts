import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { validRegionRule } from "./valid-region";
import { noSecretLiteralsRule } from "./no-secret-literals";
import { validCronScheduleRule, isValidCronSchedule } from "./valid-cron-schedule";
import type { LintContext } from "@intentius/chant/lint/rule";

function createContext(code: string, fileName = "infra.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("Render lint rules", () => {
  describe("REN001: valid region", () => {
    test("flags an unknown region", () => {
      const diags = validRegionRule.check(createContext(`new WebServiceDetails({ runtime: "node", region: "narnia" });`));
      expect(diags).toHaveLength(1);
      expect(diags[0].ruleId).toBe("REN001");
      expect(diags[0].severity).toBe("error");
      expect(diags[0].message).toContain("narnia");
    });

    test("passes every known region", () => {
      for (const r of ["frankfurt", "oregon", "ohio", "singapore", "virginia"]) {
        expect(validRegionRule.check(createContext(`new Postgres({ name: "db", region: "${r}" });`))).toHaveLength(0);
      }
    });

    test("ignores a non-literal region", () => {
      expect(validRegionRule.check(createContext(`new KeyValue({ region: Render.Region });`))).toHaveLength(0);
    });
  });

  describe("REN002: no secret literals", () => {
    test("flags a literal value under a secret-looking key", () => {
      const diags = noSecretLiteralsRule.check(createContext(`envVars: [{ key: "DATABASE_PASSWORD", value: "hunter22" }]`));
      expect(diags).toHaveLength(1);
      expect(diags[0].ruleId).toBe("REN002");
      expect(diags[0].severity).toBe("warning");
      expect(diags[0].message).toContain("DATABASE_PASSWORD");
    });

    test("passes generateValue, references, placeholders, and non-secret keys", () => {
      expect(noSecretLiteralsRule.check(createContext(`[{ key: "API_KEY", generateValue: true }]`))).toHaveLength(0);
      expect(noSecretLiteralsRule.check(createContext(`[{ key: "API_KEY", value: db.internalConnectionString }]`))).toHaveLength(0);
      expect(noSecretLiteralsRule.check(createContext(`[{ key: "API_KEY", value: process.env.API_KEY! }]`))).toHaveLength(0);
      expect(noSecretLiteralsRule.check(createContext(`[{ key: "API_KEY", value: "$API_KEY" }]`))).toHaveLength(0);
      expect(noSecretLiteralsRule.check(createContext(`[{ key: "LOG_LEVEL", value: "debug" }]`))).toHaveLength(0);
    });
  });

  describe("REN003: valid cron schedule", () => {
    test("isValidCronSchedule accepts standard five-field expressions", () => {
      for (const ok of ["0 * * * *", "*/15 * * * *", "0 0 1 * *", "30 2 * * 1-5", "0,30 * * * *", "0 9-17/2 * * 1,3,5"]) {
        expect(isValidCronSchedule(ok), ok).toBe(true);
      }
      for (const bad of ["@hourly", "* * * * * *", "0 * * *", "every hour", ""]) {
        expect(isValidCronSchedule(bad), bad).toBe(false);
      }
    });

    test("flags an invalid schedule literal", () => {
      const diags = validCronScheduleRule.check(createContext(`new CronJobDetails({ runtime: "docker", schedule: "@hourly" });`));
      expect(diags).toHaveLength(1);
      expect(diags[0].ruleId).toBe("REN003");
      expect(diags[0].message).toContain("@hourly");
    });

    test("passes a valid schedule", () => {
      expect(validCronScheduleRule.check(createContext(`new CronJobDetails({ runtime: "docker", schedule: "0 * * * *" });`))).toHaveLength(0);
    });
  });
});
