import { describe, test, expect } from "vitest";
import { azGroupEnsureCommand, azGroupDeleteCommand } from "./azure";

describe("azGroupEnsureCommand (#707)", () => {
  test("creates the resource group in the given location, quietly", () => {
    expect(azGroupEnsureCommand("chant-rg", "eastus")).toBe(
      "az group create --name chant-rg --location eastus --output none",
    );
  });

  test("honors a non-default location", () => {
    expect(azGroupEnsureCommand("rg", "westeurope")).toContain("--location westeurope");
  });
});

describe("azGroupDeleteCommand (#707)", () => {
  test("force-deletes the group without blocking", () => {
    expect(azGroupDeleteCommand("chant-rg")).toBe(
      "az group delete --name chant-rg --yes --no-wait",
    );
  });
});
