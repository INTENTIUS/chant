/**
 * The AWS credential chain, as the AWS CLI walks it, for `chant lifecycle
 * whoami` (#3954).
 *
 * `resolveCredentials` (./signing.ts) reads the three environment variables and
 * nothing else. That is right for the read transport's synchronous signing
 * seam, and it made whoami wrong for anyone whose shell holds a profile rather
 * than keys: `AWS_PROFILE=dev` with an SSO session came back as "no identity
 * is configured" while `aws sts get-caller-identity` answered. This module is
 * the asynchronous half: it resolves what the CLI would sign with and hands
 * back literal credentials plus a label for where they came from. The read
 * transport uses the same walk through {@link transportCredentials} (#3958),
 * so whoami and `describeResources` sign as the same principal.
 *
 * There is still no `@aws-sdk/*` here, for the reason the read transport gives:
 * a lexicon keeps that tree out. The chain is small enough to state.
 *
 * ## Order
 *
 *  1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`).
 *     They win over `AWS_PROFILE`, as they do in the AWS CLI. (The JS
 *     SDK v3 skips the environment when `AWS_PROFILE` is set; the CLI does
 *     not, and the CLI is what an operator checks whoami against.) When both
 *     are set, the label says the profile was not used.
 *  2. The profile `AWS_PROFILE` names, else `default` when one exists, read
 *     from `AWS_CONFIG_FILE` (`~/.aws/config`) and
 *     `AWS_SHARED_CREDENTIALS_FILE` (`~/.aws/credentials`). Within a profile:
 *     `role_arn` (with `source_profile` or `credential_source = Environment`),
 *     then static keys, then SSO (`sso_session` or the legacy
 *     `sso_start_url`), then `credential_process`.
 *
 * Not resolved, and said so rather than skipped: `web_identity_token_file`,
 * `mfa_serial`, `credential_source` other than `Environment`, and the
 * instance-metadata and container endpoints.
 *
 * ## SSO
 *
 * The token `aws sso login` cached under `~/.aws/sso/cache/` is read, and when
 * its access token has expired but it carries a refresh token, it is refreshed
 * through SSO OIDC the way the CLI does. The refreshed token is used for this
 * call and NOT written back; whoami is read-only. A missing, expired or
 * refused session is a `no-credentials` answer naming
 * `aws sso login --profile <p>`.
 *
 * ## Credential material
 *
 * Nothing this module returns in a label or an error carries a key, a secret,
 * a session token or an SSO bearer token. `credential_process` output is
 * credential JSON, so a malformed one is described, never echoed.
 */

import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AwsReadError, assumeRole, type AwsReadClientOptions } from "./read-client";
import type { AwsCredentials } from "./signing";

/** One HTTP exchange for the SSO portal and OIDC calls. Injected by tests. */
export type CredentialChainHttp = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text: string }>;

/** Runs a `credential_process` command line. Injected by tests. */
export type CredentialProcessRunner = (
  command: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface CredentialChainOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Reads a file, `undefined` when it does not exist. Defaults to the filesystem. */
  readFile?: (path: string) => string | undefined;
  /** The home directory `~/.aws` hangs off. Defaults to `HOME`, then `os.homedir()`. */
  home?: string;
  /** SSO portal and OIDC transport. Defaults to `fetch`. */
  http?: CredentialChainHttp;
  /** `credential_process` runner. Defaults to a shell `exec`. */
  runProcess?: CredentialProcessRunner;
  /** STS transport for `role_arn` profiles. The `credentials` field is set per call. */
  sts?: AwsReadClientOptions;
  /** Clock for token and credential expiry. */
  now?: () => Date;
}

export interface ResolvedChainCredentials {
  credentials: AwsCredentials;
  /** Where they came from, e.g. `profile dev (sso session acme)`. Never a credential value. */
  source: string;
  /** The profile that resolved them, when one did. */
  profile?: string;
  /** When the credentials stop working, for role, SSO and `credential_process` credentials that say so. */
  expiration?: Date;
}

export interface UnresolvedChainCredentials {
  reason: "no-credentials" | "read-failed";
  detail: string;
}

export type CredentialChainResult =
  | { resolved: ResolvedChainCredentials }
  | { unresolved: UnresolvedChainCredentials };

type Section = Record<string, string>;

/** One link of the chain's answer, before the profile name is attached. */
interface Resolved {
  credentials: AwsCredentials;
  source: string;
  expiration?: Date;
}

/** A timestamp as a Date, or undefined when it is absent or does not parse. */
function expiryOf(value: string | number | undefined): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

/**
 * The INI dialect of the AWS shared files: `[section]`, `key = value`, `#` and
 * `;` comments on their own line (not inline: a `credential_process` command
 * line may hold either character). An indented line under a key with an empty value is a nested
 * setting (`s3 =` / `  max_concurrent_requests = 10`); nothing here reads
 * those, so they are dropped rather than mistaken for top-level keys.
 */
export function parseIni(text: string): Record<string, Section> {
  const out: Record<string, Section> = {};
  let current: Section | undefined;
  let nestedUnder: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*([#;]|$)/.test(raw)) continue;
    const header = raw.match(/^\s*\[([^\]]+)\]\s*([#;].*)?$/);
    if (header) {
      const name = header[1]!.trim().replace(/\s+/g, " ");
      current = out[name] ??= {};
      nestedUnder = undefined;
      continue;
    }
    if (!current) continue;
    if (nestedUnder && /^\s/.test(raw)) continue;
    const kv = raw.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (!kv) continue;
    const [, key, value] = kv;
    nestedUnder = value === "" ? key : undefined;
    if (value !== "") current[key!] = value!;
  }
  return out;
}

interface SharedFiles {
  configPath: string;
  credentialsPath: string;
  config: Record<string, Section>;
  credentials: Record<string, Section>;
}

function loadSharedFiles(env: Record<string, string | undefined>, home: string, read: (p: string) => string | undefined): SharedFiles {
  const configPath = env.AWS_CONFIG_FILE || join(home, ".aws", "config");
  const credentialsPath = env.AWS_SHARED_CREDENTIALS_FILE || join(home, ".aws", "credentials");
  return {
    configPath,
    credentialsPath,
    config: parseIni(read(configPath) ?? ""),
    credentials: parseIni(read(credentialsPath) ?? ""),
  };
}

/** A profile's settings, the credentials file winning over the config file as in the CLI. */
function profileSettings(files: SharedFiles, name: string): Section | undefined {
  const fromConfig = files.config[name === "default" ? "default" : `profile ${name}`] ??
    (name === "default" ? files.config["profile default"] : undefined);
  const fromCredentials = files.credentials[name];
  if (!fromConfig && !fromCredentials) return undefined;
  return { ...fromConfig, ...fromCredentials };
}

const defaultReadFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

const defaultHttp: CredentialChainHttp = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { status: res.status, text: await res.text() };
};

const defaultRunProcess: CredentialProcessRunner = (command) =>
  new Promise((resolve) => {
    exec(command, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

class ChainRefusal extends Error {
  constructor(readonly reason: UnresolvedChainCredentials["reason"], detail: string) {
    super(detail);
  }
}

interface Context {
  env: Record<string, string | undefined>;
  files: SharedFiles;
  home: string;
  read: (path: string) => string | undefined;
  http: CredentialChainHttp;
  runProcess: CredentialProcessRunner;
  sts: AwsReadClientOptions;
  now: () => Date;
}

function envCredentials(env: Record<string, string | undefined>): AwsCredentials | undefined {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return undefined;
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

function envLabel(env: Record<string, string | undefined>): string {
  return env.AWS_SESSION_TOKEN ? "env AWS_ACCESS_KEY_ID + AWS_SESSION_TOKEN" : "env AWS_ACCESS_KEY_ID";
}

/**
 * Resolve credentials the way the AWS CLI does. Returns literal credentials
 * and their source, or a typed refusal that says what to do about it.
 */
export async function resolveCredentialChain(options: CredentialChainOptions = {}): Promise<CredentialChainResult> {
  const env = options.env ?? process.env;
  const fromEnv = envCredentials(env);
  if (fromEnv) {
    const ignored = env.AWS_PROFILE ? `; AWS_PROFILE=${env.AWS_PROFILE} not used, as in the AWS CLI` : "";
    return { resolved: { credentials: fromEnv, source: `${envLabel(env)}${ignored}` } };
  }

  const home = options.home ?? (env.HOME || env.USERPROFILE || homedir());
  const read = options.readFile ?? defaultReadFile;
  const ctx: Context = {
    env,
    home,
    read,
    files: loadSharedFiles(env, home, read),
    http: options.http ?? defaultHttp,
    runProcess: options.runProcess ?? defaultRunProcess,
    sts: options.sts ?? {},
    now: options.now ?? (() => new Date()),
  };

  const named = env.AWS_PROFILE;
  const name = named ?? "default";
  if (!profileSettings(ctx.files, name)) {
    return {
      unresolved: {
        reason: "no-credentials",
        detail: named
          ? `AWS_PROFILE=${named}, but there is no profile ${named} in ${ctx.files.configPath} or ${ctx.files.credentialsPath}`
          : `no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment, no AWS_PROFILE, and no default profile in ${ctx.files.configPath} or ${ctx.files.credentialsPath}`,
      },
    };
  }

  try {
    const resolved = await resolveProfile(ctx, name, []);
    return { resolved: { ...resolved, profile: name } };
  } catch (err) {
    if (err instanceof ChainRefusal) return { unresolved: { reason: err.reason, detail: err.message } };
    throw err;
  }
}

async function resolveProfile(
  ctx: Context,
  name: string,
  visited: string[],
): Promise<Resolved> {
  if (visited.includes(name)) {
    throw new ChainRefusal("no-credentials", `profile ${name}: source_profile loops (${[...visited, name].join(" -> ")})`);
  }
  const p = profileSettings(ctx.files, name);
  if (!p) {
    throw new ChainRefusal(
      "no-credentials",
      `profile ${visited.at(-1)} names source_profile ${name}, which is not in ${ctx.files.configPath} or ${ctx.files.credentialsPath}`,
    );
  }
  // A source profile that has static keys signs with them even when it also
  // has a role_arn, as in the CLI. Only the profile asked for, or a source
  // profile without keys, assumes its role.
  const isSource = visited.length > 0;

  if (p.role_arn && !(isSource && p.aws_access_key_id && p.aws_secret_access_key)) {
    return resolveRoleProfile(ctx, name, p, visited);
  }
  if (p.aws_access_key_id && p.aws_secret_access_key) {
    return {
      credentials: {
        accessKeyId: p.aws_access_key_id,
        secretAccessKey: p.aws_secret_access_key,
        ...(p.aws_session_token ? { sessionToken: p.aws_session_token } : {}),
      },
      source: `profile ${name} (static keys)`,
    };
  }
  if (p.sso_session || p.sso_start_url) return resolveSsoProfile(ctx, name, p);
  if (p.credential_process) return resolveProcessProfile(ctx, name, p.credential_process);
  if (p.web_identity_token_file) {
    throw new ChainRefusal("no-credentials", `profile ${name} uses web_identity_token_file, which chant does not resolve`);
  }
  throw new ChainRefusal(
    "no-credentials",
    `profile ${name} has no aws_access_key_id, role_arn, sso_session, sso_start_url or credential_process`,
  );
}

function withExpiry(expiration: Date | undefined): { expiration?: Date } {
  return expiration ? { expiration } : {};
}

function earliest(a: Date | undefined, b: Date | undefined): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

async function resolveRoleProfile(
  ctx: Context,
  name: string,
  p: Section,
  visited: string[],
): Promise<Resolved> {
  if (p.mfa_serial) {
    throw new ChainRefusal("no-credentials", `profile ${name} sets mfa_serial; chant cannot prompt for an MFA code`);
  }
  let base: Resolved;
  if (p.source_profile) {
    base = await resolveProfile(ctx, p.source_profile, [...visited, name]);
  } else if (p.credential_source === "Environment") {
    const creds = envCredentials(ctx.env);
    if (!creds) {
      throw new ChainRefusal(
        "no-credentials",
        `profile ${name} has credential_source = Environment, but AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set`,
      );
    }
    base = { credentials: creds, source: envLabel(ctx.env) };
  } else if (p.credential_source) {
    throw new ChainRefusal(
      "no-credentials",
      `profile ${name} has credential_source = ${p.credential_source}; chant resolves only Environment`,
    );
  } else {
    throw new ChainRefusal("no-credentials", `profile ${name} has role_arn but no source_profile or credential_source`);
  }

  const duration = p.duration_seconds ? Number(p.duration_seconds) : undefined;
  try {
    const assumed = await assumeRole(
      {
        roleArn: p.role_arn!,
        sessionName: p.role_session_name || `chant-${ctx.now().getTime()}`,
        ...(p.external_id ? { externalId: p.external_id } : {}),
        ...(duration && Number.isFinite(duration) ? { durationSeconds: duration } : {}),
      },
      { ...ctx.sts, region: ctx.sts.region ?? p.region ?? "us-east-1", credentials: base.credentials },
    );
    return {
      credentials: {
        accessKeyId: assumed.accessKeyId,
        secretAccessKey: assumed.secretAccessKey,
        sessionToken: assumed.sessionToken,
      },
      source: `profile ${name} (role ${p.role_arn} via ${base.source})`,
      ...withExpiry(earliest(expiryOf(assumed.expiration), base.expiration)),
    };
  } catch (err) {
    const what = err instanceof AwsReadError ? `${err.code ? `${err.code}: ` : ""}${err.message}` : String(err);
    const refused = err instanceof AwsReadError && (err.status === 401 || err.status === 403);
    throw new ChainRefusal(refused ? "no-credentials" : "read-failed", `profile ${name}: sts:AssumeRole ${p.role_arn} failed: ${what}`);
  }
}

interface SsoToken {
  accessToken?: string;
  expiresAt?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  registrationExpiresAt?: string;
}

function loginHint(name: string): string {
  return `run \`aws sso login --profile ${name}\``;
}

async function resolveSsoProfile(
  ctx: Context,
  name: string,
  p: Section,
): Promise<Resolved> {
  let startUrl = p.sso_start_url;
  let ssoRegion = p.sso_region;
  let cacheKey = startUrl;
  let label = `profile ${name} (sso ${startUrl})`;
  if (p.sso_session) {
    const session = ctx.files.config[`sso-session ${p.sso_session}`];
    if (!session) {
      throw new ChainRefusal(
        "no-credentials",
        `profile ${name} names sso_session ${p.sso_session}, which has no [sso-session ${p.sso_session}] section in ${ctx.files.configPath}`,
      );
    }
    startUrl = session.sso_start_url;
    ssoRegion = session.sso_region ?? ssoRegion;
    cacheKey = p.sso_session;
    label = `profile ${name} (sso session ${p.sso_session})`;
  }
  const accountId = p.sso_account_id;
  const roleName = p.sso_role_name;
  if (!startUrl || !ssoRegion || !accountId || !roleName) {
    const missing = [
      !startUrl && "sso_start_url",
      !ssoRegion && "sso_region",
      !accountId && "sso_account_id",
      !roleName && "sso_role_name",
    ].filter(Boolean);
    throw new ChainRefusal("no-credentials", `profile ${name} is an SSO profile missing ${missing.join(", ")}`);
  }

  const cachePath = join(ctx.home, ".aws", "sso", "cache", `${createHash("sha1").update(cacheKey!).digest("hex")}.json`);
  const raw = ctx.read(cachePath);
  if (raw === undefined) {
    throw new ChainRefusal("no-credentials", `profile ${name}: no cached SSO token at ${cachePath}; ${loginHint(name)}`);
  }
  let token: SsoToken;
  try {
    token = JSON.parse(raw) as SsoToken;
  } catch {
    throw new ChainRefusal("no-credentials", `profile ${name}: the cached SSO token at ${cachePath} is not JSON; ${loginHint(name)}`);
  }

  const now = ctx.now().getTime();
  let accessToken = token.accessToken;
  const expires = token.expiresAt ? Date.parse(token.expiresAt) : NaN;
  if (!accessToken || !(expires > now)) {
    accessToken = p.sso_session ? await refreshSsoToken(ctx, token, ssoRegion, now) : undefined;
    if (!accessToken) {
      throw new ChainRefusal("no-credentials", `profile ${name}: the SSO session has expired; ${loginHint(name)}`);
    }
  }

  const url =
    `https://portal.sso.${ssoRegion}.amazonaws.com/federation/credentials` +
    `?account_id=${encodeURIComponent(accountId)}&role_name=${encodeURIComponent(roleName)}`;
  let res: { status: number; text: string };
  try {
    res = await ctx.http(url, { method: "GET", headers: { "x-amz-sso_bearer_token": accessToken } });
  } catch (err) {
    throw new ChainRefusal("read-failed", `profile ${name}: sso:GetRoleCredentials failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ChainRefusal(
      "no-credentials",
      `profile ${name}: the SSO portal refused the cached session (HTTP ${res.status}); ${loginHint(name)}`,
    );
  }
  if (res.status >= 400) {
    throw new ChainRefusal("read-failed", `profile ${name}: sso:GetRoleCredentials for ${roleName} in ${accountId} failed with HTTP ${res.status}`);
  }
  let role: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; expiration?: number } | undefined;
  try {
    role = (JSON.parse(res.text) as { roleCredentials?: typeof role }).roleCredentials;
  } catch {
    role = undefined;
  }
  if (!role?.accessKeyId || !role.secretAccessKey) {
    throw new ChainRefusal("read-failed", `profile ${name}: sso:GetRoleCredentials answered without role credentials`);
  }
  return {
    credentials: {
      accessKeyId: role.accessKeyId,
      secretAccessKey: role.secretAccessKey,
      ...(role.sessionToken ? { sessionToken: role.sessionToken } : {}),
    },
    source: `${label}, role ${roleName} in ${accountId}`,
    ...withExpiry(expiryOf(role.expiration)),
  };
}

/**
 * Trade a cached refresh token for a new access token through SSO OIDC, the
 * way the CLI keeps an `sso-session` alive without a browser. Returns
 * `undefined` when there is nothing to refresh with or the refresh is
 * refused; the caller turns that into the `aws sso login` hint.
 */
async function refreshSsoToken(ctx: Context, token: SsoToken, region: string, now: number): Promise<string | undefined> {
  if (!token.refreshToken || !token.clientId || !token.clientSecret) return undefined;
  if (token.registrationExpiresAt && !(Date.parse(token.registrationExpiresAt) > now)) return undefined;
  let res: { status: number; text: string };
  try {
    res = await ctx.http(`https://oidc.${region}.amazonaws.com/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: token.clientId,
        clientSecret: token.clientSecret,
        refreshToken: token.refreshToken,
      }),
    });
  } catch {
    return undefined;
  }
  if (res.status >= 400) return undefined;
  try {
    return (JSON.parse(res.text) as { accessToken?: string }).accessToken || undefined;
  } catch {
    return undefined;
  }
}

async function resolveProcessProfile(
  ctx: Context,
  name: string,
  command: string,
): Promise<Resolved> {
  const out = await ctx.runProcess(command);
  if (out.exitCode !== 0) {
    const firstLine = out.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw new ChainRefusal(
      "no-credentials",
      `profile ${name}: credential_process exited ${out.exitCode}${firstLine ? `: ${firstLine}` : ""}`,
    );
  }
  let parsed: { Version?: number; AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string };
  try {
    parsed = JSON.parse(out.stdout) as typeof parsed;
  } catch {
    throw new ChainRefusal("no-credentials", `profile ${name}: credential_process did not print JSON`);
  }
  if (parsed.Version !== 1 || !parsed.AccessKeyId || !parsed.SecretAccessKey) {
    throw new ChainRefusal(
      "no-credentials",
      `profile ${name}: credential_process output is not Version 1 with AccessKeyId and SecretAccessKey`,
    );
  }
  if (parsed.Expiration && !(Date.parse(parsed.Expiration) > ctx.now().getTime())) {
    throw new ChainRefusal("no-credentials", `profile ${name}: credential_process returned credentials that expired at ${parsed.Expiration}`);
  }
  return {
    credentials: {
      accessKeyId: parsed.AccessKeyId,
      secretAccessKey: parsed.SecretAccessKey,
      ...(parsed.SessionToken ? { sessionToken: parsed.SessionToken } : {}),
    },
    source: `profile ${name} (credential_process)`,
    ...withExpiry(expiryOf(parsed.Expiration)),
  };
}

/* ── Credentials for the read transport (#3958) ─────────────────────────── */

/** Cached credentials are re-resolved this long before they expire. */
export const TRANSPORT_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * How long "nothing resolves" is kept before the chain is walked again, so a
 * long-running process picks up an `aws sso login` done after it started.
 */
export const TRANSPORT_UNRESOLVED_TTL_MS = 5 * 60_000;

interface TransportEntry {
  credentials?: AwsCredentials;
  /** Epoch ms after which the entry is walked again. */
  refreshAt: number;
}

/**
 * One walk per environment and shared-file location, shared by every read in
 * the process. Concurrent first reads await the same promise, so an SSO
 * portal call or a `credential_process` runs once rather than once per read.
 */
const transportCache = new Map<string, Promise<TransportEntry>>();

/** Forget every cached walk. For tests, and for a process that changed its profile. */
export function resetTransportCredentials(): void {
  transportCache.clear();
}

async function walkForTransport(options: CredentialChainOptions, now: () => Date): Promise<TransportEntry> {
  let result: CredentialChainResult | undefined;
  try {
    result = await resolveCredentialChain(options);
  } catch {
    result = undefined;
  }
  const t = now().getTime();
  if (!result || "unresolved" in result) return { refreshAt: t + TRANSPORT_UNRESOLVED_TTL_MS };
  const expires = result.resolved.expiration?.getTime();
  if (expires === undefined) return { credentials: result.resolved.credentials, refreshAt: Infinity };
  const early = expires - TRANSPORT_REFRESH_MARGIN_MS;
  return { credentials: result.resolved.credentials, refreshAt: early > t ? early : expires };
}

/**
 * What the native read transport signs with when the caller injected nothing:
 * the same chain whoami walks, so `lifecycle diff --live` signs as the
 * principal whoami reports. The signing seam (`AwsCredentialResolver` in
 * ./signing.ts) is synchronous and the chain is not, so the transport awaits
 * this once before a request and passes the literal credentials in.
 *
 * Environment keys answer directly, as in the chain. Otherwise the walk is
 * cached per process, keyed by the profile and the shared-file locations, and
 * walked again within {@link TRANSPORT_REFRESH_MARGIN_MS} of the expiry the
 * role, SSO or `credential_process` answer carried. A refusal or a failure is
 * `undefined`, which leaves the request unsigned exactly as before; it is kept
 * for {@link TRANSPORT_UNRESOLVED_TTL_MS}.
 */
export async function transportCredentials(options: CredentialChainOptions = {}): Promise<AwsCredentials | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = envCredentials(env);
  if (fromEnv) return fromEnv;
  const now = options.now ?? (() => new Date());
  const home = options.home ?? (env.HOME || env.USERPROFILE || homedir());
  const key = JSON.stringify([env.AWS_PROFILE ?? "", env.AWS_CONFIG_FILE ?? "", env.AWS_SHARED_CREDENTIALS_FILE ?? "", home]);

  const cached = transportCache.get(key);
  if (cached) {
    const entry = await cached;
    if (now().getTime() < entry.refreshAt) return entry.credentials;
    if (transportCache.get(key) === cached) transportCache.delete(key);
  }
  let pending = transportCache.get(key);
  if (!pending) {
    pending = walkForTransport({ ...options, env, home }, now);
    transportCache.set(key, pending);
  }
  return (await pending).credentials;
}
