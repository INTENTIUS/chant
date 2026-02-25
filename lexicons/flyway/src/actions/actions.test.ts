import { describe, test, expect } from "bun:test";
import {
  MigrateCommands,
  CallbackEvents,
  EnterpriseCallbackEvents,
  ProvisionerTypes,
  ResolverTypes,
} from "./migrate";

const allConstants = {
  MigrateCommands,
  CallbackEvents,
  EnterpriseCallbackEvents,
  ProvisionerTypes,
  ResolverTypes,
};

describe("Action Constants", () => {
  for (const [name, constant] of Object.entries(allConstants)) {
    describe(name, () => {
      test("all values are non-empty strings", () => {
        for (const [key, value] of Object.entries(constant)) {
          expect(typeof value).toBe("string");
          expect((value as string).length).toBeGreaterThan(0);
        }
      });

      test("no duplicate values", () => {
        const values = Object.values(constant);
        expect(new Set(values).size).toBe(values.length);
      });

      test("no duplicate keys", () => {
        const keys = Object.keys(constant);
        expect(new Set(keys).size).toBe(keys.length);
      });
    });
  }

  describe("EnterpriseCallbackEvents are a subset of CallbackEvents", () => {
    test("every enterprise event exists in CallbackEvents", () => {
      const allEvents = new Set(Object.values(CallbackEvents));
      for (const event of Object.values(EnterpriseCallbackEvents)) {
        expect(allEvents.has(event)).toBe(true);
      }
    });
  });

  describe("MigrateCommands are lowercase", () => {
    test("every command is lowercase", () => {
      for (const cmd of Object.values(MigrateCommands)) {
        expect(cmd).toBe(cmd.toLowerCase());
      }
    });
  });
});
