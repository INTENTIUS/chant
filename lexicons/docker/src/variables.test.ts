import { describe, test, expect } from "bun:test";
import { DOCKER_VARS, COMPOSE_VARS } from "./variables";

describe("DOCKER_VARS", () => {
  test("exposes DOCKER_BUILDKIT", () => {
    expect(DOCKER_VARS.DOCKER_BUILDKIT).toBe("DOCKER_BUILDKIT");
  });

  test("exposes DOCKER_HOST", () => {
    expect(DOCKER_VARS.DOCKER_HOST).toBe("DOCKER_HOST");
  });

  test("is a const object", () => {
    expect(typeof DOCKER_VARS).toBe("object");
    expect(Object.keys(DOCKER_VARS).length).toBeGreaterThan(0);
  });
});

describe("COMPOSE_VARS", () => {
  test("exposes COMPOSE_PROJECT_NAME", () => {
    expect(COMPOSE_VARS.COMPOSE_PROJECT_NAME).toBe("COMPOSE_PROJECT_NAME");
  });

  test("exposes COMPOSE_FILE", () => {
    expect(COMPOSE_VARS.COMPOSE_FILE).toBe("COMPOSE_FILE");
  });

  test("is a const object", () => {
    expect(typeof COMPOSE_VARS).toBe("object");
    expect(Object.keys(COMPOSE_VARS).length).toBeGreaterThan(0);
  });
});
