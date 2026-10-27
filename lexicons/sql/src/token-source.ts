/**
 * Short-lived database credentials (#3685): a profile's `password` can name a
 * token source instead of an environment variable, and the token is minted
 * when a connection needs it.
 *
 * ```ts
 * profiles: {
 *   prod: { url: "postgres://db.abc.us-east-1.rds.amazonaws.com:5432/shop", user: { env: "PG_USER" }, password: { token: "rds-iam" } },
 *   ci: { url: "postgres://db.internal:5432/shop", password: { token: "command", command: ["./mint-token.sh"], ttlSeconds: 600 } },
 * }
 * ```
 *
 * Each cloud source runs that cloud's own command line, which reads the job's
 * ambient identity (an OIDC-federated role in CI, a workload identity, a
 * logged-in developer), so chant holds no cloud SDK and no long-lived secret:
 *
 * - `rds-iam`: `aws rds generate-db-auth-token`, for RDS and Aurora. The host
 *   and port come from the profile's URL, the user from its `user`, the region
 *   from `region`, else `AWS_REGION`, else the RDS host name.
 * - `cloud-sql-iam`: `gcloud sql generate-login-token`.
 * - `entra`: `az account get-access-token` for Azure Database for PostgreSQL.
 * - `command`: any command that prints a password on its standard output.
 *
 * In a CI job that traded its OIDC token through chant's `ci.identity`
 * (`@intentius/chant/ci-identity`, #4296, #4572), the cloud sources mint
 * from what the trade left instead, with no cloud command line in the
 * image ({@link tradedToken}):
 *
 * - `rds-iam` presigns the token with the traded AWS keys
 *   (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`),
 *   through chant's SigV4 signer, as `aws rds generate-db-auth-token` does.
 * - `cloud-sql-iam` is the traded Google access token
 *   (`GOOGLE_OAUTH_ACCESS_TOKEN`), which Cloud SQL's IAM sign-in takes.
 * - `entra` is `AZURE_DATABASE_ACCESS_TOKEN`, which the trade sets with
 *   `ci.identity.cloud.azure.database`. The ARM token it always sets is
 *   for another scope, so without `database` `entra` still runs `az`.
 *
 * Outside CI none of these variables is set and the command lines run.
 *
 * A token is reused until most of its lifetime has passed and minted again
 * after, so a long apply, whose ClickHouse requests each carry the password
 * and whose Postgres connections each authenticate when opened, never sends
 * an expired one. A token is never written to a message, an outcome or a log.
 */

import { execFile } from "node:child_process";
import { z } from "zod";
import { presignV4 } from "@intentius/chant/cloud-lister/sigv4";

const ttl = z.number().int().positive().optional();

/** The token sources a profile's `password` can name. */
export const tokenSourceSchema = z.discriminatedUnion("token", [
  z.strictObject({
    token: z.literal("rds-iam"),
    /** The AWS region. `AWS_REGION`, `AWS_DEFAULT_REGION`, else the RDS host name's, when omitted. */
    region: z.string().min(1).optional(),
    /** How long a token is valid, in seconds. 900, the RDS lifetime, when omitted. */
    ttlSeconds: ttl,
  }),
  z.strictObject({
    token: z.literal("cloud-sql-iam"),
    /** How long a token is valid, in seconds. 3600 when omitted. */
    ttlSeconds: ttl,
  }),
  z.strictObject({
    token: z.literal("entra"),
    /** How long a token is valid, in seconds. 3600 when omitted. */
    ttlSeconds: ttl,
  }),
  z.strictObject({
    token: z.literal("command"),
    /** The program and its arguments, run without a shell; its standard output, trimmed, is the password. */
    command: z.array(z.string().min(1)).min(1),
    /** How long a token is valid, in seconds. 300 when omitted. */
    ttlSeconds: ttl,
  }),
]);

export type TokenSourceConfig = z.infer<typeof tokenSourceSchema>;

/** The cloud sources, which mint for a Postgres server only. */
export const POSTGRES_ONLY_TOKEN_SOURCES: ReadonlySet<string> = new Set(["rds-iam", "cloud-sql-iam", "entra"]);

const DEFAULT_TTL_SECONDS: Record<TokenSourceConfig["token"], number> = {
  "rds-iam": 900,
  "cloud-sql-iam": 3600,
  entra: 3600,
  command: 300,
};

/** A token reused past this share of its lifetime is minted again. */
const REUSE_FRACTION = 0.8;

/** A token source that could not mint. The message names the source and the command, never what it printed. */
export class TokenSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenSourceError";
  }
}

/** Runs a program without a shell and returns its standard output. */
export type RunCommand = (argv: readonly string[], env: Record<string, string | undefined>) => Promise<string>;

const runCommand: RunCommand = (argv, env) =>
  new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { env: env as NodeJS.ProcessEnv, timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });

/** Where a token is minted, and the cached token. */
export interface CredentialSource {
  /** What the token is minted by, for a message: `sql.profiles.prod.password (rds-iam)`. */
  readonly source: string;
  /** A valid token: the cached one, or a new one when it has expired. */
  get(): Promise<string>;
  /** Forget the cached token, so the next `get()` mints again. */
  invalidate(): void;
}

/** The variable chant's trade sets to an Azure Database for PostgreSQL token (`AZURE_DATABASE_TOKEN_ENV` in `@intentius/chant/ci-identity`, #4572). */
export const AZURE_DATABASE_TOKEN_ENV = "AZURE_DATABASE_ACCESS_TOKEN";

/** The region an `rds-iam` token is signed for: the config's, `AWS_REGION`, `AWS_DEFAULT_REGION`, else the RDS host name's. */
function rdsRegion(config: { region?: string }, hostname: string, env: Record<string, string | undefined>): string | undefined {
  return config.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? /\.([a-z]{2}(?:-[a-z]+)+-\d+)\.rds\.amazonaws\.com$/.exec(hostname)?.[1];
}

/**
 * The token a cloud source takes from chant's traded identity (#4572), when
 * the job's environment holds it; undefined otherwise, and for `command`.
 * Pure but for `now`, for tests.
 */
export function tradedToken(
  config: TokenSourceConfig,
  input: { url: string; user?: string; env: Record<string, string | undefined> },
  now: Date = new Date(),
): string | undefined {
  const env = input.env;
  switch (config.token) {
    case "command":
      return undefined;
    case "cloud-sql-iam":
      return env.GOOGLE_OAUTH_ACCESS_TOKEN || env.CLOUDSDK_AUTH_ACCESS_TOKEN || undefined;
    case "entra":
      return env[AZURE_DATABASE_TOKEN_ENV] || undefined;
    case "rds-iam": {
      const accessKeyId = env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey) return undefined;
      if (input.user === undefined) throw new TokenSourceError("rds-iam mints a token for one database user; the profile names no user");
      const url = new URL(input.url);
      const region = rdsRegion(config, url.hostname, env);
      if (region === undefined) throw new TokenSourceError(`rds-iam signs its token for a region; set the token source's region or AWS_REGION for ${url.hostname}`);
      const target = new URL(`https://${url.hostname}:${url.port || "5432"}/`);
      target.searchParams.set("Action", "connect");
      target.searchParams.set("DBUser", input.user);
      const signed = presignV4({
        url: target.toString(),
        region,
        service: "rds-db",
        credentials: { accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) },
        seconds: DEFAULT_TTL_SECONDS["rds-iam"],
        now,
      });
      return signed.replace(/^https:\/\//, "");
    }
  }
}

/** The program a source runs. Pure, for tests. */
export function tokenCommand(
  config: TokenSourceConfig,
  input: { url: string; user?: string; env: Record<string, string | undefined> },
): readonly string[] {
  switch (config.token) {
    case "command":
      return config.command;
    case "cloud-sql-iam":
      return ["gcloud", "sql", "generate-login-token"];
    case "entra":
      return ["az", "account", "get-access-token", "--resource-type", "oss-rdbms", "--query", "accessToken", "--output", "tsv"];
    case "rds-iam": {
      const url = new URL(input.url);
      if (input.user === undefined) throw new TokenSourceError("rds-iam mints a token for one database user; the profile names no user");
      const region = rdsRegion(config, url.hostname, input.env);
      return [
        "aws",
        "rds",
        "generate-db-auth-token",
        "--hostname",
        url.hostname,
        "--port",
        url.port || "5432",
        "--username",
        input.user,
        ...(region !== undefined ? ["--region", region] : []),
      ];
    }
  }
}

/**
 * A source that mints with `config` when asked. Nothing runs until `get()`.
 * `now` and `run` are for tests.
 */
export function credentialSource(
  config: TokenSourceConfig,
  input: {
    url: string;
    user?: string;
    env: Record<string, string | undefined>;
    source: string;
    run?: RunCommand;
    now?: () => number;
  },
): CredentialSource {
  const run = input.run ?? runCommand;
  const now = input.now ?? Date.now;
  const lifetimeMs = (config.ttlSeconds ?? DEFAULT_TTL_SECONDS[config.token]) * 1000 * REUSE_FRACTION;
  const source = `${input.source} (${config.token})`;
  let cached: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  const mint = async (): Promise<string> => {
    // #4572: a CI job that traded its OIDC token through chant mints from what the trade left.
    const traded = tradedToken(config, input, new Date(now()));
    if (traded !== undefined) {
      cached = { token: traded, until: now() + lifetimeMs };
      return traded;
    }
    const argv = tokenCommand(config, input);
    let out: string;
    try {
      out = await run(argv, input.env);
    } catch (err) {
      const e = err as { code?: unknown; stderr?: unknown };
      const why = e.code === "ENOENT" ? `${argv[0]} is not installed` : `it exited with ${String(e.code ?? "an error")}`;
      throw new TokenSourceError(`${source} could not mint a token: \`${argv[0]}\` failed, ${why}`);
    }
    const token = out.trim();
    if (token === "") throw new TokenSourceError(`${source} could not mint a token: \`${argv[0]}\` printed nothing`);
    cached = { token, until: now() + lifetimeMs };
    return token;
  };
  return {
    source,
    async get() {
      if (cached && now() < cached.until) return cached.token;
      // Requests that ask at once share one mint.
      pending ??= mint().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
