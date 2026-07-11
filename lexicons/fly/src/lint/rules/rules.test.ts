import { describe, test, expect } from "vitest";
import * as ts from "typescript";
import { validRegionRule } from "./valid-region";
import { guestSizingRule } from "./guest-sizing";
import { noSecretLiteralsRule } from "./no-secret-literals";
import type { LintContext } from "@intentius/chant/lint/rule";

function createContext(code: string, fileName = "infra.ts"): LintContext {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  return { sourceFile, entities: [], filePath: fileName };
}

describe("Fly lint rules", () => {
  describe("FLY001: valid region", () => {
    test("flags an unknown region", () => {
      const ctx = createContext(`new Machine({ region: "narnia", config: new MachineConfig({ image: "nginx" }) });`);
      const diags = validRegionRule.check(ctx);
      expect(diags).toHaveLength(1);
      expect(diags[0].ruleId).toBe("FLY001");
      expect(diags[0].severity).toBe("error");
      expect(diags[0].message).toContain("narnia");
    });

    test("passes a known region", () => {
      const ctx = createContext(`new Machine({ region: "iad", config: new MachineConfig({ image: "nginx" }) });`);
      expect(validRegionRule.check(ctx)).toHaveLength(0);
    });

    test("passes a known region on a Volume", () => {
      const ctx = createContext(`new Volume({ name: "data", region: "lhr", size_gb: 10 });`);
      expect(validRegionRule.check(ctx)).toHaveLength(0);
    });

    test("ignores a non-literal region (reference/expression)", () => {
      const ctx = createContext(`new Machine({ region: Fly.Region });`);
      expect(validRegionRule.check(ctx)).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(validRegionRule.id).toBe("FLY001");
      expect(validRegionRule.severity).toBe("error");
      expect(validRegionRule.category).toBe("correctness");
    });
  });

  describe("FLY002: sane guest sizing", () => {
    test("passes a valid shared combo", () => {
      const ctx = createContext(`new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 });`);
      expect(guestSizingRule.check(ctx)).toHaveLength(0);
    });

    test("passes a valid performance combo", () => {
      const ctx = createContext(`new MachineGuest({ cpu_kind: "performance", cpus: 2, memory_mb: 4096 });`);
      expect(guestSizingRule.check(ctx)).toHaveLength(0);
    });

    test("flags an invalid cpu_kind", () => {
      const ctx = createContext(`new MachineGuest({ cpu_kind: "turbo", cpus: 1, memory_mb: 256 });`);
      const diags = guestSizingRule.check(ctx);
      expect(diags).toHaveLength(1);
      expect(diags[0].ruleId).toBe("FLY002");
      expect(diags[0].message).toContain("turbo");
    });

    test("flags an invalid cpu count for the kind", () => {
      const ctx = createContext(`new MachineGuest({ cpu_kind: "shared", cpus: 3, memory_mb: 512 });`);
      const diags = guestSizingRule.check(ctx);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain("3 cpus");
    });

    test("flags a memory value out of range for the cpu count", () => {
      const ctx = createContext(`new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 8192 });`);
      const diags = guestSizingRule.check(ctx);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain("memory_mb");
    });

    test("flags a memory value that is not a 256 MB multiple", () => {
      const ctx = createContext(`new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 300 });`);
      expect(guestSizingRule.check(ctx)).toHaveLength(1);
    });

    test("has correct metadata", () => {
      expect(guestSizingRule.id).toBe("FLY002");
      expect(guestSizingRule.severity).toBe("error");
      expect(guestSizingRule.category).toBe("correctness");
    });
  });

  describe("FLY004: no secret literals", () => {
    test("flags an inline secret literal under a credential key", () => {
      const ctx = createContext(`new MachineConfig({ image: "nginx", env: { DB_PASSWORD: "s3cr3t-p@ss" } });`);
      const diags = noSecretLiteralsRule.check(ctx);
      expect(diags).toHaveLength(1);
      expect(diags[0].ruleId).toBe("FLY004");
      expect(diags[0].severity).toBe("warning");
      expect(diags[0].message).toContain("DB_PASSWORD");
    });

    test("flags an inline api key", () => {
      const ctx = createContext(`new MachineConfig({ env: { STRIPE_API_KEY: "sk_live_abcdef123456" } });`);
      expect(noSecretLiteralsRule.check(ctx)).toHaveLength(1);
    });

    test("does not flag a reference to a secret", () => {
      const ctx = createContext(`new MachineConfig({ env: { DB_PASSWORD: dbSecret } });`);
      expect(noSecretLiteralsRule.check(ctx)).toHaveLength(0);
    });

    test("does not flag an interpolation/placeholder value", () => {
      const ctx = createContext(`new MachineConfig({ env: { DB_PASSWORD: "$DB_PASSWORD" } });`);
      expect(noSecretLiteralsRule.check(ctx)).toHaveLength(0);
    });

    test("does not flag non-credential keys", () => {
      const ctx = createContext(`new MachineConfig({ env: { LOG_LEVEL: "info" } });`);
      expect(noSecretLiteralsRule.check(ctx)).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(noSecretLiteralsRule.id).toBe("FLY004");
      expect(noSecretLiteralsRule.severity).toBe("warning");
      expect(noSecretLiteralsRule.category).toBe("security");
    });
  });
});
