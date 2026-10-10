/**
 * Approval modes for a gate (#3684): which approvals of a wave's digest
 * count.
 *
 * - `ledger` (the default): any resolution on `chant/lifecycle` that names
 *   the digest, as `chant approve` writes it. Anyone who can push to the
 *   branch can approve, in anyone's name.
 * - `sealed`: a resolution counts only when its seal (`chant approve --sign`)
 *   verifies against the signers file read at the base commit, for the
 *   approver it names. A key that the change being applied adds to the
 *   signers file is not at base, so it cannot approve that change.
 * - `pr-review`: a resolution counts as under `ledger`, and so does the
 *   forge review of the pull request that merged the applied commit: an
 *   approving review of the pull request's head, by a writer other than its
 *   author. It approves the digest that head planned, which the pull
 *   request's pipeline records on `chant/lifecycle` with `chant run wave
 *   --record-plans` ({@link HeadPlans}). A plan that moved after the review
 *   waits for a `chant approve` of the new digest.
 *
 * What counts as an approving review, per forge:
 *
 * | Forge | Counts | Writer |
 * |---|---|---|
 * | GitHub | the reviewer's newest deciding review is `APPROVED` and names the head (`commit_id`) | `GET /repos/{repo}/collaborators/{login}/permission` is `admin`, `maintain` or `write` |
 * | Forgejo | the same, not dismissed and not stale | the review is `official`, which Forgejo sets for a reviewer with write access |
 * | GitLab | the merge request's approvals, when the project removes approvals on a new push (`reset_approvals_on_push`), since a GitLab approval names no commit | the approver's access level is Developer (30) or higher |
 *
 * A standing review that requests changes, from a writer, holds the review
 * back. The author's own review never counts.
 */

import { readFileSync } from "node:fs";
import { checkGateSeal } from "../workspace/trust/seal";
import { readTrustPolicy, type TrustPolicy } from "../workspace/trust/policy";
import { gitRevisionSource } from "../workspace/record-source";
import { forgePrincipalOf, ForgeApiError, type ForgeFetch, type ForgeKind } from "../pr-forge";
import type { GateResolutionRecord } from "../lifecycle/gate-ledger";
import type { GateApprovalRule } from "./gate";

export { GATE_APPROVAL_SOURCES, type GateApprovalSource } from "./op-waves";

// ── sealed ────────────────────────────────────────────────────────────────

/** The signers policy at `base`, read from the repository at `cwd`. */
export function trustPolicyAt(cwd: string, base: string): TrustPolicy {
  return readTrustPolicy(gitRevisionSource(cwd, base), base);
}

/**
 * The rule a `sealed` gate judges approvals by: a seal that verifies for the
 * approver against `policy`, the signers at base. With no signers file at
 * base nothing verifies, so nothing passes the gate.
 */
export function sealedApprovalRule(gate: string, policy: TrustPolicy): GateApprovalRule {
  return {
    requirement: { gate, class: null },
    refuses(approval: GateResolutionRecord): string | null {
      if (!policy.active) {
        return `the gate is sealed, and there is no signers file (${policy.signersPath}) at base ${policy.base?.slice(0, 12) ?? ""}`.trim();
      }
      const check = checkGateSeal(policy, approval);
      return check.attested === true ? null : check.message;
    },
  };
}

/** Both rules at once: an approval counts only when neither refuses it. */
export function bothRules(a: GateApprovalRule | null, b: GateApprovalRule | null): GateApprovalRule | null {
  if (!a) return b;
  if (!b) return a;
  return { requirement: a.requirement, refuses: (r) => a.refuses(r) ?? b.refuses(r) };
}

// ── pr-review ─────────────────────────────────────────────────────────────

/** The digests each wave planned at one commit, recorded for a review of it to approve. */
export interface HeadPlans {
  version: 1;
  /** The Op waves spec's name. */
  name: string;
  /** The commit the waves were planned at: a pull request's head. */
  head: string;
  timestamp: string;
  waves: Array<{ wave: number; name: string; digest: string }>;
}

/** Where {@link HeadPlans} for `head` live on `chant/lifecycle`: `_wave-plans/<name>/<head>.json`. */
export const HEAD_PLANS_DIR = "_wave-plans";

export function headPlansPath(name: string, head: string): { dir: string; file: string } {
  return { dir: `${HEAD_PLANS_DIR}/${name}`, file: `${head}.json` };
}

/** The merged pull request's review, as a `pr-review` gate reads it. */
export interface MergedReview {
  pr: number;
  url?: string;
  /** The author, as a principal (`github:<login>`). */
  author: string;
  /** The pull request's head commit. */
  head: string;
  /** Writers other than the author whose approval of the head stands, as principals. */
  approvers: string[];
  /** Why a review did not count, one line each. */
  refused: string[];
}

/** What a `pr-review` gate asks of the forge. */
export interface ReviewSource {
  kind: ForgeKind;
  /** The merged pull request whose merge produced `sha`, with its review, or null when none did. */
  mergedReview(sha: string): Promise<MergedReview | null>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const trimSlash = (s: string): string => s.replace(/\/+$/, "");

function client(base: string, headers: Record<string, string>, fetchImpl: ForgeFetch) {
  return async (path: string): Promise<unknown> => {
    const url = `${trimSlash(base)}${path}`;
    const res = await fetchImpl(url, { method: "GET", headers });
    const text = await res.text();
    if (!res.ok) throw new ForgeApiError("GET", url, res.status, text);
    return text ? JSON.parse(text) : null;
  };
}

const hostOf = (url: string | undefined, fallback: string): string => {
  try {
    return url ? new URL(url).host.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
};

export interface ReviewSourceOptions {
  apiBase: string;
  /** `owner/name` on GitHub and Forgejo, the project id on GitLab. */
  repo: string;
  token: string;
  /** The forge's host, for naming people. */
  host: string;
  fetch?: ForgeFetch;
}

/** GitHub or Forgejo, which share the pull request and review shapes. */
function githubShapedReviews(kind: "github" | "forgejo", opts: ReviewSourceOptions): ReviewSource {
  const get = client(
    opts.apiBase,
    kind === "github"
      ? { Authorization: `Bearer ${opts.token}`, Accept: "application/vnd.github+json" }
      : { Authorization: `token ${opts.token}`, Accept: "application/json" },
    opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch),
  );
  const repo = `/repos/${opts.repo}`;
  const who = (login: string) => forgePrincipalOf(kind, opts.host, login);
  const page = kind === "github" ? "per_page=100" : "limit=50";
  async function prFor(sha: string): Promise<number | null> {
    if (kind === "forgejo") {
      try {
        const pr = await get(`${repo}/commits/${sha}/pull`);
        return isObject(pr) && typeof pr.number === "number" ? pr.number : null;
      } catch (err) {
        if (err instanceof ForgeApiError && err.status === 404) return null;
        throw err;
      }
    }
    const prs = await get(`${repo}/commits/${sha}/pulls`);
    if (!Array.isArray(prs)) return null;
    const merged = prs.filter((p) => isObject(p) && p.merged_at);
    const pick = (merged.find((p) => isObject(p) && p.merge_commit_sha === sha) ?? merged[0]) as Record<string, unknown> | undefined;
    return pick && typeof pick.number === "number" ? pick.number : null;
  }
  async function writer(login: string): Promise<boolean> {
    const p = await get(`${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    return isObject(p) && ["admin", "maintain", "write", "owner"].includes(String(p.role_name ?? p.permission));
  }
  return {
    kind,
    async mergedReview(sha) {
      const number = await prFor(sha);
      if (number === null) return null;
      const pr = await get(`${repo}/pulls/${number}`);
      if (!isObject(pr) || !isObject(pr.user) || !isObject(pr.head)) throw new Error(`pull request #${number} came back without its author or head`);
      const authorLogin = String(pr.user.login);
      const head = String(pr.head.sha);
      const reviews = await get(`${repo}/pulls/${number}/reviews?${page}`);
      // A reviewer's newest deciding review is their standing one.
      const standing = new Map<string, Record<string, unknown>>();
      for (const r of Array.isArray(reviews) ? reviews : []) {
        if (!isObject(r) || !isObject(r.user) || typeof r.state !== "string") continue;
        const state = r.state.toUpperCase();
        if (state === "COMMENTED" || state === "COMMENT" || state === "PENDING") continue;
        standing.set(String(r.user.login), r);
      }
      const approvers: string[] = [];
      const refused: string[] = [];
      let changesRequested = false;
      for (const [login, r] of standing) {
        const state = r.dismissed === true ? "DISMISSED" : String(r.state).toUpperCase();
        if (login.toLowerCase() === authorLogin.toLowerCase()) {
          if (state === "APPROVED") refused.push(`${who(login)} is the author, whose own review never counts`);
          continue;
        }
        const isWriter = kind === "forgejo" ? r.official === true : await writer(login);
        if (state === "REQUEST_CHANGES" || state === "CHANGES_REQUESTED") {
          if (isWriter) changesRequested = true;
          refused.push(`${who(login)} requests changes`);
          continue;
        }
        if (state !== "APPROVED") continue;
        if (!isWriter) refused.push(`${who(login)} approved without write access${kind === "forgejo" ? " (the review is not official)" : ""}`);
        else if (r.commit_id !== head || r.stale === true) refused.push(`${who(login)} approved ${String(r.commit_id ?? "another commit").slice(0, 12)}, not the head ${head.slice(0, 12)}`);
        else approvers.push(who(login));
      }
      return {
        pr: number,
        ...(typeof pr.html_url === "string" ? { url: pr.html_url } : {}),
        author: who(authorLogin),
        head,
        approvers: changesRequested ? [] : approvers.sort(),
        refused,
      };
    },
  };
}

/** A GitHub reader of pull request reviews. The token needs `pull-requests: read`. */
export function githubReviews(opts: ReviewSourceOptions): ReviewSource {
  return githubShapedReviews("github", opts);
}

/** A Forgejo (or Gitea) reader of pull request reviews. */
export function forgejoReviews(opts: ReviewSourceOptions): ReviewSource {
  return githubShapedReviews("forgejo", opts);
}

/** A GitLab reader of merge request approvals. The token needs `read_api`. */
export function gitlabReviews(opts: ReviewSourceOptions): ReviewSource {
  const get = client(opts.apiBase, { "PRIVATE-TOKEN": opts.token }, opts.fetch ?? (globalThis.fetch as unknown as ForgeFetch));
  const project = `/projects/${encodeURIComponent(decodeURIComponent(opts.repo))}`;
  const who = (login: string) => forgePrincipalOf("gitlab", opts.host, login);
  return {
    kind: "gitlab",
    async mergedReview(sha) {
      const mrs = await get(`${project}/repository/commits/${sha}/merge_requests`);
      const merged = Array.isArray(mrs)
        ? mrs.find((m) => isObject(m) && m.state === "merged" && (m.merge_commit_sha === sha || m.squash_commit_sha === sha)) ??
          mrs.find((m) => isObject(m) && m.state === "merged")
        : undefined;
      if (!isObject(merged) || typeof merged.iid !== "number") return null;
      const iid = merged.iid;
      const author = isObject(merged.author) ? String(merged.author.username) : "";
      const head = String(merged.sha);
      const settings = await get(`${project}/approvals`);
      const resets = isObject(settings) && settings.reset_approvals_on_push === true;
      const approvals = await get(`${project}/merge_requests/${iid}/approvals`);
      const by = isObject(approvals) && Array.isArray(approvals.approved_by) ? approvals.approved_by : [];
      const approvers: string[] = [];
      const refused: string[] = [];
      for (const a of by) {
        const user = isObject(a) && isObject(a.user) ? a.user : undefined;
        if (!user || typeof user.username !== "string") continue;
        const login = user.username;
        if (login.toLowerCase() === author.toLowerCase()) {
          refused.push(`${who(login)} is the author, whose own approval never counts`);
          continue;
        }
        if (!resets) {
          refused.push(`${who(login)}'s approval names no commit, and the project keeps approvals after a new push (turn on "Remove all approvals when commits are added")`);
          continue;
        }
        const member = await get(`${project}/members/all/${String(user.id)}`).catch((err) => {
          if (err instanceof ForgeApiError && err.status === 404) return null;
          throw err;
        });
        if (!isObject(member) || typeof member.access_level !== "number" || member.access_level < 30) {
          refused.push(`${who(login)} approved without the Developer role`);
          continue;
        }
        approvers.push(who(login));
      }
      return {
        pr: iid,
        ...(typeof merged.web_url === "string" ? { url: merged.web_url } : {}),
        author: who(author),
        head,
        approvers: approvers.sort(),
        refused,
      };
    },
  };
}

/**
 * The review source for the CI job this runs in: GitLab CI, Forgejo Actions
 * or GitHub Actions, told apart as `./gate-resume.ts` does. The token is
 * `CHANT_FORGE_TOKEN`, else `GITHUB_TOKEN`/`GH_TOKEN` or `GITLAB_TOKEN`.
 * Throws naming what is missing.
 */
export function reviewSourceFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: ForgeFetch): ReviewSource {
  const f = fetchImpl ? { fetch: fetchImpl } : {};
  if (env.GITLAB_CI === "true") {
    const token = env.CHANT_FORGE_TOKEN ?? env.GITLAB_TOKEN;
    if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !token) {
      throw new Error("a pr-review gate on GitLab needs CI_API_V4_URL, CI_PROJECT_ID and CHANT_FORGE_TOKEN (a token with read_api)");
    }
    return gitlabReviews({ apiBase: env.CI_API_V4_URL, repo: env.CI_PROJECT_ID, token, host: env.CI_SERVER_HOST ?? hostOf(env.CI_SERVER_URL, "gitlab.com"), ...f });
  }
  const token = env.CHANT_FORGE_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!env.GITHUB_REPOSITORY || !token) {
    throw new Error("a pr-review gate needs GITHUB_REPOSITORY and a token (GITHUB_TOKEN with pull-requests: read, or CHANT_FORGE_TOKEN)");
  }
  const forgejo = env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true";
  const host = hostOf(env.GITHUB_SERVER_URL, "github.com");
  const opts = { apiBase: env.GITHUB_API_URL ?? (forgejo ? `${trimSlash(env.GITHUB_SERVER_URL ?? "")}/api/v1` : "https://api.github.com"), repo: env.GITHUB_REPOSITORY, token, host, ...f };
  return forgejo ? forgejoReviews(opts) : githubReviews(opts);
}

/**
 * The head of the pull request a CI job runs for, from its environment: the
 * event payload's `pull_request.head.sha` on GitHub and Forgejo (whose
 * checkout is a merge preview, not the head), and on GitLab the merge
 * request's source commit. Undefined outside a pull request's pipeline.
 */
export function pullRequestHeadFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.GITLAB_CI === "true") {
    if (!env.CI_MERGE_REQUEST_IID) return undefined;
    return env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || env.CI_COMMIT_SHA || undefined;
  }
  if (!env.GITHUB_EVENT_PATH) return undefined;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf-8")) as { pull_request?: { head?: { sha?: unknown } } };
    const sha = event.pull_request?.head?.sha;
    return typeof sha === "string" && sha !== "" ? sha : undefined;
  } catch {
    return undefined;
  }
}
