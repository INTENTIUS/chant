import { describe, test, expect } from "bun:test";
import * as ts from "typescript";
import { hardcodedLocationRule } from "./hardcoded-location";
import { storageHttpsRule } from "./storage-https";
import { nsgWildcardRule } from "./nsg-wildcard";
import type { LintContext } from "@intentius/chant/lint/rule";

function createContext(code: string, fileName = "test.ts"): LintContext {
  const sourceFile = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
  );
  return {
    sourceFile,
    entities: [],
    filePath: fileName,
  };
}

describe("Azure Lint Rules", () => {
  describe("AZR001: Hardcoded Location", () => {
    test("detects hardcoded eastus", () => {
      const context = createContext(`const location = "eastus";`);
      const diagnostics = hardcodedLocationRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("AZR001");
      expect(diagnostics[0].message).toContain("eastus");
    });

    test("detects hardcoded westus2", () => {
      const context = createContext(`const location = "westus2";`);
      const diagnostics = hardcodedLocationRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain("westus2");
    });

    test("detects hardcoded northeurope", () => {
      const context = createContext(`const location = "northeurope";`);
      const diagnostics = hardcodedLocationRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toContain("northeurope");
    });

    test("is case-insensitive", () => {
      const context = createContext(`const location = "EastUS";`);
      const diagnostics = hardcodedLocationRule.check(context);
      expect(diagnostics).toHaveLength(1);
    });

    test("ignores non-location strings", () => {
      const context = createContext(`const name = "my-storage-account";`);
      const diagnostics = hardcodedLocationRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("ignores Azure.ResourceGroupLocation reference", () => {
      const context = createContext(`const location = Azure.ResourceGroupLocation;`);
      const diagnostics = hardcodedLocationRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(hardcodedLocationRule.id).toBe("AZR001");
      expect(hardcodedLocationRule.severity).toBe("warning");
      expect(hardcodedLocationRule.category).toBe("correctness");
    });
  });

  describe("AZR002: Storage HTTPS Only", () => {
    test("warns on StorageAccount without supportsHttpsTrafficOnly", () => {
      const context = createContext(`
        const storage = new StorageAccount({ name: "teststorage" });
      `);
      const diagnostics = storageHttpsRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("AZR002");
      expect(diagnostics[0].message).toContain("supportsHttpsTrafficOnly");
    });

    test("passes with supportsHttpsTrafficOnly: true", () => {
      const context = createContext(`
        const storage = new StorageAccount({
          name: "teststorage",
          supportsHttpsTrafficOnly: true,
        });
      `);
      const diagnostics = storageHttpsRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("warns when supportsHttpsTrafficOnly is false", () => {
      const context = createContext(`
        const storage = new StorageAccount({
          name: "teststorage",
          supportsHttpsTrafficOnly: false,
        });
      `);
      const diagnostics = storageHttpsRule.check(context);
      expect(diagnostics).toHaveLength(1);
    });

    test("ignores non-StorageAccount constructors", () => {
      const context = createContext(`
        const vm = new VirtualMachine({ name: "testvm" });
      `);
      const diagnostics = storageHttpsRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(storageHttpsRule.id).toBe("AZR002");
      expect(storageHttpsRule.severity).toBe("warning");
      expect(storageHttpsRule.category).toBe("security");
    });
  });

  describe("AZR003: NSG Wildcard Source", () => {
    test("warns on sourceAddressPrefix: '*'", () => {
      const context = createContext(`
        const rule = {
          sourceAddressPrefix: "*",
          destinationPortRange: "22",
        };
      `);
      const diagnostics = nsgWildcardRule.check(context);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].ruleId).toBe("AZR003");
      expect(diagnostics[0].message).toContain("wildcard");
    });

    test("passes with specific IP range", () => {
      const context = createContext(`
        const rule = {
          sourceAddressPrefix: "10.0.0.0/24",
          destinationPortRange: "22",
        };
      `);
      const diagnostics = nsgWildcardRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("passes with service tag", () => {
      const context = createContext(`
        const rule = {
          sourceAddressPrefix: "VirtualNetwork",
          destinationPortRange: "443",
        };
      `);
      const diagnostics = nsgWildcardRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("ignores unrelated wildcard strings", () => {
      const context = createContext(`
        const config = {
          pattern: "*",
          glob: "*",
        };
      `);
      const diagnostics = nsgWildcardRule.check(context);
      expect(diagnostics).toHaveLength(0);
    });

    test("has correct metadata", () => {
      expect(nsgWildcardRule.id).toBe("AZR003");
      expect(nsgWildcardRule.severity).toBe("warning");
      expect(nsgWildcardRule.category).toBe("security");
    });
  });
});
