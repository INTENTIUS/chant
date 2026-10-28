/**
 * The clouds' side of the check (#4608), lifted from terragucci's
 * `forge check`:
 *
 *   AWS    each role's trust admits each job the contract names and no
 *          other subject or audience (iam GetRole, Signature Version 4,
 *          signed with chant's one signer, ../cloud-lister/sigv4.ts)
 *   GCP    the workload identity provider's attribute condition is the
 *          contract's or narrower
 *   Azure  each app's federated credentials are the contract's, and no other
 *
 * A cloud with no credentials in the environment gets `not-checked` rows.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AwsStaticCredentials } from "../cloud-lister/credentials";
import { sha256Hex, signV4 } from "../cloud-lister/sigv4";
import { encodeStrict, xmlText } from "../object-store/common";
import type { ForgeFetch } from "../pr-forge";
import type { ForgeCheckContract, JobToken } from "./contract";
import { ReadOnlyError } from "./read-only";
import { SCOPES, unique, type CheckRow, type CheckStatus, type ForgeCheckDeps } from "./types";

// ── AWS ──────────────────────────────────────────────────────────────────────

/** Static credentials from the environment, or from the shared credentials file's profile (AWS_PROFILE, else default). */
export function awsCredentials(env: Record<string, string | undefined>, readFile: (path: string) => string | undefined): AwsStaticCredentials | undefined {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  const file = env.AWS_SHARED_CREDENTIALS_FILE || join(env.HOME || homedir(), ".aws", "credentials");
  const text = readFile(file);
  if (!text) return undefined;
  const profile = env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || "default";
  let section = "";
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) section = head[1]!.trim();
    else if (section === profile) {
      const m = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) kv[m[1]!.toLowerCase()] = m[2]!;
    }
  }
  if (!kv.aws_access_key_id || !kv.aws_secret_access_key) return undefined;
  return { accessKeyId: kv.aws_access_key_id, secretAccessKey: kv.aws_secret_access_key, ...(kv.aws_session_token ? { sessionToken: kv.aws_session_token } : {}) };
}

/** IAM's endpoint and signing region for a role's partition. */
function iamEndpoint(partition: string, env: Record<string, string | undefined>): { url: string; region: string } {
  const region = partition === "aws-cn" ? "cn-north-1" : partition === "aws-us-gov" ? "us-gov-west-1" : "us-east-1";
  const url = env.AWS_ENDPOINT_URL_IAM || (partition === "aws-cn" ? "https://iam.cn-north-1.amazonaws.com.cn" : partition === "aws-us-gov" ? "https://iam.us-gov.amazonaws.com" : "https://iam.amazonaws.com");
  return { url: url.replace(/\/+$/, ""), region };
}

/** One job a trust must admit: the token's provider (the issuer without https://), `sub` (a pattern with `like`) and `aud`. */
export interface TrustJob {
  provider: string;
  sub: string;
  like: boolean;
  aud: string;
}

/** The issuer as AWS names its OIDC provider and condition keys: the URL without its scheme. */
export const issuerKey = (issuer: string): string => issuer.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** The trust job a token and audience make. */
export const trustJob = (token: JobToken, aud: string): TrustJob => ({ provider: issuerKey(token.issuer), sub: token.subject, like: token.pattern, aud });

/** The partition and account of an IAM role ARN; placeholders when `arn` is not one. */
function arnParts(arn: string | undefined): { partition: string; account: string } {
  const m = arn?.match(/^arn:([^:]+):iam::(\d{12}):/);
  return m ? { partition: m[1]!, account: m[2]! } : { partition: "aws", account: "<account-id>" };
}

/**
 * An IAM role's trust policy for the jobs that take it, as a JSON string: a
 * statement per job, AssumeRoleWithWebIdentity from the forge's OIDC
 * provider in the role's account when the token's `aud` and `sub` are that
 * job's (StringLike for a subject pattern). AWS reads no other claim of a
 * GitLab token.
 */
export function awsTrustPolicy(jobs: readonly { token: JobToken; audience: string }[], role?: string): string {
  const { partition, account } = arnParts(role);
  const seen = new Set<string>();
  const statements: unknown[] = [];
  for (const { token, audience } of jobs) {
    const key = issuerKey(token.issuer);
    const condition: Record<string, Record<string, string>> = token.pattern
      ? { StringEquals: { [`${key}:aud`]: audience }, StringLike: { [`${key}:sub`]: token.subject } }
      : { StringEquals: { [`${key}:aud`]: audience, [`${key}:sub`]: token.subject } };
    const statement = { Effect: "Allow", Principal: { Federated: `arn:${partition}:iam::${account}:oidc-provider/${key}` }, Action: "sts:AssumeRoleWithWebIdentity", Condition: condition };
    const id = JSON.stringify(statement);
    if (seen.has(id)) continue;
    seen.add(id);
    statements.push(statement);
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

const asList = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const providerOf = (federated: string): string => (federated === "*" ? "*" : (federated.split(":oidc-provider/")[1] ?? federated));

/** The jobs a trust policy (JSON) names, as {@link awsTrustPolicy} writes them. */
export function trustJobs(policy: string): TrustJob[] {
  const doc = JSON.parse(policy) as { Statement?: { Principal?: { Federated?: string }; Condition?: Record<string, Record<string, string>> }[] };
  return (doc.Statement ?? []).flatMap((st) => {
    const provider = providerOf(st.Principal?.Federated ?? "");
    const eq = st.Condition?.StringEquals ?? {};
    const like = st.Condition?.StringLike ?? {};
    const sub = eq[`${provider}:sub`] ?? like[`${provider}:sub`];
    const aud = eq[`${provider}:aud`];
    return sub === undefined || aud === undefined ? [] : [{ provider, sub, like: eq[`${provider}:sub`] === undefined, aud }];
  });
}

/** IAM's StringLike: `*` any run of characters, `?` one. */
export const likeMatch = (pattern: string, s: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(s);
export const hasWildcard = (s: string): boolean => /[*?]/.test(s);

/** A value a live trust holds, and whether it is a pattern. */
export interface LiveValue {
  value: string;
  like: boolean;
}

/** A live statement's values for `<provider>:<claim>` under StringEquals and StringLike (with ForAnyValue/ForAllValues and IfExists); null when no such condition constrains it. */
function conditionValues(cond: Record<string, Record<string, unknown>> | undefined, provider: string, claim: string): LiveValue[] | null {
  const out: LiveValue[] = [];
  let constrained = false;
  for (const [op, keys] of Object.entries(cond ?? {})) {
    const base = op.replace(/^(ForAnyValue|ForAllValues):/, "").replace(/IfExists$/, "");
    if (base !== "StringEquals" && base !== "StringLike") continue;
    for (const [k, v] of Object.entries(keys ?? {})) {
      if (k.toLowerCase() !== `${provider}:${claim}`.toLowerCase()) continue;
      constrained = true;
      for (const value of asList(v)) out.push({ value, like: base === "StringLike" && hasWildcard(value) });
    }
  }
  return constrained ? out : null;
}

/** Whether a live value admits no token the job's own does not: the same value, a literal the job's pattern matches, or a narrower pattern. */
export function within(v: LiveValue, expected: string, expectedLike: boolean): boolean {
  if (!v.like) return expectedLike ? likeMatch(expected, v.value) : v.value === expected;
  if (!expectedLike) return false;
  if (v.value === expected) return true;
  const prefix = expected.endsWith("*") && !hasWildcard(expected.slice(0, -1)) ? expected.slice(0, -1) : undefined;
  return prefix !== undefined && v.value.startsWith(prefix);
}

/** Whether a live value admits the job's token. */
export function admits(v: LiveValue, expected: string, expectedLike: boolean): boolean {
  if (expectedLike) return v.like && v.value === expected;
  return v.like ? likeMatch(v.value, expected) : v.value === expected;
}

export const describeJob = (j: TrustJob): string => `sub ${j.sub}${j.like ? " (like)" : ""} aud ${j.aud}`;

function asStatements(doc: unknown): { Effect?: string; Action?: unknown; Principal?: unknown; Condition?: Record<string, Record<string, unknown>> }[] {
  const s = (doc as { Statement?: unknown } | null)?.Statement;
  return (Array.isArray(s) ? s : s ? [s] : []) as ReturnType<typeof asStatements>;
}

/**
 * Compare a role's live trust document with the jobs it must admit: each job
 * admitted, and every web identity statement no wider than some job (its
 * provider, each sub and aud pair). Returns the problems and a summary of
 * what the live document admits.
 */
export function compareTrust(doc: unknown, jobs: readonly TrustJob[], account: string | undefined): { problems: string[]; found: string } {
  const problems: string[] = [];
  const seen: string[] = [];
  const live = asStatements(doc).filter((st) => st.Effect === "Allow" && asList(st.Action).some((a) => a === "sts:AssumeRoleWithWebIdentity" || a === "sts:*" || a === "*"));
  type Grant = { provider: string; account?: string; subs: LiveValue[] | null; auds: LiveValue[] | null };
  const grants: Grant[] = live.flatMap((st) => {
    const principal = st.Principal === "*" ? ["*"] : asList((st.Principal as { Federated?: unknown } | undefined)?.Federated);
    return principal.map((f) => {
      const provider = providerOf(f);
      const acct = /^arn:[^:]+:iam::(\d{12}):/.exec(f)?.[1];
      return { provider, ...(acct ? { account: acct } : {}), subs: conditionValues(st.Condition, provider, "sub"), auds: conditionValues(st.Condition, provider, "aud") };
    });
  });
  for (const g of grants) {
    const fmt = (vs: LiveValue[] | null): string => (vs === null ? "any" : vs.map((v) => v.value).join(" | ") || "none");
    seen.push(`${g.provider}: sub ${fmt(g.subs)} aud ${fmt(g.auds)}`);
    const mine = jobs.filter((j) => j.provider === g.provider);
    if (g.provider === "*" || mine.length === 0) {
      problems.push(`trusts ${g.provider === "*" ? "any principal" : `the provider ${g.provider}`}, which no job of this role presents`);
      continue;
    }
    if (account && g.account && g.account !== account) problems.push(`trusts ${g.provider} in account ${g.account}, not the role's ${account}`);
    if (g.subs === null) problems.push(`a statement for ${g.provider} has no sub condition, so it admits any subject`);
    if (g.auds === null) problems.push(`a statement for ${g.provider} has no aud condition, so it admits any audience`);
    if (g.subs === null || g.auds === null) continue;
    for (const s of g.subs) {
      for (const a of g.auds) {
        if (!mine.some((j) => within(s, j.sub, j.like) && within(a, j.aud, false))) problems.push(`admits sub ${s.value}${s.like ? " (like)" : ""} with aud ${a.value}, which no job of this role presents`);
      }
    }
  }
  for (const j of jobs) {
    const ok = grants.some((g) => g.provider === j.provider && (!account || !g.account || g.account === account) && (g.subs === null || g.subs.some((s) => admits(s, j.sub, j.like))) && (g.auds === null || g.auds.some((a) => admits(a, j.aud, false))));
    if (!ok) problems.push(`does not admit ${describeJob(j)}`);
  }
  return { problems: unique(problems), found: seen.length ? seen.join("; ") : "no web identity statement" };
}

function readIfThere(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Every role the contract's jobs take, with the jobs each must admit. */
export function rolesOf(c: ForgeCheckContract): Map<string, TrustJob[]> {
  const roles = new Map<string, TrustJob[]>();
  for (const j of c.jobs) {
    if (!j.aws) continue;
    const job = trustJob(j.token, j.aws.audience);
    for (const arn of j.aws.roles) {
      const have = roles.get(arn) ?? [];
      if (!have.some((h) => JSON.stringify(h) === JSON.stringify(job))) have.push(job);
      roles.set(arn, have);
    }
  }
  return roles;
}

export async function awsRows(c: ForgeCheckContract, fetch: ForgeFetch, deps: ForgeCheckDeps, product = "chant"): Promise<CheckRow[]> {
  const roles = rolesOf(c);
  if (roles.size === 0) return [];
  const creds = awsCredentials(deps.env, deps.readFile ?? readIfThere);
  const rows: CheckRow[] = [];
  for (const [arn, jobs] of roles) {
    const expected = jobs.map(describeJob).join("; ");
    const row = (found: string, status: CheckStatus): number => rows.push({ where: "aws", check: "trust", subject: arn, expected, found, status });
    if (!creds) {
      row("not checked: no AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or a profile with static keys)", "not-checked");
      continue;
    }
    const m = /^arn:([^:]+):iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/.exec(arn);
    if (!m) {
      row("not a role ARN, so it cannot be read", "unknown");
      continue;
    }
    const [, partition, account, name] = m;
    const { url: base, region } = iamEndpoint(partition!, deps.env);
    // A form POST, as the AWS SDKs send it: IAM takes the Query API as GET or POST, and floci answers only POST.
    const url = `${base}/`;
    const body = `Action=GetRole&RoleName=${encodeStrict(name!)}&Version=2010-05-08`;
    const headers = signV4({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, body, payloadHash: sha256Hex(body), region, service: "iam", credentials: creds, now: (deps.now ?? (() => new Date()))() });
    let res: Awaited<ReturnType<ForgeFetch>>;
    try {
      res = await fetch(url, { method: "POST", headers, body });
    } catch (e) {
      if (e instanceof ReadOnlyError) throw e;
      row(`could not read: ${(e as Error).message}`, "unknown");
      continue;
    }
    const xml = await res.text();
    if (!res.ok) {
      const code = xmlText(xml, "Code") ?? String(res.status);
      if (code === "NoSuchEntity") row("no such role", "mismatch");
      else row(`could not read (${res.status} ${code}); ${SCOPES.aws}`, "unknown");
      continue;
    }
    const raw = xmlText(xml, "AssumeRolePolicyDocument");
    let doc: unknown;
    try {
      doc = JSON.parse(decodeURIComponent(raw ?? ""));
    } catch {
      row(`GetRole answered without a trust policy ${product} could read`, "unknown");
      continue;
    }
    const { problems, found } = compareTrust(doc, jobs, account);
    row(problems.length ? `${found}; ${problems.join("; ")}` : found, problems.length ? "mismatch" : "match");
  }
  return rows;
}

// ── GCP ──────────────────────────────────────────────────────────────────────

const cel = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * A Workload Identity Federation provider's attribute condition (CEL over
 * `assertion`, the token's claims) for the jobs that take it: each job's
 * subject, or the subject's prefix for a pattern, and on GitLab its
 * environment, which must be protected, on a protected ref. Several jobs
 * are joined with ||.
 */
export function gcpCondition(tokens: readonly JobToken[]): string {
  const one = (token: JobToken): string => {
    const sub = token.pattern ? `assertion.sub.startsWith(${cel(token.subject.replace(/\*$/, ""))})` : `assertion.sub == ${cel(token.subject)}`;
    const env = token.claims.environment;
    return env === undefined ? sub : `${sub} && assertion.environment == ${cel(env)} && assertion.environment_protected == 'true' && assertion.ref_protected == 'true'`;
  };
  const each = unique(tokens.map(one));
  return each.length === 1 ? each[0]! : each.map((c) => `(${c})`).join(" || ");
}

/** A CEL expression in disjunctive normal form: each term a set of conjuncts, compared as text without spaces outside quotes. Undefined past `limit` terms. */
export function celTerms(expr: string, limit = 256): string[][] | undefined {
  const norm = (s: string): string => {
    let out = "";
    let q: string | undefined;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (q) {
        out += ch;
        if (ch === "\\") out += s[++i] ?? "";
        else if (ch === q) q = undefined;
      } else if (ch === "'" || ch === '"') {
        q = ch;
        out += "'";
      } else if (!/\s/.test(ch)) out += ch;
    }
    return out.replace(/"/g, "'");
  };
  const split = (s: string, op: "&&" | "||"): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let q: string | undefined;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (q) {
        if (ch === "\\") i++;
        else if (ch === q) q = undefined;
      } else if (ch === "'" || ch === '"') q = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0 && s.startsWith(op, i)) {
        parts.push(s.slice(start, i));
        start = i + 2;
        i++;
      }
    }
    parts.push(s.slice(start));
    return parts.map((p) => p.trim());
  };
  const strip = (s: string): string => {
    let t = s.trim();
    while (t.startsWith("(") && t.endsWith(")")) {
      // Only when the outer parentheses wrap the whole expression.
      let depth = 0;
      let whole = true;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === "(") depth++;
        else if (t[i] === ")") depth--;
        if (depth === 0 && i < t.length - 1) {
          whole = false;
          break;
        }
      }
      if (!whole) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  };
  const dnf = (s: string): string[][] | undefined => {
    const e = strip(s);
    const ors = split(e, "||");
    if (ors.length > 1) {
      const out: string[][] = [];
      for (const o of ors) {
        const d = dnf(o);
        if (!d) return undefined;
        out.push(...d);
      }
      return out.length > limit ? undefined : out;
    }
    const ands = split(e, "&&");
    if (ands.length === 1) return [[norm(e)]];
    let out: string[][] = [[]];
    for (const a of ands) {
      const d = dnf(a);
      if (!d) return undefined;
      out = out.flatMap((t) => d.map((u) => [...t, ...u]));
      if (out.length > limit) return undefined;
    }
    return out;
  };
  return dnf(expr);
}

/** Whether `live` admits no token `expected` refuses: each of its terms holds every conjunct of some term of `expected`. */
export function celNarrowerOrEqual(live: string, expected: string): boolean {
  const l = celTerms(live);
  const e = celTerms(expected);
  if (!l || !e) return false;
  return l.every((lt) => e.some((et) => et.every((c) => lt.includes(c))));
}

export async function gcpRows(c: ForgeCheckContract, fetch: ForgeFetch, deps: ForgeCheckDeps): Promise<CheckRow[]> {
  const providers = new Map<string, JobToken[]>();
  for (const j of c.jobs) {
    if (!j.gcp) continue;
    const have = providers.get(j.gcp.provider) ?? [];
    have.push(j.token);
    providers.set(j.gcp.provider, have);
  }
  const token = deps.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const origin = (deps.endpoints?.gcpIam ?? "https://iam.googleapis.com").replace(/\/+$/, "");
  const rows: CheckRow[] = [];
  for (const [name, tokens] of providers) {
    const expected = gcpCondition(tokens);
    const row = (found: string, status: CheckStatus): number => rows.push({ where: "gcp", check: "trust", subject: name, expected: `${expected}, or narrower`, found, status });
    if (!token) {
      row("not checked: no GCP credentials (GOOGLE_OAUTH_ACCESS_TOKEN)", "not-checked");
      continue;
    }
    if (!/^projects\/[^/]+\/locations\/[^/]+\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(name)) {
      row("not a provider's full resource name, so it cannot be read", "unknown");
      continue;
    }
    let res: Awaited<ReturnType<ForgeFetch>>;
    try {
      res = await fetch(`${origin}/v1/${name}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (e) {
      if (e instanceof ReadOnlyError) throw e;
      row(`could not read: ${(e as Error).message}`, "unknown");
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404) row("no such provider", "mismatch");
      else row(`could not read (${res.status}); ${SCOPES.gcp}`, "unknown");
      continue;
    }
    let live: string | undefined;
    try {
      live = (JSON.parse(text) as { attributeCondition?: string }).attributeCondition;
    } catch {
      row("the provider's answer is not JSON", "unknown");
      continue;
    }
    if (!live) row("no attribute condition: any token of the issuer", "mismatch");
    else if (celNarrowerOrEqual(live, expected)) row(celNarrowerOrEqual(expected, live) ? live : `${live} (narrower)`, "match");
    else row(`${live} (wider, or not provably narrower)`, "mismatch");
  }
  return rows;
}

// ── Azure ────────────────────────────────────────────────────────────────────

/** The variable holding a Microsoft Graph access token. */
export const AZURE_GRAPH_TOKEN_ENV = "AZURE_GRAPH_TOKEN";

export interface FederatedCredential {
  issuer: string;
  subject: string | null;
  expression: string | null;
  audiences: string[];
}

const credentialText = (x: FederatedCredential): string => `issuer ${x.issuer} ${x.subject !== null ? `subject ${x.subject}` : `claims ${x.expression}`} aud ${x.audiences.join(", ")}`;
const sameCredential = (a: FederatedCredential, b: FederatedCredential): boolean =>
  a.issuer === b.issuer && a.subject === b.subject && a.expression === b.expression && [...a.audiences].sort().join("\n") === [...b.audiences].sort().join("\n");

/** The federated credential a job's token needs: its subject, or for a pattern an Entra flexible credential's expression. */
export function federatedCredential(token: JobToken, audience: string): FederatedCredential {
  return { issuer: token.issuer, subject: token.pattern ? null : token.subject, expression: token.pattern ? `claims['sub'] matches ${cel(token.subject)}` : null, audiences: [audience] };
}

export async function azureRows(c: ForgeCheckContract, fetch: ForgeFetch, deps: ForgeCheckDeps): Promise<CheckRow[]> {
  const apps = new Map<string, FederatedCredential[]>();
  for (const j of c.jobs) {
    if (!j.azure) continue;
    const cred = federatedCredential(j.token, j.azure.audience);
    for (const id of j.azure.clientIds) {
      const have = apps.get(id) ?? [];
      if (!have.some((h) => sameCredential(h, cred))) have.push(cred);
      apps.set(id, have);
    }
  }
  const token = deps.env[AZURE_GRAPH_TOKEN_ENV];
  const origin = (deps.endpoints?.graph ?? "https://graph.microsoft.com").replace(/\/+$/, "");
  const rows: CheckRow[] = [];
  for (const [id, creds] of apps) {
    const row = (found: string, status: CheckStatus): number => rows.push({ where: "azure", check: "trust", subject: id, expected: creds.map(credentialText).join("; "), found, status });
    if (!token) {
      row(`not checked: no Azure credentials (${AZURE_GRAPH_TOKEN_ENV})`, "not-checked");
      continue;
    }
    let res: Awaited<ReturnType<ForgeFetch>>;
    try {
      res = await fetch(`${origin}/v1.0/applications(appId='${encodeURIComponent(id)}')/federatedIdentityCredentials`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    } catch (e) {
      if (e instanceof ReadOnlyError) throw e;
      row(`could not read: ${(e as Error).message}`, "unknown");
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 404) row("no application with this appId (a managed identity's credentials are not read)", "unknown");
      else row(`could not read (${res.status}); ${SCOPES.azure}`, "unknown");
      continue;
    }
    type Live = { name?: string; issuer?: string; subject?: string | null; audiences?: string[]; claimsMatchingExpression?: string | { value?: string } | null };
    let value: Live[];
    try {
      value = (JSON.parse(text) as { value?: Live[] }).value ?? [];
    } catch {
      row("Microsoft Graph's answer is not JSON", "unknown");
      continue;
    }
    const live = value.map((v) => ({
      name: v.name ?? "",
      cred: {
        issuer: v.issuer ?? "",
        subject: v.subject ?? null,
        expression: typeof v.claimsMatchingExpression === "string" ? v.claimsMatchingExpression : (v.claimsMatchingExpression?.value ?? null),
        audiences: v.audiences ?? [],
      },
    }));
    const missing = creds.filter((e) => !live.some((l) => sameCredential(l.cred, e)));
    const extra = live.filter((l) => !creds.some((e) => sameCredential(l.cred, e)));
    const problems = [...missing.map((m) => `missing ${credentialText(m)}`), ...extra.map((x) => `wider: ${x.name ? `${x.name}: ` : ""}${credentialText(x.cred)}`)];
    const found = live.length ? live.map((l) => credentialText(l.cred)).join("; ") : "no federated credential";
    row(problems.length ? `${found}; ${problems.join("; ")}` : found, problems.length ? "mismatch" : "match");
  }
  return rows;
}
