import { describe, expect, test } from "vitest";
import { sqlProfileSchema } from "./config";
import { credentialSource, tokenCommand, TokenSourceError, type RunCommand } from "./token-source";
import { resolvePostgresTarget, classifyPostgresFailure, isUnresolvedTarget } from "./postgres/live/bind";
import { resolveClickHouseTarget, classifyClickHouseFailure } from "./clickhouse/live/bind";

const RDS_URL = "postgres://db.abc123.eu-west-1.rds.amazonaws.com:5433/shop";

describe("tokenCommand", () => {
  test("rds-iam runs aws rds generate-db-auth-token for the URL's host and port and the profile's user", () => {
    expect(tokenCommand({ token: "rds-iam" }, { url: RDS_URL, user: "app", env: {} })).toEqual([
      "aws", "rds", "generate-db-auth-token", "--hostname", "db.abc123.eu-west-1.rds.amazonaws.com", "--port", "5433", "--username", "app", "--region", "eu-west-1",
    ]);
  });

  test("rds-iam takes the region from the config, then AWS_REGION, then the host name", () => {
    const region = (argv: readonly string[]) => argv[argv.indexOf("--region") + 1];
    expect(region(tokenCommand({ token: "rds-iam", region: "us-east-2" }, { url: RDS_URL, user: "app", env: { AWS_REGION: "ap-south-1" } }))).toBe("us-east-2");
    expect(region(tokenCommand({ token: "rds-iam" }, { url: RDS_URL, user: "app", env: { AWS_REGION: "ap-south-1" } }))).toBe("ap-south-1");
    const proxy = tokenCommand({ token: "rds-iam" }, { url: "postgres://db.internal/shop", user: "app", env: {} });
    expect(proxy).not.toContain("--region");
    expect(proxy[proxy.indexOf("--port") + 1]).toBe("5432");
  });

  test("rds-iam needs a user", () => {
    expect(() => tokenCommand({ token: "rds-iam" }, { url: RDS_URL, env: {} })).toThrow(TokenSourceError);
  });

  test("cloud-sql-iam, entra and command", () => {
    expect(tokenCommand({ token: "cloud-sql-iam" }, { url: "postgres://10.0.0.3/shop", env: {} })).toEqual(["gcloud", "sql", "generate-login-token"]);
    expect(tokenCommand({ token: "entra" }, { url: "postgres://x.postgres.database.azure.com/shop", env: {} })).toEqual([
      "az", "account", "get-access-token", "--resource-type", "oss-rdbms", "--query", "accessToken", "--output", "tsv",
    ]);
    expect(tokenCommand({ token: "command", command: ["./mint.sh", "prod"] }, { url: "http://ch:8123", env: {} })).toEqual(["./mint.sh", "prod"]);
  });
});

describe("credentialSource", () => {
  const counting = (outputs: string[]) => {
    const calls: (readonly string[])[] = [];
    const run: RunCommand = async (argv) => {
      calls.push(argv);
      return outputs[Math.min(calls.length - 1, outputs.length - 1)]!;
    };
    return { calls, run };
  };

  test("mints once, reuses the token, and mints again after most of its lifetime", async () => {
    let now = 0;
    const { calls, run } = counting(["one\n", "two\n"]);
    const src = credentialSource({ token: "command", command: ["mint"], ttlSeconds: 100 }, { url: "http://ch:8123", env: {}, source: "sql.profiles.ci.password", run, now: () => now });
    expect(src.source).toBe("sql.profiles.ci.password (command)");
    expect(calls).toHaveLength(0);
    expect(await src.get()).toBe("one");
    now = 79_000;
    expect(await src.get()).toBe("one");
    now = 80_000;
    expect(await src.get()).toBe("two");
    expect(calls).toHaveLength(2);
  });

  test("invalidate forgets the token; requests at once share one mint", async () => {
    const { calls, run } = counting(["a", "b"]);
    const src = credentialSource({ token: "command", command: ["mint"] }, { url: "http://ch:8123", env: {}, source: "s", run });
    expect(await Promise.all([src.get(), src.get(), src.get()])).toEqual(["a", "a", "a"]);
    src.invalidate();
    expect(await src.get()).toBe("b");
    expect(calls).toHaveLength(2);
  });

  test("a failed or empty mint names the program, never its output", async () => {
    const failing: RunCommand = async () => {
      throw Object.assign(new Error("secret-ish stderr"), { code: 2 });
    };
    const missing: RunCommand = async () => {
      throw Object.assign(new Error("spawn"), { code: "ENOENT" });
    };
    const opts = { url: RDS_URL, user: "app", env: {}, source: "sql.profiles.prod.password" };
    const err = (await credentialSource({ token: "rds-iam" }, { ...opts, run: failing }).get().catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TokenSourceError);
    expect(err.message).toBe("sql.profiles.prod.password (rds-iam) could not mint a token: `aws` failed, it exited with 2");
    await expect(credentialSource({ token: "entra" }, { ...opts, run: missing }).get()).rejects.toThrow("`az` failed, az is not installed");
    await expect(credentialSource({ token: "command", command: ["x"] }, { ...opts, run: async () => "  \n" }).get()).rejects.toThrow("printed nothing");
    expect(classifyPostgresFailure(err)).toEqual({ reason: "no-credentials", detail: err.message });
    expect(classifyClickHouseFailure(err).reason).toBe("no-credentials");
  });
});

describe("profiles with a token source", () => {
  test("the schema takes a token source or an env reference, and refuses an unknown one", () => {
    expect(sqlProfileSchema.safeParse({ url: RDS_URL, password: { token: "rds-iam", region: "eu-west-1" } }).success).toBe(true);
    expect(sqlProfileSchema.safeParse({ url: RDS_URL, password: { token: "command", command: ["./mint.sh"], ttlSeconds: 60 } }).success).toBe(true);
    expect(sqlProfileSchema.safeParse({ url: RDS_URL, password: { env: "PW" } }).success).toBe(true);
    expect(sqlProfileSchema.safeParse({ url: RDS_URL, password: { token: "vault" } }).success).toBe(false);
    expect(sqlProfileSchema.safeParse({ url: RDS_URL, password: { token: "command", command: [] } }).success).toBe(false);
  });

  test("a Postgres profile binds a token source with the resolved user, and mints nothing yet", () => {
    const config = { sql: { profiles: { prod: { url: RDS_URL, user: { env: "PG_USER" }, password: { token: "rds-iam" as const } } } } };
    const target = resolvePostgresTarget({ environment: "prod", config, env: { PG_USER: "app" } });
    if (isUnresolvedTarget(target)) throw new Error(target.detail);
    expect(target.endpoint.user).toBe("app");
    expect(target.endpoint.password).toBeUndefined();
    expect(target.endpoint.token?.source).toBe("sql.profiles.prod.password (rds-iam)");
  });

  test("rds-iam with no user is no-credentials", () => {
    const config = { sql: { profiles: { prod: { url: RDS_URL, password: { token: "rds-iam" as const } } } } };
    expect(resolvePostgresTarget({ environment: "prod", config, env: {} })).toMatchObject({ reason: "no-credentials" });
  });

  test("ClickHouse takes a command source and refuses a cloud one", () => {
    const command = { sql: { profiles: { ci: { url: "http://ch:8123", password: { token: "command" as const, command: ["mint"] } } } } };
    const target = resolveClickHouseTarget({ environment: "ci", config: command, env: {} });
    expect("endpoint" in target && target.endpoint.token?.source).toBe("sql.profiles.ci.password (command)");
    const cloud = { sql: { profiles: { ci: { url: "http://ch:8123", password: { token: "cloud-sql-iam" as const } } } } };
    expect(resolveClickHouseTarget({ environment: "ci", config: cloud, env: {} })).toMatchObject({ reason: "no-credentials" });
  });
});
