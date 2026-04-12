import { describe, test, expect } from "vitest";
import { StorageRoles } from "./storage";
import { ComputeRoles } from "./compute";
import { NetworkRoles } from "./network";
import { KeyVaultRoles } from "./keyvault";
import { SqlRoles } from "./sql";
import { ContainerRoles } from "./container";
import { AppServiceRoles } from "./appservice";
import { IdentityRoles } from "./identity";

const allRoleObjects: Record<string, Record<string, string>> = {
  StorageRoles,
  ComputeRoles,
  NetworkRoles,
  KeyVaultRoles,
  SqlRoles,
  ContainerRoles,
  AppServiceRoles,
  IdentityRoles,
};

describe("Azure RBAC Role Constants", () => {
  for (const [name, roles] of Object.entries(allRoleObjects)) {
    describe(name, () => {
      test("is non-empty", () => {
        expect(Object.keys(roles).length).toBeGreaterThan(0);
      });

      test("all values are non-empty strings", () => {
        for (const [key, value] of Object.entries(roles)) {
          expect(typeof value).toBe("string");
          expect(value.length).toBeGreaterThan(0);
        }
      });

      test("no duplicate values", () => {
        const values = Object.values(roles);
        const unique = new Set(values);
        expect(unique.size).toBe(values.length);
      });
    });
  }
});
