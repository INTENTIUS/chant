/**
 * #4572: in a CI job that traded its OIDC token through chant's
 * ci.identity, the cloud token sources mint from what the trade left, and
 * run no cloud command line. Test values only; nothing reaches a cloud.
 */

import { describe, expect, test } from "vitest";
import { AZURE_DATABASE_TOKEN_ENV as CORE_AZURE_DATABASE_TOKEN_ENV } from "@intentius/chant/ci-identity";
import { AZURE_DATABASE_TOKEN_ENV, credentialSource, tradedToken, TokenSourceError, type RunCommand } from "./token-source";

const RDS_URL = "postgres://db.abc123.eu-west-1.rds.amazonaws.com:5433/shop";
const AWS = { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "session", AWS_REGION: "eu-west-1" };
const NOW = new Date("2026-10-27T12:00:00Z");

describe("tradedToken", () => {
  test("rds-iam presigns connect for the host, port and user with the traded keys", () => {
    const token = tradedToken({ token: "rds-iam" }, { url: RDS_URL, user: "app", env: AWS }, NOW)!;
    expect(token.startsWith("db.abc123.eu-west-1.rds.amazonaws.com:5433/?")).toBe(true);
    const q = new URLSearchParams(token.slice(token.indexOf("?") + 1));
    expect(q.get("Action")).toBe("connect");
    expect(q.get("DBUser")).toBe("app");
    expect(q.get("X-Amz-Credential")).toBe("AKIDEXAMPLE/20261027/eu-west-1/rds-db/aws4_request");
    expect(q.get("X-Amz-Expires")).toBe("900");
    expect(q.get("X-Amz-Security-Token")).toBe("session");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rds-iam without traded keys falls through to the command line", () => {
    expect(tradedToken({ token: "rds-iam" }, { url: RDS_URL, user: "app", env: {} }, NOW)).toBeUndefined();
  });

  test("rds-iam with keys still needs a user and a region", () => {
    expect(() => tradedToken({ token: "rds-iam" }, { url: RDS_URL, env: AWS }, NOW)).toThrow(TokenSourceError);
    const { AWS_REGION: _r, ...noRegion } = AWS;
    expect(() => tradedToken({ token: "rds-iam" }, { url: "postgres://db.internal/shop", user: "app", env: noRegion }, NOW)).toThrow(/region/);
  });

  test("cloud-sql-iam is the traded Google access token", () => {
    expect(tradedToken({ token: "cloud-sql-iam" }, { url: "postgres://10.0.0.3/shop", env: { GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.x" } })).toBe("ya29.x");
    expect(tradedToken({ token: "cloud-sql-iam" }, { url: "postgres://10.0.0.3/shop", env: { CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29.y" } })).toBe("ya29.y");
    expect(tradedToken({ token: "cloud-sql-iam" }, { url: "postgres://10.0.0.3/shop", env: {} })).toBeUndefined();
  });

  test("entra is the database token, never the ARM one", () => {
    expect(tradedToken({ token: "entra" }, { url: "postgres://x.postgres.database.azure.com/shop", env: { [AZURE_DATABASE_TOKEN_ENV]: "eyJdb" } })).toBe("eyJdb");
    expect(tradedToken({ token: "entra" }, { url: "postgres://x.postgres.database.azure.com/shop", env: { AZURE_ACCESS_TOKEN: "eyJarm" } })).toBeUndefined();
  });

  test("command never takes a traded token", () => {
    expect(tradedToken({ token: "command", command: ["./mint.sh"] }, { url: "postgres://x/shop", env: AWS })).toBeUndefined();
  });

  test("the variable is the one core's trade sets", () => {
    expect(AZURE_DATABASE_TOKEN_ENV).toBe(CORE_AZURE_DATABASE_TOKEN_ENV);
  });
});

describe("credentialSource with a traded identity", () => {
  test("mints without running a command, and caches", async () => {
    let ran = 0;
    const run: RunCommand = async () => {
      ran += 1;
      return "from-cli";
    };
    const src = credentialSource({ token: "cloud-sql-iam" }, { url: "postgres://10.0.0.3/shop", env: { GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.x" }, source: "sql.profiles.prod.password", run });
    expect(await src.get()).toBe("ya29.x");
    expect(await src.get()).toBe("ya29.x");
    expect(ran).toBe(0);
  });

  test("runs the command line when the job traded nothing", async () => {
    const src = credentialSource({ token: "entra" }, { url: "postgres://x/shop", env: {}, source: "sql.profiles.prod.password", run: async () => "from-az\n" });
    expect(await src.get()).toBe("from-az");
  });
});
