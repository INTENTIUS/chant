import { describe, test, expect } from "bun:test";
import {
  entityTypeToTsName,
  tsNameToEntityType,
  isComposeType,
  isDockerfileType,
  ALL_ENTITY_TYPES,
} from "./naming";

describe("entityTypeToTsName", () => {
  test("maps Compose Service", () => {
    expect(entityTypeToTsName("Docker::Compose::Service")).toBe("Service");
  });

  test("maps Compose Volume", () => {
    expect(entityTypeToTsName("Docker::Compose::Volume")).toBe("Volume");
  });

  test("maps Compose Network", () => {
    expect(entityTypeToTsName("Docker::Compose::Network")).toBe("Network");
  });

  test("maps Compose Config with disambiguation", () => {
    expect(entityTypeToTsName("Docker::Compose::Config")).toBe("DockerConfig");
  });

  test("maps Compose Secret with disambiguation", () => {
    expect(entityTypeToTsName("Docker::Compose::Secret")).toBe("DockerSecret");
  });

  test("maps Dockerfile", () => {
    expect(entityTypeToTsName("Docker::Dockerfile")).toBe("Dockerfile");
  });

  test("falls back to last segment for unknown types", () => {
    expect(entityTypeToTsName("Docker::Unknown::Foo")).toBe("Foo");
  });
});

describe("tsNameToEntityType", () => {
  test("reverse maps Service", () => {
    expect(tsNameToEntityType("Service")).toBe("Docker::Compose::Service");
  });

  test("reverse maps Dockerfile", () => {
    expect(tsNameToEntityType("Dockerfile")).toBe("Docker::Dockerfile");
  });

  test("returns undefined for unknown name", () => {
    expect(tsNameToEntityType("Unknown")).toBeUndefined();
  });
});

describe("isComposeType", () => {
  test("true for Compose types", () => {
    expect(isComposeType("Docker::Compose::Service")).toBe(true);
    expect(isComposeType("Docker::Compose::Volume")).toBe(true);
  });

  test("false for Dockerfile", () => {
    expect(isComposeType("Docker::Dockerfile")).toBe(false);
  });
});

describe("isDockerfileType", () => {
  test("true for Dockerfile", () => {
    expect(isDockerfileType("Docker::Dockerfile")).toBe(true);
  });

  test("false for Compose types", () => {
    expect(isDockerfileType("Docker::Compose::Service")).toBe(false);
  });
});

describe("ALL_ENTITY_TYPES", () => {
  test("contains all six types", () => {
    expect(ALL_ENTITY_TYPES).toHaveLength(6);
    expect(ALL_ENTITY_TYPES).toContain("Docker::Compose::Service");
    expect(ALL_ENTITY_TYPES).toContain("Docker::Dockerfile");
  });
});
