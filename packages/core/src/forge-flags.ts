/**
 * #4800 — the forge target from a product's flags, over the job's
 * environment.
 *
 * SQL Yodeler's `--forge`, `--repo`, `--pr`, `--api-url` and `--token-env`,
 * terragucci's target built from a configured origin and path, and plywood's
 * `--forge` each turned into {@link forgeTargetFromEnv}'s input their own
 * way. {@link forgeTargetWith} is {@link forgeTargetFromEnv} with overrides
 * for the repository, the pull request, the REST base and the web origin,
 * and {@link forgeTargetFromFlags} takes them as the strings a command line
 * gives and checks them first.
 *
 * The overrides are written into a copy of the environment as the variables
 * {@link forgeTargetFromEnv} reads, so its reading stays the one reading.
 * They live here, not in `pr-forge.ts`, because that file is in the pr-forge
 * and pr-loop bundles, which have no room for them.
 */

import { detectForge, FORGE_KINDS, FORGE_TOKEN_ORDER, ForgeEnvironmentError, forgeTargetFromEnv, type ForgeKind, type ForgeTarget, type ForgeTargetOptions } from "./pr-forge";

/** What {@link forgeTargetWith} takes over the environment. */
export interface ForgeOverrides {
  /** `--repo`: `owner/name`, or the GitLab project id or path. */
  repo?: string;
  /** `--pr`: the pull or merge request. Its head is then the job's commit, not the event's. */
  pr?: number;
  /** `--api-url`: the REST base. Without `url`, its host is the target's. */
  apiUrl?: string;
  /** `--url`: the forge's web origin. It gives the host, and the REST base ({@link apiBaseOf}) when `apiUrl` is not given. */
  url?: string;
  /** Return a target with an empty token when none is set, which reads a public repository. Default false. */
  tokenOptional?: boolean;
}

const trimUrl = (u: string | undefined): string | undefined => u?.trim().replace(/\/+$/, "") || undefined;

/** `scheme://host[:port]` of a URL, the path dropped. */
const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * A forge's REST base from its web origin (terragucci's `apiBase`):
 * `https://api.github.com` for github.com, `<url>/api/v3` for another
 * GitHub host, `<url>/api/v4` on GitLab, `<url>/api/v1` on Forgejo.
 */
export function apiBaseOf(kind: ForgeKind, url: string): string {
  const origin = trimUrl(url) ?? url;
  if (kind === "gitlab") return `${origin}/api/v4`;
  if (kind === "forgejo") return `${origin}/api/v1`;
  return hostOf(origin) === "github.com" ? "https://api.github.com" : `${origin}/api/v3`;
}

/** The variable a given or placeholder token is put in for {@link forgeTargetFromEnv} to read. */
const GIVEN_TOKEN = "CHANT_GIVEN_FORGE_TOKEN";

/**
 * {@link forgeTargetFromEnv} with `overrides` over what the environment
 * says (#4800); a run outside CI passes all of them with `kind`. The run's
 * URL stays the job's own, since the run is the job's whatever it posts to.
 * Throws {@link ForgeEnvironmentError} as {@link forgeTargetFromEnv} does.
 */
export function forgeTargetWith(env: Record<string, string | undefined> = process.env, opts: ForgeTargetOptions & ForgeOverrides = {}): ForgeTarget {
  const { repo: repoIn, pr, apiUrl: apiIn, url: urlIn, tokenOptional, ...base } = opts;
  const kind = base.kind ?? detectForge(env);
  if (!kind) throw new ForgeEnvironmentError(undefined, []);
  const repo = repoIn?.trim() || undefined;
  const url = trimUrl(urlIn);
  const apiUrl = trimUrl(apiIn) ?? (url ? apiBaseOf(kind, url) : undefined);
  const prRef = pr !== undefined && pr > 0 ? pr : undefined;
  const e: Record<string, string | undefined> = { ...env };
  const fj = kind === "forgejo";
  const job = (name: string): string | undefined => (fj ? env[`FORGEJO_${name}`]?.trim() || undefined : undefined) ?? (env[`GITHUB_${name}`]?.trim() || undefined);
  if (kind === "gitlab") {
    if (repo) e.CI_MERGE_REQUEST_PROJECT_ID = e.CI_PROJECT_ID = repo;
    if (prRef) e.CI_MERGE_REQUEST_IID = String(prRef);
    if (apiUrl) e.CI_API_V4_URL = apiUrl;
    if (url) e.CI_SERVER_URL = url;
    if (url || apiUrl) e.CI_SERVER_HOST = hostOf(url ?? apiUrl!);
  } else {
    // A Forgejo job reads FORGEJO_* before GITHUB_*, so an override sets both.
    const set = (name: string, value: string | undefined): void => {
      e[`GITHUB_${name}`] = value;
      e[`FORGEJO_${name}`] = value;
    };
    if (repo) set("REPOSITORY", repo);
    if (apiUrl) set("API_URL", apiUrl);
    if (url) set("SERVER_URL", url);
    if (prRef) {
      // The event payload names the pull request before the ref does.
      set("EVENT_PATH", undefined);
      set("REF", `refs/pull/${prRef}/merge`);
    }
  }
  const names = base.tokenEnv ? [base.tokenEnv] : FORGE_TOKEN_ORDER[kind];
  const noToken = tokenOptional === true && !names.some((n) => e[n]?.trim());
  if (noToken) e[GIVEN_TOKEN] = "-";
  const t = forgeTargetFromEnv(e, { ...base, kind, ...(noToken ? { tokenEnv: GIVEN_TOKEN } : {}) });
  const out: ForgeTarget = { ...t };
  if (noToken) Object.assign(out, { token: "", tokenSource: "" });
  if (kind !== "gitlab" && apiUrl && !url) out.host = hostOf(apiUrl)!.replace(/^api\.github\.com$/, "github.com");
  // #4888: the web origin, for a product's links and messages: `url`, else the job's server when it is the target's host, else https on the host.
  const server = url ?? trimUrl(kind === "gitlab" ? e.CI_SERVER_URL : ((fj ? e.FORGEJO_SERVER_URL : undefined) ?? e.GITHUB_SERVER_URL));
  out.origin = server && /^https?:\/\//i.test(server) && hostOf(server) === out.host ? originOf(server) : `https://${out.host}`;
  if (kind !== "gitlab" && (repo || url)) {
    const server = trimUrl(job("SERVER_URL"));
    const jobRepo = job("REPOSITORY");
    const runId = job("RUN_ID");
    if (server && jobRepo && runId) out.runUrl = `${server}/${jobRepo}/actions/runs/${runId}`;
    else delete out.runUrl;
  }
  return out;
}

/** A product's forge flags, as strings from its command line, and what it read from its config. */
export interface ForgeFlags {
  /** `--forge`: github, gitlab or forgejo, over {@link detectForge}. */
  forge?: string;
  /** `--repo`: `owner/name`, or the GitLab project id or path. */
  repo?: string;
  /** `--pr`: the pull or merge request number. */
  pr?: string | number;
  /** `--api-url`: the REST base. */
  apiUrl?: string;
  /** `--url`: the forge's web origin, which gives the host and, without `--api-url`, the REST base. */
  url?: string;
  /** `--token-env`: the one variable to read the token from. */
  tokenEnv?: string;
  /** A token the product already holds (read from its own config's variable). Never a flag. */
  token?: string;
}

/** A flag {@link forgeTargetFromFlags} refuses, named in the message. */
export class ForgeFlagError extends Error {
  constructor(
    readonly flag: string,
    message: string,
  ) {
    super(message);
    this.name = "ForgeFlagError";
  }
}

const set = (v: string | undefined): string | undefined => (v === undefined || v.trim() === "" ? undefined : v.trim());

/**
 * The checked flags as {@link forgeTargetWith}'s options: `--forge` one of
 * {@link FORGE_KINDS}, `--pr` a positive whole number, `--url` and
 * `--api-url` http or https URLs. Throws {@link ForgeFlagError}.
 */
export function forgeTargetOptionsFromFlags(flags: ForgeFlags): ForgeTargetOptions & ForgeOverrides {
  const out: ForgeTargetOptions & ForgeOverrides = {};
  const forge = set(flags.forge);
  if (forge !== undefined) {
    if (!(FORGE_KINDS as readonly string[]).includes(forge)) throw new ForgeFlagError("--forge", `--forge must be one of ${FORGE_KINDS.join(", ")}, got ${JSON.stringify(flags.forge)}`);
    out.kind = forge as ForgeKind;
  }
  const repo = set(flags.repo);
  if (repo !== undefined) out.repo = repo;
  if (flags.pr !== undefined && String(flags.pr).trim() !== "") {
    const pr = String(flags.pr).trim();
    if (!/^[1-9]\d*$/.test(pr)) throw new ForgeFlagError("--pr", `--pr must be a pull request number, got ${JSON.stringify(flags.pr)}`);
    out.pr = Number(pr);
  }
  for (const [flag, key] of [["--api-url", "apiUrl"], ["--url", "url"]] as const) {
    const v = set(flags[key]);
    if (v === undefined) continue;
    if (!/^https?:\/\/[^/\s]+/i.test(v)) throw new ForgeFlagError(flag, `${flag} must be an http or https URL, got ${JSON.stringify(flags[key])}`);
    out[key] = v;
  }
  const tokenEnv = set(flags.tokenEnv);
  if (tokenEnv !== undefined) out.tokenEnv = tokenEnv;
  return out;
}

/**
 * Where a command posts: {@link forgeTargetWith} with the checked flags.
 * `opts` carries the rest (`requirePr`, `tokenOptional`, `readFile`). A
 * forge neither `--forge` nor the environment names throws
 * {@link ForgeEnvironmentError} with no kind; a missing piece throws it with
 * the pieces, and {@link forgeFlagHints} names the flags that supply them.
 */
export function forgeTargetFromFlags(
  flags: ForgeFlags,
  env: Record<string, string | undefined> = process.env,
  opts: Pick<ForgeTargetOptions, "requirePr" | "readFile"> & Pick<ForgeOverrides, "tokenOptional"> = {},
): ForgeTarget {
  const fromFlags = forgeTargetOptionsFromFlags(flags);
  const token = set(flags.token);
  if (token === undefined) return forgeTargetWith(env, { ...opts, ...fromFlags });
  // The token came from the product, not a variable; say so rather than name chant's.
  const t = forgeTargetWith({ ...env, [GIVEN_TOKEN]: token }, { ...opts, ...fromFlags, tokenEnv: GIVEN_TOKEN });
  return { ...t, tokenSource: "the token given" };
}

/**
 * {@link forgeTargetFromFlags}, or undefined where it would throw
 * {@link ForgeEnvironmentError} (#4888): the environment names no forge, or
 * lacks the repository or the token. For a product step that does its
 * forge work only when the job can, as terragucci's own `targetFromEnv`
 * did: give the token the product holds as `token`, the one variable to
 * read as `tokenEnv`, and `tokenOptional` for a read a public repository
 * answers with none.
 */
export function jobForgeTarget(
  flags: ForgeFlags,
  env: Record<string, string | undefined> = process.env,
  opts: Pick<ForgeTargetOptions, "requirePr" | "readFile"> & Pick<ForgeOverrides, "tokenOptional"> = {},
): ForgeTarget | undefined {
  try {
    return forgeTargetFromFlags(flags, env, opts);
  } catch (err) {
    if (err instanceof ForgeEnvironmentError) return undefined;
    throw err;
  }
}

/**
 * The flags that would supply what a {@link ForgeEnvironmentError} says is
 * missing, for a product's message: `outside CI pass --repo, --pr and
 * --api-url` and `name another token variable with --token-env`.
 */
export function forgeFlagHints(e: ForgeEnvironmentError, options: { requirePr?: boolean; tokenEnv?: boolean } = {}): string[] {
  const token = e.missing.some((m) => m.startsWith("a token"));
  const other = e.kind === undefined || e.missing.some((m) => !m.startsWith("a token"));
  return [
    ...(other ? [`outside CI pass ${e.kind === undefined ? "--forge github|gitlab|forgejo, " : ""}${options.requirePr ? "--repo, --pr and --api-url" : "--repo and --api-url"}`] : []),
    ...(token && !options.tokenEnv ? ["name another token variable with --token-env"] : []),
  ];
}
