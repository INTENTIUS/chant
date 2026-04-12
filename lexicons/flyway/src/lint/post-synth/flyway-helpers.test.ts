import { describe, test, expect } from "vitest";
import {
  parseFlywayTOML,
  forEachEnvironment,
  isProductionEnv,
  getFlywaySection,
} from "./flyway-helpers";

describe("parseFlywayTOML", () => {
  test("parses valid TOML config", () => {
    const config = parseFlywayTOML(`
[flyway]
locations = ["filesystem:sql"]

[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
`);
    expect(config.flyway).toBeDefined();
    expect(config.environments?.dev).toBeDefined();
  });

  test("returns empty object for empty input", () => {
    const config = parseFlywayTOML("");
    expect(config).toBeDefined();
  });
});

describe("forEachEnvironment", () => {
  test("iterates over all environments", () => {
    const config = parseFlywayTOML(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"

[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
`);
    const names: string[] = [];
    forEachEnvironment(config, (name) => names.push(name));
    expect(names).toEqual(["dev", "prod"]);
  });

  test("handles missing environments section", () => {
    const config = parseFlywayTOML(`
[flyway]
locations = ["filesystem:sql"]
`);
    const names: string[] = [];
    forEachEnvironment(config, (name) => names.push(name));
    expect(names).toEqual([]);
  });
});

describe("isProductionEnv", () => {
  test("matches common production names", () => {
    expect(isProductionEnv("prod")).toBe(true);
    expect(isProductionEnv("production")).toBe(true);
    expect(isProductionEnv("prd")).toBe(false);
    expect(isProductionEnv("prod-us-east")).toBe(true);
  });

  test("returns false for non-production names", () => {
    expect(isProductionEnv("dev")).toBe(false);
    expect(isProductionEnv("staging")).toBe(false);
    expect(isProductionEnv("test")).toBe(false);
  });
});

describe("getFlywaySection", () => {
  test("extracts flyway section", () => {
    const config = parseFlywayTOML(`
[flyway]
locations = ["filesystem:sql"]
cleanDisabled = true
`);
    const flyway = getFlywaySection(config);
    expect(flyway).toBeDefined();
    expect(flyway?.cleanDisabled).toBe(true);
  });

  test("returns undefined when flyway section missing", () => {
    const config = parseFlywayTOML(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
`);
    const flyway = getFlywaySection(config);
    expect(flyway).toBeUndefined();
  });
});
