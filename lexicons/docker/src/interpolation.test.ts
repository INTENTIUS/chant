import { describe, test, expect } from "bun:test";
import { env } from "./interpolation";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

describe("env()", () => {
  test("bare variable: ${VAR}", () => {
    const e = env("APP_IMAGE");
    expect(e.toJSON()).toBe("${APP_IMAGE}");
    expect(e.toString()).toBe("${APP_IMAGE}");
  });

  test("default value: ${VAR:-default}", () => {
    const e = env("APP_IMAGE", { default: "myapp:latest" });
    expect(e.toJSON()).toBe("${APP_IMAGE:-myapp:latest}");
  });

  test("required variable: ${VAR:?error}", () => {
    const e = env("DB_URL", { required: true });
    expect(e.toJSON()).toBe("${DB_URL:?DB_URL is required}");
  });

  test("required with custom error message: ${VAR:?msg}", () => {
    const e = env("DB_URL", { errorMessage: "Database URL must be set" });
    expect(e.toJSON()).toBe("${DB_URL:?Database URL must be set}");
  });

  test("ifSet: ${VAR:+value}", () => {
    const e = env("DEBUG", { ifSet: "true" });
    expect(e.toJSON()).toBe("${DEBUG:+true}");
  });

  test("ifSet takes precedence over default", () => {
    const e = env("X", { ifSet: "on", default: "off" });
    expect(e.toJSON()).toBe("${X:+on}");
  });

  test("has INTRINSIC_MARKER", () => {
    const e = env("FOO");
    expect(INTRINSIC_MARKER in e).toBe(true);
  });
});
