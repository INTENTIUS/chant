/**
 * Pulumi Cloud's side of the check (#4608, for #4549's identities): the
 * organization has the forge registered as an OIDC issuer, and the issuer's
 * authorization policies give each token the contract names to its jobs
 * and to no other subject.
 *
 * Two reads per organization, both GETs with `Authorization: token
 * <PULUMI_ACCESS_TOKEN>`, as Pulumi Cloud's REST API documents them:
 *
 *   GET <apiUrl>/api/orgs/<org>/oidc/issuers
 *       { oidcIssuers: [{ id, name, url, ... }] }
 *   GET <apiUrl>/api/orgs/<org>/auth/policies/oidcissuers/<issuer id>
 *       { policies: [{ decision, tokenType, teamName, userLogin,
 *                      authorizedPermissions, rules: { sub, aud, ... } }] }
 *
 * A policy grants a token when its decision is `allow` and its token type
 * (and team, user, or the organization's admin permission) is the
 * identity's: `team:<name>`, `user:<login>`, `organization`,
 * `organization:admin` (`pulumiTokenRequest` in ../ci-identity.ts). Its
 * rules are claim values, where `*` stands for any text. A grant must admit
 * each job that takes the token, and each grant's `sub` must be within some
 * such job's subject. A grant with no `sub` rule admits any subject.
 *
 * The shapes follow Pulumi's documentation and are tested against a
 * loopback fake only; no real organization has been read.
 */

import type { ForgeFetch } from "../pr-forge";
import type { ForgeCheckContract, JobToken } from "./contract";
import { ReadOnlyError } from "./read-only";
import { admits, hasWildcard, within, type LiveValue } from "./trust";
import { SCOPES, unique, type CheckRow, type CheckStatus, type ForgeCheckDeps } from "./types";

/** The variable holding a Pulumi access token that can read the organization's issuers. */
export const PULUMI_TOKEN_ENV = "PULUMI_ACCESS_TOKEN";

const DEFAULT_API = "https://api.pulumi.com";

interface PulumiIssuer {
  id: string;
  name?: string;
  url?: string;
  issuer?: string;
}

interface PulumiPolicy {
  decision?: string;
  tokenType?: string;
  teamName?: string;
  userLogin?: string;
  authorizedPermissions?: string[];
  rules?: Record<string, unknown>;
}

/** Whether a policy grants the token `identity` names; false for an identity Pulumi Cloud has no token for. */
export function policyGrants(p: PulumiPolicy, identity: string): boolean {
  if ((p.decision ?? "").toLowerCase() !== "allow") return false;
  const m = /^(team|user):(.+)$/.exec(identity);
  if (m?.[1] === "team") return p.tokenType === "team" && p.teamName === m[2];
  if (m?.[1] === "user") return p.tokenType === "personal" && p.userLogin === m[2];
  if (identity === "organization") return p.tokenType === "organization" && !(p.authorizedPermissions ?? []).includes("admin");
  if (identity === "organization:admin") return p.tokenType === "organization" && (p.authorizedPermissions ?? []).includes("admin");
  return false;
}

const ruleValues = (rules: Record<string, unknown> | undefined, claim: string): LiveValue[] | null => {
  const v = rules?.[claim];
  if (v === undefined) return null;
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return list.map((value) => ({ value, like: hasWildcard(value) }));
};

const sameIssuer = (a: string | undefined, b: string): boolean => a !== undefined && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

interface TokenJobs {
  organization: string;
  api: string;
  audience: string;
  /** Each token identity, with the tokens of the jobs that take it. */
  tokens: Map<string, JobToken[]>;
}

/** Each organization the contract's jobs trade in, keyed by API and organization. */
function organizationsOf(c: ForgeCheckContract): TokenJobs[] {
  const out = new Map<string, TokenJobs>();
  for (const j of c.jobs) {
    if (!j.pulumi) continue;
    const api = (j.pulumi.apiUrl ?? DEFAULT_API).replace(/\/+$/, "");
    const key = `${api} ${j.pulumi.organization}`;
    const org = out.get(key) ?? { organization: j.pulumi.organization, api, audience: j.pulumi.audience, tokens: new Map<string, JobToken[]>() };
    for (const t of j.pulumi.tokens) {
      const have = org.tokens.get(t) ?? [];
      if (!have.some((h) => h.subject === j.token.subject && h.issuer === j.token.issuer)) have.push(j.token);
      org.tokens.set(t, have);
    }
    out.set(key, org);
  }
  return [...out.values()];
}

async function getJson<T>(fetch: ForgeFetch, url: string, token: string): Promise<{ ok: true; value: T } | { ok: false; status: number | undefined; why: string }> {
  try {
    const res = await fetch(url, { method: "GET", headers: { authorization: `token ${token}`, accept: "application/vnd.pulumi+8" } });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, why: text.slice(0, 300) };
    return { ok: true, value: JSON.parse(text) as T };
  } catch (e) {
    if (e instanceof ReadOnlyError) throw e;
    return { ok: false, status: undefined, why: (e as Error).message };
  }
}

export async function pulumiRows(c: ForgeCheckContract, fetch: ForgeFetch, deps: ForgeCheckDeps): Promise<CheckRow[]> {
  const orgs = organizationsOf(c);
  if (!orgs.length) return [];
  const token = deps.env[PULUMI_TOKEN_ENV];
  const rows: CheckRow[] = [];
  for (const org of orgs) {
    const issuers = unique([...org.tokens.values()].flat().map((t) => t.issuer));
    const trustRow = (identity: string, expected: string, found: string, status: CheckStatus): number => rows.push({ where: "pulumi", check: "trust", subject: `${org.organization} ${identity}`, expected, found, status });
    const expectedOf = (jobs: JobToken[]): string => jobs.map((t) => `sub ${t.subject}${t.pattern ? " (like)" : ""}`).join("; ");
    if (!token) {
      for (const issuer of issuers) rows.push({ where: "pulumi", check: "oidc-issuer", subject: `${org.organization} ${issuer}`, expected: "registered", found: `not checked: no Pulumi Cloud credentials (${PULUMI_TOKEN_ENV})`, status: "not-checked" });
      for (const [identity, jobs] of org.tokens) trustRow(identity, expectedOf(jobs), `not checked: no Pulumi Cloud credentials (${PULUMI_TOKEN_ENV})`, "not-checked");
      continue;
    }
    const base = `${org.api}/api/orgs/${encodeURIComponent(org.organization)}`;
    const list = await getJson<{ oidcIssuers?: PulumiIssuer[] }>(fetch, `${base}/oidc/issuers`, token);
    const registered = new Map<string, PulumiIssuer>();
    for (const issuer of issuers) {
      const subject = `${org.organization} ${issuer}`;
      if (!list.ok) {
        rows.push({ where: "pulumi", check: "oidc-issuer", subject, expected: "registered", found: `could not read (${list.status ?? "no answer"}); ${SCOPES.pulumi}`, status: "unknown" });
        continue;
      }
      const found = (list.value.oidcIssuers ?? []).find((i) => sameIssuer(i.url, issuer) || sameIssuer(i.issuer, issuer));
      if (found) registered.set(issuer, found);
      rows.push({ where: "pulumi", check: "oidc-issuer", subject, expected: "registered", found: found ? `registered as ${found.name ?? found.id}` : "not registered", status: found ? "match" : "mismatch" });
    }
    const policies = new Map<string, { ok: true; value: PulumiPolicy[] } | { ok: false; why: string }>();
    for (const [issuer, i] of registered) {
      const r = await getJson<{ policies?: PulumiPolicy[] }>(fetch, `${base}/auth/policies/oidcissuers/${encodeURIComponent(i.id)}`, token);
      policies.set(issuer, r.ok ? { ok: true, value: r.value.policies ?? [] } : { ok: false, why: `could not read (${r.status ?? "no answer"}); ${SCOPES.pulumi}` });
    }
    for (const [identity, jobs] of org.tokens) {
      const expected = expectedOf(jobs);
      const problems: string[] = [];
      const seen: string[] = [];
      let unread: string | undefined;
      let unregistered = false;
      for (const issuer of unique(jobs.map((t) => t.issuer))) {
        const mine = jobs.filter((t) => t.issuer === issuer);
        const p = policies.get(issuer);
        if (!p) {
          if (list.ok) unregistered = true;
          else unread = `could not read the issuers; ${SCOPES.pulumi}`;
          continue;
        }
        if (!p.ok) {
          unread = p.why;
          continue;
        }
        const grants = p.value.filter((x) => policyGrants(x, identity));
        for (const g of grants) {
          const subs = ruleValues(g.rules, "sub");
          const auds = ruleValues(g.rules, "aud");
          seen.push(`sub ${subs === null ? "any" : subs.map((s) => s.value).join(" | ")}${auds ? ` aud ${auds.map((a) => a.value).join(" | ")}` : ""}`);
          if (subs === null) {
            problems.push(`a policy grants ${identity} with no sub rule, so it admits any subject of the issuer`);
            continue;
          }
          for (const s of subs) if (!mine.some((t) => within(s, t.subject, t.pattern))) problems.push(`grants ${identity} to sub ${s.value}${s.like ? " (like)" : ""}, which no job that takes it presents`);
          if (auds) for (const a of auds) if (!within(a, org.audience, false)) problems.push(`grants ${identity} to aud ${a.value}, not ${org.audience}`);
        }
        for (const t of mine) {
          const ok = grants.some((g) => {
            const subs = ruleValues(g.rules, "sub");
            const auds = ruleValues(g.rules, "aud");
            return (subs === null || subs.some((s) => admits(s, t.subject, t.pattern))) && (auds === null || auds.some((a) => admits(a, org.audience, false)));
          });
          if (!ok) problems.push(`no policy grants ${identity} to sub ${t.subject}${t.pattern ? " (like)" : ""}`);
        }
      }
      const found = seen.length ? seen.join("; ") : "no policy grants it";
      if (problems.length) trustRow(identity, expected, `${found}; ${unique(problems).join("; ")}`, "mismatch");
      else if (unregistered) trustRow(identity, expected, "the forge is not a registered issuer", "mismatch");
      else if (unread) trustRow(identity, expected, unread, "unknown");
      else trustRow(identity, expected, found, "match");
    }
  }
  return rows;
}
