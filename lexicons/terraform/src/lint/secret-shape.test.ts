import { describe, expect, test } from "vitest";
import {
  isCredentialShapedValue,
  isLiteralString,
  isPlaceholderValue,
  isSecretName,
  secretShapedAssignment,
} from "./secret-shape";

describe("the name heuristic", () => {
  test.each([
    "password",
    "db_password",
    "PASSWORD",
    "passwd",
    "admin_passwd",
    "secret",
    "client_secret",
    "secret_key",
    "token",
    "deploy_token",
    "api_key",
    "openai_api_key",
    "private_key",
    "access_key",
  ])("%s reads like a credential", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  test.each([
    "region",
    "instance_count",
    "keystore",
    "tokenizer",
    "passwordless_sudo_enabled",
    "bucket",
  ])("%s does not", (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  test.each([
    "secret_arn",
    "db_password_file",
    "api_key_id",
    "private_key_path",
    "deploy_token_name",
  ])("%s is a locator, not the credential itself", (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  test("a locator suffix only excludes when it is the suffix", () => {
    expect(isSecretName("arn_password")).toBe(true);
    expect(isSecretName("file_secret")).toBe(true);
  });
});

describe("the value heuristic", () => {
  test("an AWS access key id is credential-shaped, through core's own detector", () => {
    expect(isCredentialShapedValue("AKIA2E0XYZ4PQRSTUVWX")).toBe(true);
  });

  test("a GitHub token is, for the same reason", () => {
    expect(isCredentialShapedValue("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")).toBe(true);
  });

  test("a JWT is", () => {
    expect(
      isCredentialShapedValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImV4cCI6MTc2NH0.9mAcYbBqp4Ck2XjLwr7QeR1sT3uVwXyZ"),
    ).toBe(true);
  });

  test("a PEM header is, even without the closing block", () => {
    expect(isCredentialShapedValue("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...")).toBe(true);
  });

  test("a long high-entropy token is", () => {
    expect(isCredentialShapedValue("8Jd0hVn2XqB7sLtR4mYcE1zPgWfKa5UiQ3oNrTbA")).toBe(true);
  });

  test.each(["eu-west-1", "t3.micro", "postgres", "app-prod"])("%s is not", (value) => {
    expect(isCredentialShapedValue(value)).toBe(false);
  });

  test("a model id or image ref is not, through core's identifier-slug filter", () => {
    expect(isCredentialShapedValue("registry.example.com/team/app-server")).toBe(false);
  });

  test("a value shorter than eight characters is never judged", () => {
    expect(isCredentialShapedValue("aB3$xY")).toBe(false);
  });
});

describe("placeholders", () => {
  test.each(["changeme", "CHANGE_ME", "change-me", "YOUR_API_KEY", "example-secret", "0000000000000000"])(
    "%s is a placeholder",
    (value) => {
      expect(isPlaceholderValue(value)).toBe(true);
    },
  );

  test("a placeholder is never a finding, whatever the attribute is called", () => {
    expect(secretShapedAssignment("db_password", "CHANGE_ME")).toBeUndefined();
    expect(secretShapedAssignment("api_key", "your-api-key")).toBeUndefined();
  });
});

describe("literals versus references", () => {
  test("an hcl2json expression is not a literal", () => {
    // Both `x = var.y` and `x = "${var.y}"` parse to this string.
    expect(isLiteralString("${var.db_password}")).toBe(false);
    expect(isLiteralString("${data.aws_secretsmanager_secret_version.db.secret_string}")).toBe(false);
  });

  test("a template with an interpolation in it is not a literal either", () => {
    expect(isLiteralString("prefix-${var.env}-suffix")).toBe(false);
  });

  test("a plain string is", () => {
    expect(isLiteralString("hunter2-prod-db")).toBe(true);
  });

  test("a non-string is not", () => {
    expect(isLiteralString(3)).toBe(false);
    expect(isLiteralString(true)).toBe(false);
    expect(isLiteralString(["a"])).toBe(false);
  });
});

describe("secretShapedAssignment", () => {
  test("fires on the name when the value is an unremarkable literal", () => {
    expect(secretShapedAssignment("db_password", "hunter2-prod-db")).toEqual({ reason: "name", length: 15 });
  });

  test("fires on the value when the name says nothing", () => {
    const shape = secretShapedAssignment("bootstrap", "AKIA2E0XYZ4PQRSTUVWX");
    expect(shape?.reason).toBe("value");
  });

  test("prefers the value reason when both hold", () => {
    expect(secretShapedAssignment("api_key", "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")?.reason).toBe("value");
  });

  test("declines a reference, which is the fix rather than the finding", () => {
    expect(secretShapedAssignment("db_password", "${var.db_password}")).toBeUndefined();
  });

  test("declines a short value", () => {
    expect(secretShapedAssignment("password", "abc123")).toBeUndefined();
  });
});
